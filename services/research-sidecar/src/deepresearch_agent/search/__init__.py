"""Search package with lazy public exports.

Keeping imports lazy lets a Web-only process start without initializing Neo4j.
"""

from importlib import import_module


_EXPORTS = {
    "LocalSearch": ("deepresearch_agent.search.local_search", "LocalSearch"),
    "GlobalSearch": ("deepresearch_agent.search.global_search", "GlobalSearch"),
    "LocalSearchTool": ("deepresearch_agent.search.tool.local_search_tool", "LocalSearchTool"),
    "GlobalSearchTool": ("deepresearch_agent.search.tool.global_search_tool", "GlobalSearchTool"),
    "HybridSearchTool": ("deepresearch_agent.search.tool.hybrid_tool", "HybridSearchTool"),
    "NaiveSearchTool": ("deepresearch_agent.search.tool.naive_search_tool", "NaiveSearchTool"),
    "DeepResearchTool": ("deepresearch_agent.search.tool.deep_research_tool", "DeepResearchTool"),
}

__all__ = list(_EXPORTS)


def __getattr__(name: str):
    target = _EXPORTS.get(name)
    if target is None:
        raise AttributeError(name)
    module_name, attribute = target
    value = getattr(import_module(module_name), attribute)
    globals()[name] = value
    return value
