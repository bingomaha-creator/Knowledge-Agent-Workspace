def test_existing_and_new_modules_import():
    from deepresearch_agent.agents.deep_research_agent import DeepResearchAgent  # noqa: F401
    from deepresearch_agent.agents.multi_agent.orchestrator import MultiAgentOrchestrator  # noqa: F401
    from deepresearch_agent.harness import RunStatus, SourceMode  # noqa: F401
    from deepresearch_agent.persistence import ArtifactStore, Database  # noqa: F401
