from types import SimpleNamespace
import pytest

from deepresearch_agent.graph_cache import graph_extraction_cache_key
from deepresearch_agent.search.tool.base import BaseSearchTool
from deepresearch_agent.search.tool.deep_research_tool import search_iteration_indexes
from deepresearch_agent.search.tool.reasoning.search import QueryGenerator


class _ResponseLLM:
    model_name = "test-model"

    def invoke(self, _prompt):
        return SimpleNamespace(content="1. first hypothesis\n2. second hypothesis")


def test_one_configured_iteration_means_one_search_round():
    assert list(search_iteration_indexes(1)) == [0]
    assert list(search_iteration_indexes(2)) == [0, 1]


def test_hypothesis_generation_supports_the_existing_instance_call():
    llm = _ResponseLLM()
    generator = QueryGenerator(llm, "{original_query}", "{original_query}")

    assert generator.generate_multiple_hypotheses("question", llm) == [
        "first hypothesis",
        "second hypothesis",
    ]


def test_generated_query_lists_are_parsed_without_executing_code():
    class UnsafeLLM:
        def invoke(self, _prompt):
            return SimpleNamespace(content="[__import__('os').getcwd()]")

    generator = QueryGenerator(UnsafeLLM(), "{original_query}", "{original_query}")

    assert generator.generate_sub_queries("original") == ["original"]


def test_graph_extraction_cache_key_changes_with_schema():
    common = {
        "text": "same text",
        "system_template": "system",
        "human_template": "human",
        "llm_identity": "test-model",
    }
    first = graph_extraction_cache_key(
        **common, entity_types=["Page"], relationship_types=["contains"]
    )
    second = graph_extraction_cache_key(
        **common, entity_types=["Disease"], relationship_types=["treats"]
    )

    assert first != second


def test_search_tool_close_does_not_close_the_shared_graph():
    class SearchTool(BaseSearchTool):
        def _setup_chains(self):
            pass

        def extract_keywords(self, query):
            return {}

        def search(self, query):
            return ""

    graph = SimpleNamespace(close_calls=0)
    graph.close = lambda: setattr(graph, "close_calls", graph.close_calls + 1)
    tool = object.__new__(SearchTool)
    tool.graph = graph
    tool.driver = object()

    tool.close()

    assert graph.close_calls == 0
    assert tool.graph is None
    assert tool.driver is None


@pytest.mark.asyncio
async def test_stream_searches_pending_subquestions_before_answer_ready():
    from deepresearch_agent.search.tool.deep_research_tool import DeepResearchTool
    from deepresearch_agent.search.tool.reasoning.search import DualPathSearcher
    tool = object.__new__(DeepResearchTool)
    searched = []
    tool.max_iterations = 2
    tool._log = lambda message: None
    tool.query_generator = SimpleNamespace(generate_sub_queries=lambda query: ["first", "second", "third", "fourth", "fifth"],
        generate_followup_queries=lambda *args: [])
    tool.thinking_engine = SimpleNamespace(
        initialize_with_query=lambda query: None, update_continue_message=lambda: None,
        has_executed_query=lambda query: query in searched,
        add_executed_query=lambda query: searched.append(query), executed_search_queries=searched,
        add_reasoning_step=lambda message: None, add_ai_message=lambda message: None,
        add_human_message=lambda message: None, prepare_truncated_reasoning=lambda: "",
        remove_result_tags=lambda text: text)
    tool.dual_searcher = DualPathSearcher(lambda query: {})
    async def search(query):
        return {"chunks": [{"chunk_id": query, "text": "原文证据"}], "doc_aggs": []}
    async def extract(*args):
        return "**Final Information** 原文支持的信息"
    async def next_query():
        return {"status": "answer_ready"}
    async def progress(*args, **kwargs):
        pass
    async def answer(*args):
        return "最终回答"
    tool._async_search, tool._async_extract_info = search, extract
    tool._async_generate_next_query, tool._progress = next_query, progress
    tool._writer_evidence = lambda: "原文证据"
    tool._async_generate_final_answer = answer
    async for _ in tool.thinking_stream("multi-part question"):
        pass
    assert searched == ["first", "second", "third", "fourth", "fifth"]


@pytest.mark.parametrize('content, expected', [
    ('["a", "b", "c", "d", "e"]', ['a', 'b', 'c', 'd', 'e']),
    ('["a", "a", "  ", "b"]', ['a', 'b']),
    ('[1, "a"]', ['original']),
    ('["a", "b", "c", "d", "e", "f", "g"]', ['a', 'b', 'c', 'd', 'e', 'f']),
])
def test_query_plan_preserves_aspects_but_is_bounded_and_typed(content, expected):
    llm = SimpleNamespace(invoke=lambda prompt: SimpleNamespace(content=content))
    assert QueryGenerator(llm, '{original_query}', '').generate_sub_queries('original') == expected
