import asyncio
import json
from pathlib import Path

import pytest

from deepresearch_agent.agents.multi_agent.core.plan_spec import PlanExecutionSignal, TaskNode
from deepresearch_agent.agents.multi_agent.core.retrieval_result import RetrievalMetadata, RetrievalResult
from deepresearch_agent.agents.multi_agent.core.state import PlanExecuteState
from deepresearch_agent.agents.multi_agent.executor.retrieval_executor import RetrievalExecutor
from deepresearch_agent.harness.contracts import SourceMode
from deepresearch_agent.harness.errors import AppError, ErrorCode
from deepresearch_agent.harness.policies import SourcePolicy
from deepresearch_agent.retrieval.base import SearchFilters, TimeoutBoundProvider, ToolCallContext
from deepresearch_agent.retrieval.graphrag_provider import GraphRAGProvider
from deepresearch_agent.retrieval.router import RetrievalRouter
from deepresearch_agent.retrieval.tavily_provider import TavilyProvider
from deepresearch_agent.search.tool.deep_research_tool import DeepResearchTool
from deepresearch_agent.agents.multi_agent.planner.task_decomposer import TaskDecomposer
from deepresearch_agent.agents.multi_agent.reporter.formatter import CitationFormatter


class FakeProvider:
    def __init__(self, mode: SourceMode):
        self.mode = mode
        self.provider_name = "fake_graph" if mode == SourceMode.GRAPHRAG else "fake_web"
        self.calls = []

    async def search(self, query, *, top_k, search_depth, filters, call_context):
        self.calls.append((query, filters.strategy, call_context))
        source = "local_search" if self.mode == SourceMode.GRAPHRAG else "tavily_search"
        source_type = "chunk" if self.mode == SourceMode.GRAPHRAG else "webpage"
        return [RetrievalResult(
            granularity="Chunk" if self.mode == SourceMode.GRAPHRAG else "DO",
            evidence=f"evidence:{query}",
            source=source,
            source_mode=self.mode.value,
            score=0.9,
            metadata=RetrievalMetadata(
                source_id=f"{self.mode.value}-1",
                source_type=source_type,
                confidence=0.9,
                url="https://example.com/a" if self.mode == SourceMode.WEB else None,
            ),
        )]


def _context(mode: SourceMode) -> ToolCallContext:
    return ToolCallContext(run_id="run_test", task_id="task_1", tool_call_id="call_1", source_mode=mode)


def test_graph_relevance_rejects_broad_disease_overlap() -> None:
    def result(text: str) -> RetrievalResult:
        return RetrievalResult(
            granularity="Chunk", evidence=text, source="hybrid_search", source_mode="graphrag", score=0.8,
            metadata=RetrievalMetadata(source_id=text[:8], source_type="chunk"),
        )

    query = "概括急性缺血性脑血管病的药物治疗原则"
    specific = result("阿司匹林常用于预防缺血性脑血管病。")
    broad = result("药物治疗是急性脑血管病的主要治疗手段。")
    assert GraphRAGProvider._filter_relevant(query, [specific, broad]) == [specific]


@pytest.mark.asyncio
async def test_run_timeout_wrapper_preserves_source_and_returns_typed_timeout(monkeypatch):
    provider = FakeProvider(SourceMode.WEB)
    bounded = TimeoutBoundProvider(provider, timeout_seconds=7)
    observed = {}

    async def force_timeout(awaitable, timeout):
        observed["timeout"] = timeout
        awaitable.close()
        raise TimeoutError("forced")

    monkeypatch.setattr(asyncio, "wait_for", force_timeout)
    with pytest.raises(AppError) as caught:
        await bounded.search(
            "query", top_k=3, search_depth="basic",
            filters=SearchFilters(), call_context=_context(SourceMode.WEB),
        )
    assert observed["timeout"] == 7
    assert bounded.mode is SourceMode.WEB
    assert caught.value.code is ErrorCode.RETRIEVAL_TIMEOUT
    assert caught.value.retryable is True


def test_router_strict_modes_and_missing_provider():
    graph = FakeProvider(SourceMode.GRAPHRAG)
    web = FakeProvider(SourceMode.WEB)
    router = RetrievalRouter({SourceMode.GRAPHRAG: graph, SourceMode.WEB: web})
    assert router.for_mode("graphrag") is graph
    assert router.for_mode(SourceMode.WEB) is web
    with pytest.raises(AppError) as invalid:
        router.for_mode("mixed")
    assert invalid.value.code == ErrorCode.INVALID_SOURCE_MODE
    with pytest.raises(AppError) as unavailable:
        RetrievalRouter({SourceMode.GRAPHRAG: graph}).for_mode("web")
    assert unavailable.value.code == ErrorCode.SOURCE_UNAVAILABLE


def test_source_policy_rejects_both_cross_source_directions_and_private_fields():
    policy = SourcePolicy()
    with pytest.raises(AppError):
        policy.assert_tool_allowed(SourceMode.GRAPHRAG, "tavily_search")
    with pytest.raises(AppError):
        policy.assert_tool_allowed(SourceMode.WEB, "local_search")
    with pytest.raises(AppError) as private:
        policy.sanitize_web_arguments({"query": "safe", "graphrag_context": "private"})
    assert private.value.details["rejected_fields"] == ["graphrag_context"]


def test_planner_task_graph_normalizes_llm_cross_source_output():
    decomposer = object.__new__(TaskDecomposer)
    web_graph = decomposer._build_task_graph({"nodes": [{
        "task_id": "task_1", "task_type": "local_search", "description": "q"
    }]}, source_mode="web")
    assert web_graph.nodes[0].task_type == "web_search"
    assert web_graph.nodes[0].source_mode == "web"
    graph_graph = decomposer._build_task_graph({"nodes": [{
        "task_id": "task_2", "task_type": "web_search", "description": "q"
    }]}, source_mode="graphrag")
    assert graph_graph.nodes[0].task_type == "hybrid_search"
    assert graph_graph.nodes[0].source_mode == "graphrag"


@pytest.mark.asyncio
async def test_graphrag_provider_maps_existing_structured_results():
    class Tool:
        def structured_search(self, payload):
            return {"retrieval_results": [{
                "result_id": "entity-1",
                "granularity": "AtomicKnowledge",
                "evidence": "query model-generated entity summary",
                "metadata": {"source_id": "entity-1", "source_type": "entity", "confidence": 0.9},
                "source": "hybrid_search",
                "score": 0.9,
            }, {
                "result_id": "result-1",
                "granularity": "Chunk",
                "evidence": "query original document passage",
                "metadata": {
                    "source_id": "chunk-1",
                    "source_type": "chunk",
                    "confidence": 0.8,
                    "title": "architecture.md",
                    "extra": {"document_id": "architecture.md", "position": 3},
                },
                "source": "local_search",
                "score": 0.8,
            }]}

    provider = GraphRAGProvider(tool_registry={"local_search": Tool})
    results = await provider.search(
        "query", top_k=3, search_depth="basic", filters=SearchFilters(strategy="local_search"),
        call_context=_context(SourceMode.GRAPHRAG),
    )
    assert [(r.source_mode, r.metadata.source_id) for r in results] == [("graphrag", "chunk-1")]
    assert results[0].metadata.extra == {"document_id": "architecture.md", "position": 3, "provider": "graphrag", "strategy": "local_search", "query_subject_matches": ["query"]}


@pytest.mark.asyncio
async def test_tavily_200_maps_normalizes_deduplicates_and_hides_key(tmp_path: Path):
    class Client:
        def search(self, **kwargs):
            return {"results": [
                {"title": "A", "url": "HTTPS://Example.COM/a/?utm_source=x", "content": " same  body ", "score": 0.7},
                {"title": "A2", "url": "https://example.com/a", "raw_content": "same body", "score": 0.9},
            ]}

    secret = "tvly-test-secret"
    provider = TavilyProvider(api_key=secret, client=Client(), cache_dir=tmp_path)
    results = await provider.search(
        "query", top_k=5, search_depth="advanced", filters=SearchFilters(),
        call_context=_context(SourceMode.WEB),
    )
    assert len(results) == 1
    assert results[0].metadata.url == "https://example.com/a"
    assert results[0].metadata.domain == "example.com"
    assert results[0].metadata.extra["untrusted_external_content"] is True
    assert secret not in json.dumps([item.to_dict() for item in results], default=str)


@pytest.mark.asyncio
async def test_tavily_redacts_external_token_shaped_content_and_sensitive_url_params(tmp_path: Path):
    class Client:
        def search(self, **kwargs):
            return {"results": [{"title": "secret sample", "url": "https://example.com/a?api_key=TAVILY_TEST_PLACEHOLDER&utm_source=x", "content": "Example TAVILY_TEST_PLACEHOLDER and Bearer abcdefghijklmnop", "score": 0.8}]}

    provider = TavilyProvider(api_key="backend-only", client=Client(), cache_dir=tmp_path)
    results = await provider.search("query", top_k=1, search_depth="basic", filters=SearchFilters(), call_context=_context(SourceMode.WEB))
    serialized = json.dumps([item.to_dict() for item in results], ensure_ascii=False, default=str)
    cache_text = "".join(path.read_text(encoding="utf-8") for path in tmp_path.glob("*.json"))
    assert "tvly-body" not in serialized + cache_text
    assert "Bearer abc" not in serialized + cache_text
    assert results[0].metadata.url == "https://example.com/a"


@pytest.mark.asyncio
async def test_tavily_auth_fails_without_retry(tmp_path: Path):
    class Unauthorized(Exception):
        status_code = 401

    class Client:
        calls = 0
        def search(self, **kwargs):
            self.calls += 1
            raise Unauthorized()

    client = Client()
    provider = TavilyProvider(api_key="secret", client=client, cache_dir=tmp_path)
    with pytest.raises(AppError) as caught:
        await provider.search("q", top_k=1, search_depth="basic", filters=SearchFilters(), call_context=_context(SourceMode.WEB))
    assert caught.value.code == ErrorCode.TAVILY_AUTH_FAILED
    assert client.calls == 1


@pytest.mark.asyncio
async def test_tavily_429_respects_retry_after_then_succeeds(tmp_path: Path, monkeypatch):
    class Response:
        status_code = 429
        headers = {"Retry-After": "0.01"}
    class RateLimited(Exception):
        response = Response()
    class Client:
        calls = 0
        def search(self, **kwargs):
            self.calls += 1
            if self.calls < 3:
                raise RateLimited()
            return {"results": []}

    delays = []
    async def fake_sleep(delay):
        delays.append(delay)
    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    client = Client()
    provider = TavilyProvider(api_key="secret", client=client, cache_dir=tmp_path)
    assert await provider.search("q", top_k=1, search_depth="basic", filters=SearchFilters(), call_context=_context(SourceMode.WEB)) == []
    assert client.calls == 3
    assert delays == [0.01, 0.01]


@pytest.mark.asyncio
async def test_tavily_timeout_is_bounded(tmp_path: Path, monkeypatch):
    class Timeout(Exception):
        pass
    class Client:
        calls = 0
        def search(self, **kwargs):
            self.calls += 1
            raise Timeout()
    async def fake_sleep(_delay):
        return None
    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    client = Client()
    provider = TavilyProvider(api_key="secret", client=client, cache_dir=tmp_path)
    with pytest.raises(AppError) as caught:
        await provider.search("q", top_k=1, search_depth="basic", filters=SearchFilters(), call_context=_context(SourceMode.WEB))
    assert caught.value.code == ErrorCode.RETRIEVAL_TIMEOUT
    assert client.calls == 3


@pytest.mark.parametrize("mode", [SourceMode.GRAPHRAG, SourceMode.WEB])
def test_per_provider_injection_preserves_source_trace(mode):
    provider = FakeProvider(mode)
    task_type = "local_search" if mode == SourceMode.GRAPHRAG else "web_search"
    task = TaskNode(task_id="task_1", task_type=task_type, source_mode=mode.value, description="research q")
    state = PlanExecuteState(input="research q", source_mode=mode.value)
    signal = PlanExecutionSignal(
        plan_id="plan_1", version=1, source_mode=mode.value, execution_mode="sequential",
        tasks=[task.model_dump()], execution_sequence=[task.task_id], assumptions=[], acceptance_criteria={},
    )
    result = RetrievalExecutor(provider=provider).execute_task(task, state, signal)
    assert result.success
    assert result.record.tool_calls[0].source_mode == mode.value
    assert result.record.evidence[0].source_mode == mode.value
    assert result.record.evidence[0].result_id.startswith("ev_")
    assert result.record.evidence[0].metadata.extra["tool_call_id"] == result.record.tool_calls[0].tool_call_id
    assert len(provider.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", [SourceMode.GRAPHRAG, SourceMode.WEB])
async def test_deep_research_loop_uses_injected_provider(mode):
    provider = FakeProvider(mode)
    tool = object.__new__(DeepResearchTool)
    tool.retrieval_provider = provider
    tool.run_id = "run_deep"
    tool.provider_results = []
    legacy = await tool._async_search("iterative query")
    assert legacy["chunks"][0]["source_mode"] == mode.value
    assert legacy["chunks"][0]["chunk_id"].startswith("ev_")
    assert len(provider.calls) == 1


def test_writer_receives_original_passages_with_provenance_only():
    result = RetrievalResult(
        result_id="ev_source",
        granularity="Chunk",
        evidence="Service 不得依赖 React。",
        source="hybrid_search",
        source_mode="graphrag",
        score=0.9,
        metadata=RetrievalMetadata(
            source_id="chunk-1",
            source_type="chunk",
            title="react-frontend.md",
            extra={"document_id": "react-frontend.md", "position": 4},
        ),
    )
    tool = object.__new__(DeepResearchTool)
    tool.provider_results = [result, result]
    tool.all_retrieved_info = ["model-generated summary must not win"]

    rendered = tool._writer_evidence()

    assert rendered.count("[ev_source]") == 1
    assert "来源文件：react-frontend.md，片段 4" in rendered
    assert "原文：Service 不得依赖 React。" in rendered
    assert "model-generated summary" not in rendered


def test_final_writer_prompt_excludes_reasoning_and_forbids_external_facts():
    class LLM:
        prompt = ""

        def invoke(self, prompt):
            self.prompt = prompt
            return type("Message", (), {"content": "有依据的回答 [ev_source]"})()

    tool = object.__new__(DeepResearchTool)
    tool.llm = LLM()
    answer = tool._generate_final_answer(
        "为什么？",
        "[ev_source]\n来源文件：architecture.md\n原文：直接证据",
        "hidden unsupported reasoning",
    )

    assert "hidden unsupported reasoning" not in tool.llm.prompt
    assert "禁止使用模型记忆" in tool.llm.prompt
    assert "直接证据" in tool.llm.prompt
    assert "[ev_source]" in answer


def test_web_deep_research_disables_vector_cache_initialization(monkeypatch):
    calls = []

    def fail_if_initialized():
        calls.append("embedding")
        raise AssertionError("Web DeepResearch 不应初始化向量缓存 embedding")

    monkeypatch.setattr(
        "deepresearch_agent.cache_manager.manager.get_cache_embedding_provider",
        fail_if_initialized,
    )
    from deepresearch_agent.agents.deep_research_agent import DeepResearchAgent

    agent = DeepResearchAgent(
        use_deeper_tool=True,
        retrieval_provider=FakeProvider(SourceMode.WEB),
        run_id="run_web_no_vector_cache",
    )
    assert calls == []
    assert agent.cache_manager.enable_vector_similarity is False
    assert agent.global_cache_manager.enable_vector_similarity is False
    assert agent.research_tool.cache_manager.enable_vector_similarity is False
    agent.close()


def test_report_references_include_deterministic_source_label():
    class Message:
        content = "formatted references"
    class LLM:
        def invoke(self, _prompt):
            return Message()
    web_result = asyncio.run(FakeProvider(SourceMode.WEB).search(
        "q", top_k=1, search_depth="basic", filters=SearchFilters(),
        call_context=_context(SourceMode.WEB),
    ))[0]
    rendered = CitationFormatter(llm=LLM()).format_references([web_result])
    assert "[Web]" in rendered
    assert web_result.result_id in rendered
