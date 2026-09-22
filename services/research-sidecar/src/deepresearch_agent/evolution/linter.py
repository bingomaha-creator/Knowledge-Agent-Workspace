"""Static and security gates for generated Skill candidates."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from deepresearch_agent.harness.policies import SourcePolicy

from .schema import SkillSpec


@dataclass(frozen=True)
class LintResult:
    passed: bool
    errors: list[str] = field(default_factory=list)


class SkillLinter:
    _blocked = re.compile(r"(?<![A-Za-z0-9_])(?:sk|tvly)-[A-Za-z0-9_-]{8,}|api[_ -]?key\s*[:=]|(?:忽略|绕过).{0,20}(?:系统|规则)|(?:[A-Za-z]:\\(?:Users|Windows)\\|/(?:home|etc|root)/)", re.I)

    def lint(self, spec: SkillSpec, *, content: str | None = None) -> LintResult:
        errors = []
        text = content or spec.render()
        if self._blocked.search(text):
            errors.append("包含敏感信息、绝对路径或 prompt injection")
        for mode in spec.source_modes:
            for tool in spec.allowed_tools:
                try:
                    SourcePolicy().assert_tool_allowed(mode, tool)
                except Exception:
                    errors.append(f"工具 {tool} 不允许用于来源 {mode}")
        required = {"触发条件", "输入要求", "步骤", "允许工具", "失败回退", "验证方式", "已知限制"}
        missing = [section for section in required if f"## {section}" not in text]
        if missing:
            errors.append("缺少章节: " + ", ".join(sorted(missing)))
        return LintResult(not errors, errors)
