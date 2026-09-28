"""Adapter around the existing GraphRAG search tools."""

from __future__ import annotations

import asyncio
from typing import Any, Mapping, Optional

from deepresearch_agent.agents.multi_agent.core.retrieval_result import RetrievalResult
from deepresearch_agent.harness.contracts import SourceMode
from deepresearch_agent.harness.policies import SourcePolicy
from deepresearch_agent.retrieval.base import SearchDepth, SearchFilters, ToolCallContext


class GraphRAGProvider:
    mode = SourceMode.GRAPHRAG
    provider_name = "graphrag"
    strategies = {"local_search", "global_search", "hybrid_search", "naive_search"}

    def __init__(
        self,
        *,
        tool_registry: Optional[Mapping[str, Any]] = None,
        policy: Optional[SourcePolicy] = None,
    ) -> None:
        self._tool_registry = dict(tool_registry) if tool_registry is not None else None
        self._tool_cache: dict[str, Any] = {}
        self._policy = policy or SourcePolicy()

    async def search(
        self,
        query: str,
        *,
        top_k: int,
        search_depth: SearchDepth,
        filters: SearchFilters,
        call_context: ToolCallContext,
    ) -> list[RetrievalResult]:
        if call_context.source_mode != self.mode:
            self._policy.assert_tool_allowed(call_context.source_mode, filters.strategy or "local_search")
        strategy = filters.strategy or "hybrid_search"
        if strategy not in self.strategies:
            raise ValueError(f"GraphRAG 不支持检索策略 {strategy}")
        self._policy.assert_tool_allowed(self.mode, strategy)
        tool = self._get_tool(strategy)
        payload = {"query": query, "top_k": top_k, **filters.extra}
        output = await asyncio.to_thread(self._invoke, tool, payload)
        results = self._parse_results(output)
        # Graph entities and communities are retrieval hints. Only original
        # document chunks may cross the provider seam as citable evidence.
        results = [
            result for result in results
            if result.metadata.source_type == "chunk" and str(result.evidence).strip()
        ]
        for result in results:
            result.source_mode = self.mode.value
            result.metadata.extra.setdefault("provider", self.provider_name)
            result.metadata.extra.setdefault("strategy", strategy)
        return results[:top_k]

    def _get_tool(self, strategy: str) -> Any:
        if self._tool_registry is None:
            from deepresearch_agent.search.tool_registry import TOOL_REGISTRY
            self._tool_registry = dict(TOOL_REGISTRY)
        if strategy not in self._tool_cache:
            factory = self._tool_registry.get(strategy)
            if factory is None:
                raise KeyError(f"未注册 GraphRAG 工具 {strategy}")
            self._tool_cache[strategy] = factory() if callable(factory) else factory
        return self._tool_cache[strategy]

    @staticmethod
    def _invoke(tool: Any, payload: dict[str, Any]) -> Any:
        if hasattr(tool, "structured_search"):
            return tool.structured_search(payload)
        if hasattr(tool, "search"):
            return tool.search(payload)
        raise TypeError("GraphRAG 工具缺少 structured_search/search")

    @staticmethod
    def _parse_results(output: Any) -> list[RetrievalResult]:
        payload = output.get("retrieval_results", []) if isinstance(output, dict) else []
        parsed: list[RetrievalResult] = []
        for item in payload if isinstance(payload, list) else []:
            parsed.append(item if isinstance(item, RetrievalResult) else RetrievalResult.from_dict(item))
        return parsed


__all__ = ["GraphRAGProvider"]
