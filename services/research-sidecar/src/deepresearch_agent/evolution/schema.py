"""Versioned Markdown Skill schema."""

from __future__ import annotations

import re
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, field_validator


class SkillSpec(BaseModel):
    name: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,79}$")
    description: str = Field(min_length=10, max_length=500)
    version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    status: Literal["candidate", "evaluated", "shadow", "canary", "active", "previous", "suspended", "deprecated"] = "candidate"
    source_modes: list[Literal["graphrag", "web"]]
    created_from_runs: list[str]
    triggers: list[str] = Field(min_length=1)
    inputs: list[str] = Field(min_length=1)
    steps: list[str] = Field(min_length=3)
    allowed_tools: list[str] = Field(min_length=1)
    fallback: str = Field(min_length=5)
    verification: list[str] = Field(min_length=1)
    limitations: list[str] = Field(default_factory=list)
    anti_patterns: list[str] = Field(default_factory=list)
    stop_conditions: list[str] = Field(default_factory=list)
    machine_policy: dict[str, Any] = Field(default_factory=dict)

    @field_validator("source_modes")
    @classmethod
    def unique_modes(cls, value):
        if not value:
            raise ValueError("source_modes 不能为空")
        return list(dict.fromkeys(value))

    def render(self) -> str:
        frontmatter = {
            "name": self.name, "description": self.description, "version": self.version,
            "status": self.status, "source_modes": self.source_modes,
            "created_from_runs": self.created_from_runs,
        }
        sections = [
            ("触发条件", self.triggers), ("输入要求", self.inputs), ("步骤", self.steps),
            ("允许工具", self.allowed_tools), ("失败回退", [self.fallback]),
            ("反模式", self.anti_patterns or ["不得重复执行无新增证据的调用。"]),
            ("停止与降级条件", self.stop_conditions or ["达到 Run 预算或权限边界时停止并报告。"]),
            ("验证方式", self.verification), ("已知限制", self.limitations or ["仅在 Run 来源和 ToolPolicy 允许范围内使用。"]),
        ]
        body = "\n\n".join(f"## {title}\n\n" + "\n".join(f"{index}. {item}" for index, item in enumerate(items, 1)) for title, items in sections)
        policy = yaml.safe_dump(self.machine_policy, allow_unicode=True, sort_keys=False).strip() if self.machine_policy else "{}"
        return f"---\n{yaml.safe_dump(frontmatter, allow_unicode=True, sort_keys=False).strip()}\n---\n\n{body}\n\n## Machine Policy\n\n```yaml\n{policy}\n```\n"

    @classmethod
    def parse(cls, text: str) -> "SkillSpec":
        match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", text, re.S)
        if not match:
            raise ValueError("SKILL.md 缺少 YAML frontmatter")
        meta = yaml.safe_load(match.group(1)) or {}
        body = match.group(2)
        headings = list(re.finditer(r"^##\s+(.+?)\s*$", body, re.M))
        parsed: dict[str, list[str]] = {}
        for index, heading in enumerate(headings):
            segment = body[heading.end():headings[index + 1].start() if index + 1 < len(headings) else len(body)]
            parsed[heading.group(1)] = [re.sub(r"^\s*(?:\d+\.|[-*])\s*", "", line).strip() for line in segment.splitlines() if re.match(r"^\s*(?:\d+\.|[-*])\s+", line)]
        policy_match = re.search(r"^## Machine Policy\s*\n+```ya?ml\s*\n(.*?)\n```", body, re.M | re.S)
        machine_policy = yaml.safe_load(policy_match.group(1)) if policy_match else {}
        return cls(
            **meta, triggers=parsed.get("触发条件", []), inputs=parsed.get("输入要求", []),
            steps=parsed.get("步骤", []), allowed_tools=parsed.get("允许工具", []),
            fallback=(parsed.get("失败回退") or [""])[0], verification=parsed.get("验证方式", []),
            limitations=parsed.get("已知限制", []),
            anti_patterns=parsed.get("反模式", []), stop_conditions=parsed.get("停止与降级条件", []),
            machine_policy=machine_policy or {},
        )
