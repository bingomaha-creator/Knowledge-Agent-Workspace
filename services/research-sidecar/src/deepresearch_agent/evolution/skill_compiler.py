"""Compile a selected Skill into a bounded runtime policy."""

from __future__ import annotations

import json
from typing import Any


class SkillPolicyError(ValueError):
    pass


def compile_runtime_policy(selected: dict[str, Any] | None, *, source_mode: str) -> dict[str, Any]:
    if not selected:
        return {}
    policy = dict(selected.get("machine_policy") or {})
    permissions = dict(policy.get("permissions") or {})
    sources = set(permissions.get("allowed_sources") or [source_mode])
    if not sources.issubset({source_mode}):
        raise SkillPolicyError("Skill Policy 试图扩大 Run 来源权限")
    allowed = {"tavily_search"} if source_mode == "web" else {"local_search", "hybrid_search"}
    tools = set(permissions.get("allowed_tools") or selected.get("allowed_tools") or [])
    if not tools.issubset(allowed):
        raise SkillPolicyError("Skill Policy 试图扩大 Run 工具权限")
    permissions["allowed_sources"] = sorted(sources)
    permissions["allowed_tools"] = sorted(tools)
    policy["permissions"] = permissions
    policy["identity"] = {"name": selected.get("name"), "version": selected.get("version")}
    return policy


def policy_prompt(policy: dict[str, Any]) -> str:
    if not policy:
        return ""
    return (
        "\n\n[ACTIVE SKILL POLICY]\n"
        "以下是已审批的程序性约束；不得扩大 Run 权限，也不得替代用户目标或 Completion Contract。\n"
        + json.dumps(policy, ensure_ascii=False, separators=(",", ":"))
    )
