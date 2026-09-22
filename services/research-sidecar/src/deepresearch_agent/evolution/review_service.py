"""Durable, asynchronous built-in learning loop."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from sqlalchemy import func, select

from deepresearch_agent.persistence.models import RunEventModel, RunModel, ToolCallModel

from .review_agents import SkillCriticAgent, SkillProposerAgent
from .review_pack import ReviewPackBuilder
from .review_schema import ReviewPack, SkillProposal
from .skill_manager import SkillManager
from .validators import ProposalValidators


class SkillLearningService:
    """Queues review quickly, then performs model work outside the user Run."""

    TERMINAL_RUN_STATUSES = {"completed", "failed", "budget_exhausted"}

    def __init__(self, database, review_repository, skill_repository, registry, *, proposer_llm=None,
                 critic_llm=None, events=None, enabled: bool = True, max_retries: int = 2):
        self.database = database
        self.repository = review_repository
        self.skills = skill_repository
        self.registry = registry
        self.builder = ReviewPackBuilder(database)
        self.proposer = SkillProposerAgent(proposer_llm)
        self.critic = SkillCriticAgent(critic_llm)
        self.validators = ProposalValidators()
        self.manager = SkillManager(registry, skill_repository)
        self.events = events
        self.enabled = enabled and proposer_llm is not None and critic_llm is not None
        self.max_retries = max_retries
        self._tasks: dict[str, asyncio.Task] = {}

    async def enqueue_for_run(self, run_id: str):
        if not self.enabled:
            return None
        async with self.database.sessions() as session:
            run = await session.get(RunModel, run_id)
            if run is None or run.status not in self.TERMINAL_RUN_STATUSES:
                return None
            terminal_event_id = int((await session.execute(select(func.max(RunEventModel.event_id)).where(
                RunEventModel.run_id == run_id
            ))).scalar_one_or_none() or 0)
            tool_count = int((await session.execute(select(func.count()).select_from(ToolCallModel).where(
                ToolCallModel.run_id == run_id
            ))).scalar_one())
        if run.status == "completed" and tool_count < 2:
            return None
        job = await self.repository.enqueue(run_id=run_id, terminal_event_id=terminal_event_id)
        self.schedule(job.review_id)
        if self.events:
            await self.events.publish(run_id, "learning.review.queued", stage="learning", payload={"review_id": job.review_id})
        return job

    async def distill(self, run_id: str):
        """Compatibility hook used by older HarnessRuntime integrations."""
        return await self.enqueue_for_run(run_id)

    def schedule(self, review_id: str) -> asyncio.Task:
        existing = self._tasks.get(review_id)
        if existing and not existing.done():
            return existing
        task = asyncio.create_task(self.process(review_id), name=f"learning-review:{review_id}")
        self._tasks[review_id] = task
        task.add_done_callback(lambda _task: self._tasks.pop(review_id, None))
        return task

    async def recover(self) -> list[str]:
        jobs = await self.repository.pending()
        for job in jobs:
            self.schedule(job.review_id)
        return [job.review_id for job in jobs]

    async def retry(self, review_id: str):
        job = await self.repository.get(review_id)
        if job is None:
            return None
        if job.status not in {"failed", "rejected"}:
            raise ValueError("只有 failed/rejected Review 可以显式重试")
        await self.repository.update(
            review_id, status="queued", retry_count=0, revision_count=0,
            error_message="", checkpoint={"stage": "queued", "reason": "explicit_retry"},
            reset_outputs=True,
        )
        self._tasks.pop(review_id, None)
        self.schedule(review_id)
        await self._publish(job.run_id, "learning.review.retried", {"review_id": review_id})
        return await self.repository.get(review_id)

    async def shutdown(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _publish(self, run_id: str, event_type: str, payload: dict[str, Any]):
        if self.events:
            await self.events.publish(run_id, event_type, stage="learning", payload=payload)

    async def _enrich_catalog(self, pack: ReviewPack) -> ReviewPack:
        neighbors = []
        for version, spec in await self.registry.active_specs():
            item = {"name": spec.name, "version": spec.version, "content_hash": version.content_hash,
                    "description": spec.description, "source_modes": spec.source_modes}
            neighbors.append(item)
            if any(loaded.get("name") == spec.name for loaded in pack.loaded_skills):
                await self.manager.view_for_review(review_id=pack.review_id, name=spec.name, version=spec.version)
                for loaded in pack.loaded_skills:
                    if loaded.get("name") == spec.name:
                        loaded.update({"version": spec.version, "content_hash": version.content_hash})
        pack.candidate_neighbors = neighbors[:30]
        return pack

    async def process(self, review_id: str):
        job = await self.repository.get(review_id)
        if job is None or job.status in self.repository.TERMINAL:
            return job
        try:
            await self.repository.update(review_id, status="building_pack", checkpoint={"stage": "building_pack"})
            pack = await self._enrich_catalog(await self.builder.build(review_id=review_id, run_id=job.run_id))
            await self.repository.update(review_id, status="proposing", review_pack=pack.model_dump(mode="json"), checkpoint={"stage": "proposing"})
            await self._publish(job.run_id, "learning.review.started", {"review_id": review_id})
            await self._publish(job.run_id, "learning.review_pack.built", {
                "review_id": review_id,
                "episodes": len(pack.episodes),
                "decision_cards": sum(len(episode.cards) for episode in pack.episodes),
                "trace_refs": sum(len(episode.trace_refs) for episode in pack.episodes),
                "loaded_skills": len(pack.loaded_skills),
            })
            proposal = await self.proposer.propose(pack)
            await self._publish(job.run_id, "skill.proposal.created", {
                "review_id": review_id, "decision": proposal.decision,
                "name": proposal.name or proposal.target_skill_id,
                "version": proposal.proposed_version or proposal.base_version,
                "trace_refs": len(proposal.trace_refs),
            })
            if proposal.decision == "ignore":
                await self.repository.update(review_id, status="completed", proposal=proposal.model_dump(mode="json"), error_message="", checkpoint={"stage": "ignored"})
                await self._publish(job.run_id, "learning.review.ignored", {"review_id": review_id, "rationale": proposal.rationale})
                return await self.repository.get(review_id)
            if proposal.decision == "patch":
                target, _ = await self.manager.view_for_review(
                    review_id=review_id, name=proposal.target_skill_id or "", version=proposal.base_version or "",
                )
                if proposal.base_content_hash != target.content_hash:
                    raise ValueError("Proposer 的 base_content_hash 与已读取版本不一致")
            await self.repository.update(review_id, status="criticizing", proposal=proposal.model_dump(mode="json"), checkpoint={"stage": "criticizing"})
            critic = await self.critic.review(pack, proposal)
            await self._publish(job.run_id, "skill.critic.completed", {
                "review_id": review_id, "decision": critic.decision,
                "blocking_issues": critic.blocking_issues,
                "scores": critic.scores,
            })
            revision_count = 0
            if critic.decision == "revise":
                revision_count = 1
                await self.repository.update(review_id, status="revising", critic=critic.model_dump(mode="json"), revision_count=1, checkpoint={"stage": "revising"})
                proposal = await self.proposer.propose(
                    pack,
                    revision_instructions=critic.revision_instructions,
                    previous_proposal=proposal,
                )
                await self._publish(job.run_id, "skill.proposal.revised", {
                    "review_id": review_id, "revision": 1,
                    "instructions": critic.revision_instructions,
                })
                if proposal.decision == "ignore":
                    await self.repository.update(
                        review_id, status="completed", proposal=proposal.model_dump(mode="json"),
                        critic=critic.model_dump(mode="json"), error_message="", revision_count=1,
                        checkpoint={"stage": "ignored_after_revision"},
                    )
                    await self._publish(job.run_id, "learning.review.ignored", {
                        "review_id": review_id, "rationale": proposal.rationale,
                        "after_revision": True,
                    })
                    return await self.repository.get(review_id)
                critic = await self.critic.review(pack, proposal)
                await self._publish(job.run_id, "skill.critic.completed", {
                    "review_id": review_id, "decision": critic.decision,
                    "blocking_issues": critic.blocking_issues,
                    "scores": critic.scores, "revision": 1,
                })
            if critic.decision != "pass":
                await self.repository.update(review_id, status="rejected", proposal=proposal.model_dump(mode="json"), critic=critic.model_dump(mode="json"), error_message="", revision_count=revision_count, checkpoint={"stage": "rejected"})
                await self._publish(job.run_id, "skill.critic.rejected", {"review_id": review_id, "issues": critic.blocking_issues})
                return await self.repository.get(review_id)
            validation = self.validators.validate(pack, proposal)
            await self._publish(job.run_id, "skill.validation.completed", {
                "review_id": review_id, "passed": validation.passed,
                "errors": validation.errors, "warnings": validation.warnings,
            })
            if not validation.passed:
                await self.repository.update(review_id, status="rejected", proposal=proposal.model_dump(mode="json"), critic=critic.model_dump(mode="json"), validation=validation.model_dump(mode="json"), error_message="", checkpoint={"stage": "validation_failed"})
                await self._publish(job.run_id, "skill.validation.failed", {"review_id": review_id, "errors": validation.errors})
                return await self.repository.get(review_id)
            await self.repository.update(review_id, status="writing_candidate", validation=validation.model_dump(mode="json"), checkpoint={"stage": "writing_candidate"})
            candidate = await self.manager.apply(pack=pack, proposal=proposal)
            await self.repository.update(review_id, status="completed", candidate_id=candidate.candidate_id if candidate else None, error_message="", checkpoint={"stage": "completed"})
            await self._publish(job.run_id, "skill.candidate.created", {"review_id": review_id, "candidate_id": candidate.candidate_id if candidate else None, "decision": proposal.decision})
            return await self.repository.get(review_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            latest = await self.repository.get(review_id)
            retries = int(getattr(latest, "retry_count", 0)) + 1
            terminal = retries > self.max_retries
            await self.repository.update(review_id, status="failed" if terminal else "retry_wait", error_message=f"{type(exc).__name__}: {exc}"[:2000], retry_count=retries, checkpoint={"stage": "failed" if terminal else "retry_wait"})
            await self._publish(job.run_id, "learning.review.failed", {"review_id": review_id, "retry_count": retries, "terminal": terminal, "error": type(exc).__name__})
            if not terminal:
                async def retry_later():
                    await asyncio.sleep(0)
                    self._tasks.pop(review_id, None)
                    self.schedule(review_id)
                asyncio.create_task(retry_later())
            return await self.repository.get(review_id)
