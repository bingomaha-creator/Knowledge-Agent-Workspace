"""
构建多智能体编排器所需组件的工厂工具。
"""
from dataclasses import dataclass
from typing import Optional

from deepresearch_agent.cache_manager.manager import CacheManager
from deepresearch_agent.agents.multi_agent.executor.worker_coordinator import (
    WorkerCoordinator,
)
from deepresearch_agent.agents.multi_agent.orchestrator import (
    MultiAgentOrchestrator,
    OrchestratorConfig,
)
from deepresearch_agent.agents.multi_agent.planner.base_planner import BasePlanner
from deepresearch_agent.agents.multi_agent.reporter.base_reporter import BaseReporter
from deepresearch_agent.agents.multi_agent.reporter.base_reporter import ReporterConfig
from deepresearch_agent.config.settings import (
    MULTI_AGENT_AUTO_GENERATE_REPORT,
    MULTI_AGENT_STOP_ON_CLARIFICATION,
    MULTI_AGENT_STRICT_PLAN_SIGNAL,
)
from deepresearch_agent.retrieval.base import RetrievalProvider
from deepresearch_agent.retrieval.router import RetrievalRouter


@dataclass
class OrchestratorBundle:
    """封装编排器所依赖的 Planner、Worker、Reporter 等组件。"""

    planner: BasePlanner
    worker: WorkerCoordinator
    reporter: BaseReporter
    orchestrator: MultiAgentOrchestrator


class MultiAgentFactory:
    """用于创建带默认配置的多智能体编排栈。"""

    @staticmethod
    def create_default_bundle(
        *,
        planner: Optional[BasePlanner] = None,
        worker: Optional[WorkerCoordinator] = None,
        reporter: Optional[BaseReporter] = None,
        orchestrator_config: Optional[OrchestratorConfig] = None,
        reporter_config: Optional[ReporterConfig] = None,
        cache_manager: Optional[CacheManager] = None,
        retrieval_provider: Optional[RetrievalProvider] = None,
        retrieval_router: Optional[RetrievalRouter] = None,
    ) -> OrchestratorBundle:
        planner = planner or BasePlanner()
        # Evidence Card and section checkpoints use exact content/report hashes.
        cache_manager = cache_manager or CacheManager(enable_vector_similarity=False)
        worker = worker or WorkerCoordinator(
            retrieval_provider=retrieval_provider,
            retrieval_router=retrieval_router,
        )
        reporter = reporter or BaseReporter(
            config=reporter_config,
            cache_manager=cache_manager,
        )
        orchestrator_config = orchestrator_config or OrchestratorConfig(
            auto_generate_report=MULTI_AGENT_AUTO_GENERATE_REPORT,
            stop_on_clarification=MULTI_AGENT_STOP_ON_CLARIFICATION,
            strict_plan_signal=MULTI_AGENT_STRICT_PLAN_SIGNAL,
        )
        orchestrator = MultiAgentOrchestrator(
            planner=planner,
            worker_coordinator=worker,
            reporter=reporter,
            config=orchestrator_config,
        )
        return OrchestratorBundle(
            planner=planner,
            worker=worker,
            reporter=reporter,
            orchestrator=orchestrator,
        )


__all__ = ["MultiAgentFactory", "OrchestratorBundle"]
