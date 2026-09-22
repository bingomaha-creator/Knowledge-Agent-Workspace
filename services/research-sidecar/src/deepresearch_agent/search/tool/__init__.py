"""Search tool package with lazy public exports for source isolation."""

from importlib import import_module


_EXPORTS = {
    "BaseSearchTool": ("deepresearch_agent.search.tool.base", "BaseSearchTool"),
    "LocalSearchTool": ("deepresearch_agent.search.tool.local_search_tool", "LocalSearchTool"),
    "GlobalSearchTool": ("deepresearch_agent.search.tool.global_search_tool", "GlobalSearchTool"),
    "HybridSearchTool": ("deepresearch_agent.search.tool.hybrid_tool", "HybridSearchTool"),
    "NaiveSearchTool": ("deepresearch_agent.search.tool.naive_search_tool", "NaiveSearchTool"),
    "DeepResearchTool": ("deepresearch_agent.search.tool.deep_research_tool", "DeepResearchTool"),
    "DeeperResearchTool": ("deepresearch_agent.search.tool.deeper_research_tool", "DeeperResearchTool"),
    "ChainOfExplorationTool": ("deepresearch_agent.search.tool.chain_exploration_tool", "ChainOfExplorationTool"),
    "HypothesisGeneratorTool": ("deepresearch_agent.search.tool.hypothesis_tool", "HypothesisGeneratorTool"),
    "AnswerValidationTool": ("deepresearch_agent.search.tool.validation_tool", "AnswerValidationTool"),
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
