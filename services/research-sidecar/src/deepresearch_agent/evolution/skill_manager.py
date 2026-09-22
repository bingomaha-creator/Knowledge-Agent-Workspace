"""Candidate-only skill_manage implementation with read-before-write and CAS."""

from __future__ import annotations

from .review_schema import ReviewPack, SkillProposal
from .schema import SkillSpec


class SkillWriteRejected(ValueError):
    pass


class SkillManager:
    def __init__(self, registry, repository):
        self.registry, self.repository = registry, repository

    async def view_for_review(self, *, review_id: str, name: str, version: str):
        item = await self.repository.get_version(name, version)
        if item is None:
            raise SkillWriteRejected("目标 Skill 版本不存在")
        content = self.registry.read_text(item.content_path)
        await self.repository.add_read_mark(review_id=review_id, version=item)
        return item, content

    async def apply(self, *, pack: ReviewPack, proposal: SkillProposal):
        if proposal.decision == "ignore":
            return None
        if proposal.decision == "patch":
            target = await self.repository.get_version(proposal.target_skill_id or "", proposal.base_version or "")
            if target is None:
                raise SkillWriteRejected("Patch 目标不存在")
            mark = await self.repository.get_read_mark(review_id=pack.review_id, skill_version_id=target.skill_version_id)
            if mark is None:
                raise SkillWriteRejected("Patch 前必须 skill_view（read-before-write）")
            if mark.content_hash != target.content_hash or proposal.base_content_hash != target.content_hash:
                raise SkillWriteRejected("Skill 已变化，CAS 校验失败")
            name = target.name
        else:
            name = proposal.name or ""
        spec = SkillSpec(
            name=name, version=proposal.proposed_version or "0.1.0",
            description=proposal.description or proposal.title or "从验证轨迹中提取的研究流程技能。",
            source_modes=[pack.source_mode], created_from_runs=[pack.run_id],
            triggers=proposal.triggers or [proposal.title or pack.user_goal[:80]],
            inputs=proposal.inputs or ["明确的研究目标", "Run 固定的信息源"],
            steps=proposal.rules,
            allowed_tools=[tool for tool in proposal.allowed_tools if tool != "deep_research"],
            fallback=proposal.fallback or "达到权限或预算边界时停止并报告。",
            verification=proposal.verification, limitations=proposal.limitations,
            anti_patterns=proposal.anti_patterns, stop_conditions=proposal.stop_conditions,
            machine_policy=proposal.machine_policy,
        )
        return await self.registry.register_candidate(
            run_id=pack.run_id, spec=spec,
            eval_cases=[
                {"name": "source-run", "run_id": pack.run_id, "query": pack.user_goal, "source_mode": pack.source_mode, "workflow_mode": pack.workflow_mode},
                {"name": "boundary-evidence-gap", "query": f"{pack.user_goal}\n如果证据不足，请明确停止并说明局限。", "source_mode": pack.source_mode, "workflow_mode": pack.workflow_mode},
                {"name": "regression-neighbor", "split": "holdout", "query": f"{pack.user_goal}\n请保持来源隔离并完成引用验证。", "source_mode": pack.source_mode, "workflow_mode": pack.workflow_mode},
            ],
            extra_payload={"proposal": proposal.model_dump(mode="json"), "review_id": pack.review_id},
        )
