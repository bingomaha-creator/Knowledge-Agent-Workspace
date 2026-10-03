"""Stage-3 application entry point wiring the real workflows into Harness."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from backend.app.schemas import MessageCreate, RunCreate, SessionCreate
from deepresearch_agent.agents.deep_research_agent import DeepResearchAgent
from deepresearch_agent.agents.multi_agent.integration.multi_agent_factory import MultiAgentFactory
from deepresearch_agent.config.settings import APP_DATABASE_URL, ARTIFACT_ROOT, HARNESS_BUDGETS
from deepresearch_agent.persistence import ArtifactStore, Database
from deepresearch_agent.persistence.repositories import (
    ArtifactRepository, CheckpointRepository, ContractRepository, EventRepository,
    EvidenceRepository, MessageRepository, PlanTaskToolRepository, RunRepository, SessionRepository,
)
from deepresearch_agent.retrieval.router import create_default_router

from .contracts import SourceMode, WorkflowMode
from .runtime import HarnessRuntime
from .workflow import DeepResearchDriver, PlanExecuteReportDriver


@dataclass
class HarnessRunResult:
    run_id: str
    session_id: str
    status: str
    report: str | None


async def run_persistent_query(
    query: str,
    *,
    source_mode: SourceMode | str = SourceMode.GRAPHRAG,
    workflow_mode: WorkflowMode | str = WorkflowMode.DEEP_RESEARCH,
    database_url: str = APP_DATABASE_URL,
    client_message_id: str | None = None,
    config_snapshot: dict[str, Any] | None = None,
) -> HarnessRunResult:
    """Create Session/Message/Run and execute the real selected workflow once."""
    source = SourceMode(source_mode)
    workflow = WorkflowMode(workflow_mode)
    database = Database(database_url)
    agents: list[Any] = []
    try:
        # CLI/local stage-3 entry remains self-contained; deployed startup uses Alembic.
        await database.create_schema()
        session = await SessionRepository(database).create(SessionCreate(title=query[:80] or "新对话"))
        _, run, _ = await RunRepository(database).create_for_user_message(
            MessageCreate(session_id=session.session_id, role="user", content=query, client_message_id=client_message_id or f"cli-{session.session_id}"),
            RunCreate(session_id=session.session_id, trigger_message_id="assigned-atomically", source_mode=source, workflow_mode=workflow, config_snapshot=config_snapshot or {"min_evidence": 1}, budget=HARNESS_BUDGETS),
        )
        provider = create_default_router().for_mode(source)

        def workflow_factory(context, events=None):
            if workflow is WorkflowMode.DEEP_RESEARCH:
                agent = DeepResearchAgent(use_deeper_tool=True, retrieval_provider=provider, run_id=context.run_id)
                agents.append(agent)
                return DeepResearchDriver(context, agent, events=events)
            bundle = MultiAgentFactory.create_default_bundle(retrieval_provider=provider)
            return PlanExecuteReportDriver(context, bundle.orchestrator, events=events)

        runtime = HarnessRuntime(
            run_repository=RunRepository(database), message_repository=MessageRepository(database),
            event_repository=EventRepository(database), checkpoint_repository=CheckpointRepository(database),
            evidence_repository=EvidenceRepository(database), contract_repository=ContractRepository(database),
            trajectory_repository=PlanTaskToolRepository(database), workflow_factory=workflow_factory,
            artifact_store=ArtifactStore(ARTIFACT_ROOT), artifact_repository=ArtifactRepository(database),
        )
        context = await runtime.execute_run(run.run_id)
        return HarnessRunResult(run_id=run.run_id, session_id=session.session_id, status=context.status.value, report=context.report)
    finally:
        for agent in agents:
            if hasattr(agent, "close"):
                agent.close()
        await database.close()

