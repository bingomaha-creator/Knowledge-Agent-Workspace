"""Distil reusable procedural candidates from verified complex trajectories."""

from __future__ import annotations

import hashlib
import json

from sqlalchemy import func, select

from deepresearch_agent.persistence.models import RunEventModel, ToolCallModel
from deepresearch_agent.persistence.repositories import ContractRepository, MessageRepository, RunRepository

from .registry import SkillRegistry
from .schema import SkillSpec


class TrajectoryDistiller:
    def __init__(self, database, registry: SkillRegistry, runs: RunRepository, messages: MessageRepository, contracts: ContractRepository):
        self.database, self.registry, self.runs, self.messages, self.contracts = database, registry, runs, messages, contracts

    async def distill(self, run_id: str):
        run = await self.runs.get(run_id)
        if run is None or run.status != "completed" or not await self.contracts.required_checks_passed(run_id):
            return None
        async with self.database.sessions() as session:
            tool_count = int((await session.execute(select(func.count()).select_from(ToolCallModel).where(ToolCallModel.run_id == run_id, ToolCallModel.status == "completed"))).scalar_one())
            replanned = (await session.execute(select(RunEventModel.event_id).where(RunEventModel.run_id == run_id, RunEventModel.event_type == "plan.replanning").limit(1))).scalar_one_or_none() is not None
        if tool_count < 3 and not replanned:
            return None
        trigger = await self.messages.get(run.trigger_message_id)
        if trigger is None:
            return None
        active = await self.registry.active_specs()
        selected = next(((version, spec) for version, spec in active if run.source_mode in spec.source_modes and any(term in trigger.content.lower() for term in spec.triggers)), None)
        if selected:
            _, prior = selected
            parts = [int(part) for part in prior.version.split(".")]
            name, version = prior.name, f"{parts[0]}.{parts[1]}.{parts[2] + 1}"
        else:
            digest = hashlib.sha256(trigger.content.encode("utf-8")).hexdigest()[:8]
            name, version = f"research-{run.source_mode}-{digest}", "0.1.0"
        allowed_tools = ["tavily_search"] if run.source_mode == "web" else ["local_search", "hybrid_search"]
        spec = SkillSpec(
            name=name, description=f"复用已验证的{run.source_mode}研究轨迹，完成问题拆解、同源检索、引用报告和完成验证。",
            version=version, source_modes=[run.source_mode], created_from_runs=[run_id],
            triggers=[trigger.content[:80]], inputs=["明确的研究问题", "Run 固定的信息源"],
            steps=["解析问题并形成可执行计划", "只使用 Run 允许的同源工具收集证据", "生成稳定 evidence_id 引用的报告", "运行 Completion Contract 并按类型修复"],
            allowed_tools=allowed_tools, fallback="证据不足时补充同源检索；权限或来源冲突时停止并报告。",
            verification=["source_match", "citation_integrity", "claim_support", "report_consistency"],
            limitations=["不得更改 Run.source_mode", "不得把 Memory 当作本轮证据"],
        )
        cases = [
            {"name": "positive", "query": trigger.content[:200], "expected_source": run.source_mode, "expect_contract": True},
            {"name": "boundary", "query": "证据不足时如何处理", "expected_source": run.source_mode, "expect_no_cross_source": True},
        ]
        return await self.registry.register_candidate(run_id=run_id, spec=spec, eval_cases=cases)

