"""Human-gated activation and reversible Skill version pointers."""

from __future__ import annotations

import json

from deepresearch_agent.persistence.repositories import AuditRepository, SkillRepository

from .registry import SkillRegistry


class PromotionRejected(ValueError):
    pass


class PromotionPolicy:
    def __init__(self, repository: SkillRepository, registry: SkillRegistry, audit: AuditRepository, *, require_real_replay: bool = False, staged: bool = False, canary_percent: int = 5):
        self.repository, self.registry, self.audit = repository, registry, audit
        self.require_real_replay, self.staged = require_real_replay, staged
        self.canary_percent = max(1, min(50, canary_percent))

    async def promote(self, *, name: str, version: str, human_approved: bool, candidate_id: str | None = None):
        if not human_approved:
            raise PromotionRejected("必须由用户明确批准 Promote")
        candidate = (
            await self.repository.get_candidate(candidate_id)
            if candidate_id else await self.repository.find_candidate(name, version)
        )
        target = await self.repository.get_version(name, version)
        if candidate is None or target is None:
            raise PromotionRejected("候选版本不存在")
        if candidate.name != name or candidate.proposed_version != version:
            raise PromotionRejected("候选与目标版本不匹配")
        evaluation = await self.repository.latest_eval(candidate.candidate_id)
        if evaluation is None or evaluation.status != "passed":
            raise PromotionRejected("候选尚未通过离线评测")
        metrics = json.loads(evaluation.metrics_json or "{}")
        if self.require_real_replay and metrics.get("real_replay") is not True:
            raise PromotionRejected("候选尚未通过真实 Control/Treatment 回放")
        if self.require_real_replay and len(metrics.get("pairs") or []) < 3:
            raise PromotionRejected("真实回放样本少于 3 组，不满足晋级门禁")
        if metrics.get("semantic_regressions", 0) or metrics.get("holdout_passed", True) is not True:
            raise PromotionRejected("Semantic Judge 或 Hidden Holdout 检测到回归")
        if not (metrics.get("citation_integrity") == 1.0 and metrics.get("tool_policy_violations") == 0 and metrics.get("source_leakage") == 0 and metrics.get("safety_passed") is True and metrics.get("contract_pass_rate", 0) >= metrics.get("active_contract_pass_rate", 1)):
            raise PromotionRejected("候选未通过硬门禁")
        if self.staged:
            digest = self.registry.rewrite_status(target.content_path, "shadow")
            await self.repository.update_version_hash(name, version, digest)
            target = await self.repository.get_version(name, version)
            await self.repository.transition_deployment(version=target, stage="shadow", allocation_percent=0)
            await self.audit.append(action="skill.shadow_started", entity_type="skill", entity_id=f"{name}:{version}", payload={"candidate_id": candidate.candidate_id, "eval_run_id": evaluation.eval_run_id})
            return await self.repository.get_version(name, version)
        for previous in await self.repository.list_versions(name=name, status="active"):
            previous_hash = self.registry.rewrite_status(previous.content_path, "previous")
            await self.repository.update_version_hash(name, previous.version, previous_hash)
        digest = self.registry.rewrite_status(target.content_path, "active")
        if not await self.repository.promote(candidate_id=candidate.candidate_id, name=name, version=version, content_hash=digest):
            raise PromotionRejected("候选状态不允许 Promote")
        await self.audit.append(action="skill.promoted", entity_type="skill", entity_id=f"{name}:{version}", payload={"candidate_id": candidate.candidate_id, "eval_run_id": evaluation.eval_run_id})
        return await self.repository.get_version(name, version)

    async def advance(self, *, name: str, version: str, target_stage: str, human_approved: bool):
        if not human_approved:
            raise PromotionRejected("必须由用户明确批准部署阶段变更")
        item = await self.repository.get_version(name, version)
        candidate = await self.repository.find_candidate(name, version)
        if item is None or candidate is None:
            raise PromotionRejected("候选版本不存在")
        if item.status == "shadow" and target_stage == "canary":
            digest = self.registry.rewrite_status(item.content_path, "canary")
            await self.repository.update_version_hash(name, version, digest)
            item = await self.repository.get_version(name, version)
            await self.repository.transition_deployment(version=item, stage="canary", allocation_percent=self.canary_percent)
            await self.audit.append(action="skill.canary_started", entity_type="skill", entity_id=f"{name}:{version}", payload={"allocation_percent": self.canary_percent})
            return await self.repository.get_version(name, version)
        if item.status == "canary" and target_stage == "active":
            digest = self.registry.rewrite_status(item.content_path, "active")
            if not await self.repository.activate_staged(candidate_id=candidate.candidate_id, version=item, content_hash=digest):
                raise PromotionRejected("Canary 激活状态冲突")
            await self.repository.transition_deployment(version=await self.repository.get_version(name, version), stage="active", allocation_percent=100)
            await self.audit.append(action="skill.activated", entity_type="skill", entity_id=f"{name}:{version}", payload={})
            return await self.repository.get_version(name, version)
        raise PromotionRejected(f"不允许从 {item.status} 进入 {target_stage}")

    async def suspend(self, *, name: str, version: str, reason: str):
        item = await self.repository.get_version(name, version)
        if item is None or item.status not in {"shadow", "canary", "active"}:
            raise PromotionRejected("当前版本不可暂停")
        digest = self.registry.rewrite_status(item.content_path, "suspended")
        await self.repository.update_version_hash(name, version, digest)
        item = await self.repository.get_version(name, version)
        await self.repository.transition_deployment(version=item, stage="suspended", allocation_percent=0)
        await self.audit.append(action="skill.suspended", entity_type="skill", entity_id=f"{name}:{version}", payload={"reason": reason})
        return await self.repository.get_version(name, version)

    async def observe_run(self, *, name: str, version: str, succeeded: bool, safety_violation: bool = False):
        item = await self.repository.get_version(name, version)
        if item is None or item.status != "canary":
            return None
        metrics = await self.repository.record_deployment_outcome(
            item.skill_version_id, succeeded=succeeded, safety_violation=safety_violation,
        )
        should_suspend = bool(metrics.get("safety_violations")) or (
            int(metrics.get("runs", 0)) >= 3 and float(metrics.get("failure_rate", 0)) > 0.34
        )
        if should_suspend:
            return await self.suspend(name=name, version=version, reason="Canary 自动熔断：安全违规或失败率超阈值")
        return item

    async def rollback(self, name: str):
        active = (await self.repository.list_versions(name=name, status="active"))
        previous = (await self.repository.list_versions(name=name, status="previous"))
        if not active or not previous:
            raise PromotionRejected("没有可回滚的 previous 版本")
        current, target = active[0], previous[0]
        current_hash = self.registry.rewrite_status(current.content_path, "candidate")
        target_hash = self.registry.rewrite_status(target.content_path, "active")
        if not await self.repository.rollback(name, active_hash=current_hash, previous_version=target.version, previous_hash=target_hash):
            raise PromotionRejected("回滚状态冲突")
        await self.audit.append(action="skill.rolled_back", entity_type="skill", entity_id=name, payload={"from": current.version, "to": target.version})
        return await self.repository.get_version(name, target.version)
