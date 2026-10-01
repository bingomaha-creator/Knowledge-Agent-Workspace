from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# Bug categories
class BugCategory(str, Enum):
    """Bug 分类（对齐 Bug 复盘知识库场景）"""
    REACT_CLOSURE = "react_closure"
    SSE_STREAM = "sse_stream"
    RACE_CONDITION = "race_condition"
    WS_RECONNECT = "ws_reconnect"
    CI_POLLUTION = "ci_pollution"
    DEPENDENCY_CONFLICT = "dependency_conflict"
    TEST_REGRESSION = "test_regression"
    CROSS_MODULE_DEFECT = "cross_module_defect"
    UNKNOWN = "unknown"


# Legacy enum for backward compatibility
class IncidentType(str, Enum):
    CI_FAILURE = "ci_failure"
    DEPENDENCY_CONFLICT = "dependency_conflict"
    TEST_REGRESSION = "test_regression"
    CROSS_MODULE_DEFECT = "cross_module_defect"
    UNKNOWN = "unknown"


class AgentRole(str, Enum):
    """Agent role definitions"""
    GENERALIST = "generalist"
    EVENT_CLASSIFIER = "event_classifier"
    INFO_EXTRACTOR = "info_extractor"
    CONTEXT_ENRICHER = "context_enricher"
    REVIEW_AGENT = "review_agent"
    PIPELINE_ORCHESTRATOR = "pipeline_orchestrator"
    QUALITY_SCORER = "quality_scorer"
    DIAGNOSE = "diagnose"
    FIX = "fix"
    VALIDATE = "validate"
    CRITIC = "critic"
    REBUTTAL = "rebuttal"
    REFLECT = "reflect"


class PatchOperation(str, Enum):
    REWRITE = "rewrite"
    CREATE = "create"
    DELETE = "delete"


class ApprovalScope(str, Enum):
    LOCAL_COMMAND = "local_command"
    GITHUB_WRITE = "github_write"
    CI_WRITE = "ci_write"
    REMOTE_EXECUTION = "remote_execution"


# Bug report (primary event record)
@dataclass(slots=True)
class BugReport:
    """Bug 复盘原始报告（对齐上游愿景：来源扩展至 PR/提交/日志/群聊）"""
    id: str
    title: str
    description: str
    logs: str
    changed_files: list[str] = field(default_factory=list)
    suspected_modules: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    reported_at: str = field(default_factory=iso_now)
    # 新增字段：来源类型（PR / 日志 / 群聊 / 手动）
    source_type: str = "manual"
    # 新增字段：关联 PR/Commit 信息
    pr_id: str | None = None
    commit_sha: str | None = None
    repo_url: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "logs": self.logs,
            "changed_files": list(self.changed_files),
            "suspected_modules": list(self.suspected_modules),
            "metadata": dict(self.metadata),
            "reported_at": self.reported_at,
            "source_type": self.source_type,
            "pr_id": self.pr_id,
            "commit_sha": self.commit_sha,
            "repo_url": self.repo_url,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BugReport":
        return cls(
            id=data.get("id", data.get("title", "bug").lower().replace(" ", "-")),
            title=data.get("title", "Untitled Bug Report"),
            description=data.get("description", ""),
            logs=data.get("logs", ""),
            changed_files=list(data.get("changed_files", [])),
            suspected_modules=list(data.get("suspected_modules", [])),
            metadata=dict(data.get("metadata", {})),
            reported_at=data.get("reported_at", iso_now()),
            source_type=data.get("source_type", "manual"),
            pr_id=data.get("pr_id"),
            commit_sha=data.get("commit_sha"),
            repo_url=data.get("repo_url") or data.get("metadata", {}).get("repo_url"),
        )


class IncidentReport(BugReport):
    """Type alias for backward compatibility."""
    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IncidentReport":
        return cls(
            id=data.get("id", data.get("title", "incident").lower().replace(" ", "-")),
            title=data.get("title", "Untitled incident"),
            description=data.get("description", ""),
            logs=data.get("logs", ""),
            changed_files=list(data.get("changed_files", [])),
            suspected_modules=list(data.get("suspected_modules", [])),
            metadata=dict(data.get("metadata", {})),
            reported_at=data.get("reported_at", iso_now()),
            source_type=data.get("source_type", "manual"),
            pr_id=data.get("pr_id"),
            commit_sha=data.get("commit_sha"),
            repo_url=data.get("repo_url"),
        )


@dataclass(slots=True)
class CompressedError:
    error_type: IncidentType
    error_name: str
    keywords: list[str]
    key_stack_frames: list[str]
    root_cause_cluster: str
    semantic_summary: str
    confidence: float


# Knowledge entry (indexed bug review artifact)
@dataclass(slots=True)
class KnowledgeEntry:
    """踩坑知识条目（对齐上游愿景：团队踩坑知识库）"""
    id: str
    name: str
    description: str
    triggers: list[str]
    error_types: list[str]
    action_template: str
    version: int = 1
    usage_count: int = 0
    success_count: int = 0
    last_used_at: str = field(default_factory=iso_now)
    active: bool = True
    source_trace_ids: list[str] = field(default_factory=list)
    embedding: list[float] = field(default_factory=list)
    # 新增字段：关联的 Bug 复盘文档
    related_bug_ids: list[str] = field(default_factory=list)
    # 新增字段：关键词标签（用于语义搜索）
    keywords: list[str] = field(default_factory=list)
    # 新增字段：适用场景（前端/后端/全栈等）
    applicable_context: str = ""

    @property
    def success_rate(self) -> float:
        if self.usage_count == 0:
            return 0.0
        return self.success_count / self.usage_count

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "KnowledgeEntry":
        return cls(
            id=data["id"],
            name=data["name"],
            description=data["description"],
            triggers=list(data.get("triggers", [])),
            error_types=list(data.get("error_types", [])),
            action_template=data.get("action_template", ""),
            version=int(data.get("version", 1)),
            usage_count=int(data.get("usage_count", 0)),
            success_count=int(data.get("success_count", 0)),
            last_used_at=data.get("last_used_at", iso_now()),
            active=bool(data.get("active", True)),
            source_trace_ids=list(data.get("source_trace_ids", [])),
            embedding=list(data.get("embedding", [])),
            related_bug_ids=list(data.get("related_bug_ids", [])),
            keywords=list(data.get("keywords", [])),
            applicable_context=data.get("applicable_context", ""),
        )



class Skill(KnowledgeEntry):
    """Type alias for compatibility."""
    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Skill":
        return cls(
            id=data["id"],
            name=data["name"],
            description=data["description"],
            triggers=list(data.get("triggers", [])),
            error_types=list(data.get("error_types", [])),
            action_template=data.get("action_template", ""),
            version=int(data.get("version", 1)),
            usage_count=int(data.get("usage_count", 0)),
            success_count=int(data.get("success_count", 0)),
            last_used_at=data.get("last_used_at", iso_now()),
            active=bool(data.get("active", True)),
            source_trace_ids=list(data.get("source_trace_ids", [])),
            embedding=list(data.get("embedding", [])),
            related_bug_ids=list(data.get("related_bug_ids", [])),
            keywords=list(data.get("keywords", [])),
            applicable_context=data.get("applicable_context", ""),
        )


@dataclass(slots=True)
class SymbolDefinition:
    symbol_id: str
    name: str
    kind: str
    file_path: str
    line: int
    language: str
    signature: str = ""


@dataclass(slots=True)
class CodeEdge:
    source: str
    target: str
    edge_type: str
    weight: float = 1.0


@dataclass(slots=True)
class CodeGraphMetadata:
    graph_nodes: int
    graph_edges: int
    strongly_connected_components: int
    tree_sitter_enabled: bool
    languages_with_tree_sitter: list[str] = field(default_factory=list)


@dataclass(slots=True)
class RepoSnapshot:
    root_dir: str
    files: list[str]
    file_summaries: dict[str, str]
    dependency_edges: list[tuple[str, str]]
    call_edges: list[tuple[str, str]]
    language_breakdown: dict[str, int]
    symbols: list[SymbolDefinition] = field(default_factory=list)
    graph_edges: list[CodeEdge] = field(default_factory=list)
    graph_metadata: CodeGraphMetadata | None = None


@dataclass(slots=True)
class ContextBundle:
    working_context: dict[str, Any]
    short_term_memories: list[dict[str, Any]]
    long_term_memories: list[dict[str, Any]]
    matched_skills: list[KnowledgeEntry]
    relevant_files: list[str]
    budget_allocations: dict[str, int]
    semantic_focus: list[str]


@dataclass(slots=True)
class AgentTask:
    id: str
    role: AgentRole
    objective: str
    focus_files: list[str]
    budget: int
    allowed_tools: list[str] = field(default_factory=list)
    sandbox_policy: dict[str, Any] = field(default_factory=dict)
    negotiation_round: int = 1


## Extraction execution step
@dataclass(slots=True)
class ExtractionStep:
    """LLM 抽取步骤（对齐 Bug 复盘场景）"""
    title: str
    description: str
    target_files: list[str]
    confidence: float
    source_skill_id: str | None = None
    # 新增字段：字段抽取结果（用于结构化输出）
    extracted_fields: dict[str, Any] = field(default_factory=dict)



RepairStep = ExtractionStep


@dataclass(slots=True)
class AgentExecution:
    task_id: str
    role: AgentRole
    reasoning_summary: str
    repair_steps: list[ExtractionStep]
    token_estimate: int
    success_likelihood: float
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class SchedulerDecision:
    mode: str
    complexity_score: int
    reasons: list[str]
    tasks: list[AgentTask]
    budget_breakdown: dict[str, int]


@dataclass(slots=True)
class PreparedIncident:
    incident: BugReport
    snapshot: RepoSnapshot
    compressed_error: CompressedError
    matched_skills: list[KnowledgeEntry]
    relevant_files: list[str]
    context: ContextBundle
    decision: SchedulerDecision
    executions: list[AgentExecution]
    repair_steps: list[ExtractionStep]
    retrieval_matches: list["RetrievalMatch"] = field(default_factory=list)
    github_run_id: int | None = None


@dataclass(slots=True)
class PatchEdit:
    path: str
    operation: PatchOperation
    content: str = ""
    reason: str = ""


## Structured review output
@dataclass(slots=True)
class StructuredReview:
    """LLM extraction output"""
    analysis: str
    summary: str
    commit_message: str
    validation_commands: list[str]
    edits: list[PatchEdit]
    model: str
    raw_response: str = ""
    usage: dict[str, int] = field(default_factory=dict)
    # 新增字段：抽取质量指标
    extraction_confidence: float = 0.0
    # 新增字段：Bug 复盘核心字段
    root_cause: str = ""
    impact_scope: str = ""
    fix_solution: str = ""
    prevention: str = ""
    related_modules: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)



PatchPlan = StructuredReview


@dataclass(slots=True)
class ValidationResult:
    commands: list[str]
    success: bool
    command_results: list[dict[str, Any]]
    combined_output: str
    duration_seconds: float


## Review result
@dataclass(slots=True)
class ReviewResult:
    """Review outcome"""
    trace: "ExecutionTrace"
    success: bool
    sandbox_path: str
    baseline_validation: ValidationResult
    final_validation: ValidationResult
    attempts: int
    rollback_performed: bool
    commit_hash: str | None
    diff_summary: str
    patch_plan: StructuredReview | None
    report_path: str
    delivery: dict[str, Any] = field(default_factory=dict)
    # 新增字段：审核状态（draft/pending/approved/rejected）
    review_status: str = "draft"
    # 新增字段：审核备注
    reviewer_notes: str = ""
    # 新增字段：发布到 Wiki 的结果
    wiki_publish_result: dict[str, Any] = field(default_factory=dict)



RepairOutcome = ReviewResult


@dataclass(slots=True)
class GitHubWorkflowRun:
    run_id: int
    workflow_id: int | None
    name: str
    status: str
    conclusion: str | None
    html_url: str | None
    logs_url: str | None
    rerun_url: str | None
    head_branch: str | None
    head_sha: str | None
    event: str | None
    created_at: str | None
    updated_at: str | None


@dataclass(slots=True)
class GitHubSyncResult:
    owner: str
    repo: str
    runs: list[GitHubWorkflowRun]
    incidents: list[BugReport]
    latest_logs_excerpt: str = ""


@dataclass(slots=True)
class CiWorkflowRun:
    provider: str
    run_id: str
    name: str
    status: str
    conclusion: str | None
    web_url: str | None
    logs_url: str | None
    rerun_target: str | None
    ref: str | None
    revision: str | None
    created_at: str | None
    updated_at: str | None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class CiSyncResult:
    provider: str
    runs: list[CiWorkflowRun]
    incidents: list[BugReport]
    latest_logs_excerpt: str = ""


@dataclass(slots=True)
class RetrievalMatch:
    item_id: str
    item_type: str
    score: float
    lexical_score: float
    semantic_score: float
    payload: dict[str, Any]
    reranker_score: float = 0.0


@dataclass(slots=True)
class ApprovalRecord:
    scope: ApprovalScope
    subject: str
    actor: str
    approved_at: str
    expires_at: str
    reason: str = ""


@dataclass(slots=True)
class AuditEvent:
    event_type: str
    status: str
    subject: str
    created_at: str
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ExecutionTrace:
    id: str
    incident: BugReport
    compressed_error: CompressedError
    decision: SchedulerDecision
    executions: list[AgentExecution]
    matched_skill_ids: list[str]
    success: bool
    repair_summary: str
    token_usage: int
    context_digest: dict[str, Any]
    execution_mode: str = "planning"
    validation_passed: bool | None = None
    validation_commands: list[str] = field(default_factory=list)
    sandbox_path: str | None = None
    commit_hash: str | None = None
    rollback_performed: bool = False
    diff_summary: str | None = None
    attempt_count: int = 0
    llm_model: str | None = None
    github_run_id: int | None = None
    retrieval_matches: list[dict[str, Any]] = field(default_factory=list)
    approvals_used: list[dict[str, Any]] = field(default_factory=list)
    agent_runtime_backend: str | None = None
    collaboration_blackboard: dict[str, Any] = field(default_factory=dict)
    delivery: dict[str, Any] = field(default_factory=dict)
    auto_learning_status: str = "not_requested"
    auto_learning_report: dict[str, Any] = field(default_factory=dict)
    # 新增字段：审核状态（draft/pending/approved/rejected）
    review_status: str = "draft"
    # 新增字段：审核备注
    reviewer_notes: str = ""
    created_at: str = field(default_factory=iso_now)
