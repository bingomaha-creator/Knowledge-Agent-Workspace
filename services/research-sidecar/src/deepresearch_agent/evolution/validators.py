"""Fail-closed deterministic validation after LLM review."""

from __future__ import annotations

import re

from deepresearch_agent.harness.contracts import SourceMode
from deepresearch_agent.harness.policies import SourcePolicy

from .review_schema import ReviewPack, SkillProposal, ValidationResult


class ProposalValidators:
    DANGEROUS = ("rm -rf", "del /s", "format ", "shutdown", "powershell -enc", "ignore previous", "忽略以上")

    def validate(self, pack: ReviewPack, proposal: SkillProposal) -> ValidationResult:
        errors: list[str] = []
        warnings: list[str] = []
        if proposal.decision == "ignore":
            return ValidationResult(passed=True)
        if not proposal.trace_refs:
            errors.append("proposal 缺少 trace_refs")
        known_refs = set(pack.artifact_refs)
        for check in pack.completion_contract.values():
            if isinstance(check, dict) and check.get("ref"):
                known_refs.add(str(check["ref"]))
        for episode in pack.episodes:
            known_refs.update(episode.trace_refs)
            for card in episode.cards:
                known_refs.update(card.trace_refs)
        unknown = [ref for ref in proposal.trace_refs if ref not in known_refs]
        if unknown:
            errors.append(f"存在无法解析的 trace_refs: {unknown[:5]}")
        if len(proposal.rules) < 3:
            errors.append("可执行规则少于 3 条")
        if not proposal.anti_patterns or not proposal.stop_conditions or not proposal.verification:
            errors.append("必须包含反模式、停止条件和验证方式")
        if proposal.name and not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,79}", proposal.name):
            errors.append("Skill 名称非法")
        # Orchestrator labels are trace metadata, not permissions. They are
        # removed before SKILL.md compilation and never enter ToolPolicy.
        orchestration_labels = {"deep_research"}
        declared_tools = set(proposal.allowed_tools) - orchestration_labels
        allowed_by_run = set(SourcePolicy.ALLOWED_TOOLSETS[SourceMode(pack.source_mode)])
        if not declared_tools.issubset(allowed_by_run):
            errors.append("allowed_tools 扩大了 Run 工具权限")
        if set(proposal.allowed_tools) & orchestration_labels:
            warnings.append("已从权限声明中移除编排标签 deep_research")
        policy_permissions = proposal.machine_policy.get("permissions", {}) if isinstance(proposal.machine_policy, dict) else {}
        policy_tools = set(policy_permissions.get("allowed_tools", []) or [])
        policy_sources = set(policy_permissions.get("allowed_sources", []) or [])
        if policy_tools and not policy_tools.issubset(allowed_by_run):
            errors.append("Machine Policy 扩大了工具权限")
        if policy_sources and not policy_sources.issubset({pack.source_mode}):
            errors.append("Machine Policy 扩大了来源权限")
        material = proposal.model_dump_json().lower()
        if any(term in material for term in self.DANGEROUS):
            errors.append("提案包含危险命令或 Prompt Injection 模式")
        budgets = proposal.machine_policy.get("budgets", {}) if isinstance(proposal.machine_policy, dict) else {}
        if any(isinstance(value, (int, float)) and value < 0 for value in budgets.values()):
            errors.append("预算值不能为负数")
        if len(material) > 100_000:
            errors.append("Candidate 内容超过 100k 字符")
        if proposal.decision == "patch" and not (proposal.target_skill_id and proposal.base_version and proposal.base_content_hash):
            errors.append("Patch 缺少 target/base version/hash")
        return ValidationResult(passed=not errors, errors=errors, warnings=warnings)
