"""Strict run-level provider selection without cross-source fallback."""

from __future__ import annotations

from typing import Callable, Mapping

from deepresearch_agent.harness.contracts import SourceMode
from deepresearch_agent.harness.errors import AppError, ErrorCode
from deepresearch_agent.retrieval.base import RetrievalProvider


class RetrievalRouter:
    def __init__(self, providers: Mapping[SourceMode | str, RetrievalProvider]):
        self._providers = {SourceMode(key): provider for key, provider in providers.items()}
        for mode, provider in self._providers.items():
            if provider.mode != mode:
                raise ValueError(f"Provider {provider.provider_name} 的 mode 与路由键不一致")

    def for_mode(self, source_mode: SourceMode | str) -> RetrievalProvider:
        try:
            mode = SourceMode(source_mode)
        except ValueError as exc:
            raise AppError(ErrorCode.INVALID_SOURCE_MODE, f"不支持的信息源: {source_mode}") from exc
        provider = self._providers.get(mode)
        if provider is None:
            raise AppError(
                ErrorCode.SOURCE_UNAVAILABLE,
                f"信息源 {mode.value} 未配置",
                details={"source_mode": mode.value},
            )
        return provider


class _LazyProvider:
    """Delay provider imports and external-service initialization until selected."""

    def __init__(
        self,
        *,
        mode: SourceMode,
        provider_name: str,
        factory: Callable[[], RetrievalProvider],
    ) -> None:
        self.mode = mode
        self.provider_name = provider_name
        self._factory = factory
        self._instance: RetrievalProvider | None = None

    def _get(self) -> RetrievalProvider:
        if self._instance is None:
            self._instance = self._factory()
        return self._instance

    async def search(self, *args, **kwargs):
        return await self._get().search(*args, **kwargs)


__all__ = ["RetrievalRouter"]


def create_default_router() -> RetrievalRouter:
    """Build lazy GraphRAG and configured Tavily providers for real entry points."""
    from deepresearch_agent.config.settings import (
        ARTIFACT_ROOT,
        TAVILY_API_KEY,
        TAVILY_CACHE_TTL_SECONDS,
        TAVILY_MAX_RESULTS,
        TAVILY_SEARCH_DEPTH,
        TAVILY_TIMEOUT_SECONDS,
    )
    def build_graphrag() -> RetrievalProvider:
        from deepresearch_agent.retrieval.graphrag_provider import GraphRAGProvider
        return GraphRAGProvider()

    providers: dict[SourceMode, RetrievalProvider] = {
        SourceMode.GRAPHRAG: _LazyProvider(
            mode=SourceMode.GRAPHRAG,
            provider_name="graphrag",
            factory=build_graphrag,
        )
    }
    if TAVILY_API_KEY:
        def build_tavily() -> RetrievalProvider:
            from deepresearch_agent.persistence.artifact_store import ArtifactStore
            from deepresearch_agent.retrieval.tavily_provider import TavilyProvider
            return TavilyProvider(
                api_key=TAVILY_API_KEY,
                artifact_store=ArtifactStore(ARTIFACT_ROOT),
                default_depth=TAVILY_SEARCH_DEPTH,  # type: ignore[arg-type]
                default_max_results=TAVILY_MAX_RESULTS,
                timeout_seconds=TAVILY_TIMEOUT_SECONDS,
                cache_ttl_seconds=TAVILY_CACHE_TTL_SECONDS,
            )
        providers[SourceMode.WEB] = _LazyProvider(
            mode=SourceMode.WEB,
            provider_name="tavily",
            factory=build_tavily,
        )
    return RetrievalRouter(providers)


__all__.append("create_default_router")
