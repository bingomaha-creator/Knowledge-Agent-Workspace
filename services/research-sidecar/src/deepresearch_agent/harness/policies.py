"""Deterministic source policy enforced immediately before retrieval."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from deepresearch_agent.harness.contracts import SourceMode
from deepresearch_agent.harness.errors import AppError, ErrorCode


class SourcePolicy:
    ALLOWED_TOOLSETS = {
        SourceMode.GRAPHRAG: {"local_search", "global_search", "hybrid_search", "naive_search", "chain_exploration"},
        SourceMode.WEB: {"tavily_search", "web_search"},
    }
    WEB_ALLOWED_ARGUMENTS = {
        "query", "top_k", "search_depth", "include_domains", "exclude_domains",
        "start_date", "end_date", "topic",
    }

    def assert_tool_allowed(self, source_mode: SourceMode | str, tool_name: str) -> None:
        mode = SourceMode(source_mode)
        if tool_name not in self.ALLOWED_TOOLSETS[mode]:
            raise AppError(
                ErrorCode.SOURCE_POLICY_VIOLATION,
                f"{mode.value} Run 不允许调用工具 {tool_name}",
                details={"source_mode": mode.value, "tool_name": tool_name},
            )

    def sanitize_web_arguments(self, arguments: Mapping[str, Any]) -> dict[str, Any]:
        rejected = sorted(set(arguments) - self.WEB_ALLOWED_ARGUMENTS)
        if rejected:
            raise AppError(
                ErrorCode.SOURCE_POLICY_VIOLATION,
                "Web 检索参数包含不允许外发的字段",
                details={"rejected_fields": rejected},
            )
        return {key: value for key, value in arguments.items() if key in self.WEB_ALLOWED_ARGUMENTS}


__all__ = ["SourcePolicy"]
