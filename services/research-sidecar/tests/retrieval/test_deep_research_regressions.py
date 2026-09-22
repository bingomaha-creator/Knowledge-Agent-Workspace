from types import SimpleNamespace

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
