from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
from pathlib import Path
from typing import Any


def _parse_env_line(raw_line: str) -> tuple[str, str] | None:
    line = raw_line.strip()
    if not line or line.startswith("#"):
        return None
    if line.startswith("export "):
        line = line[7:].strip()
    if "=" not in line:
        return None
    key, value = line.split("=", 1)
    key = key.strip()
    if not key:
        return None
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        value = value[1:-1]
    return key, value


def _load_dotenv(root_dir: str | Path, filename: str = ".env") -> Path | None:
    env_path = Path(root_dir).resolve() / filename
    if not env_path.exists():
        return None
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        parsed = _parse_env_line(raw_line)
        if parsed is None:
            continue
        key, value = parsed
        os.environ.setdefault(key, value)
    return env_path


def _env_flag(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() not in {"0", "false", "off", ""}


def _parse_headers(raw_value: str | None) -> dict[str, str]:
    if not raw_value:
        return {}
    try:
        payload = json.loads(raw_value)
    except json.JSONDecodeError:
        return {}
    if not isinstance(payload, dict):
        return {}
    return {str(key): str(value) for key, value in payload.items()}


@dataclass(frozen=True)
class ProviderPreset:
    name: str
    display_name: str
    llm_base_url: str
    llm_mode: str
    llm_model: str
    embedding_base_url: str
    embedding_mode: str
    embedding_model: str
    notes: str = ""


PROVIDER_PRESETS: dict[str, ProviderPreset] = {
    "openai": ProviderPreset(
        name="openai",
        display_name="OpenAI",
        llm_base_url="https://api.openai.com/v1",
        llm_mode="openai_responses",
        llm_model="gpt-5.2",
        embedding_base_url="https://api.openai.com/v1",
        embedding_mode="openai_compatible",
        embedding_model="text-embedding-3-small",
    ),
    "alibaba": ProviderPreset(
        name="alibaba",
        display_name="Alibaba Bailian / DashScope",
        llm_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        llm_mode="openai_compatible_chat",
        llm_model="qwen-max-latest",
        embedding_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        embedding_mode="openai_compatible",
        embedding_model="text-embedding-v4",
        notes="Recommended target provider for this project.",
    ),
    "bytedance": ProviderPreset(
        name="bytedance",
        display_name="ByteDance Ark",
        llm_base_url="https://ark.cn-beijing.volces.com/api/v3",
        llm_mode="openai_compatible_chat",
        llm_model="ep-your-chat-endpoint-id",
        embedding_base_url="https://ark.cn-beijing.volces.com/api/v3",
        embedding_mode="openai_compatible",
        embedding_model="ep-your-embedding-endpoint-id",
    ),
    "kimi": ProviderPreset(
        name="kimi",
        display_name="Moonshot Kimi",
        llm_base_url="https://api.moonshot.cn/v1",
        llm_mode="openai_compatible_chat",
        llm_model="moonshot-v1-128k",
        embedding_base_url="https://api.moonshot.cn/v1",
        embedding_mode="openai_compatible",
        embedding_model="",
        notes="Embedding model name depends on the provider account; configure explicitly when enabled.",
    ),
    "google": ProviderPreset(
        name="google",
        display_name="Google Gemini",
        llm_base_url="https://generativelanguage.googleapis.com/v1beta",
        llm_mode="google_gemini",
        llm_model="gemini-2.5-pro",
        embedding_base_url="https://generativelanguage.googleapis.com/v1beta",
        embedding_mode="google_gemini",
        embedding_model="text-embedding-004",
    ),
    "custom": ProviderPreset(
        name="custom",
        display_name="Custom Compatible Endpoint",
        llm_base_url="https://api.openai.com/v1",
        llm_mode="openai_compatible_chat",
        llm_model="",
        embedding_base_url="https://api.openai.com/v1",
        embedding_mode="openai_compatible",
        embedding_model="",
    ),
}


def provider_preset(name: str) -> ProviderPreset:
    return PROVIDER_PRESETS.get(name.strip().lower(), PROVIDER_PRESETS["openai"])


def provider_catalog() -> list[dict[str, str]]:
    return [
        {
            "key": preset.name,
            "label": preset.display_name,
            "llm_mode": preset.llm_mode,
            "embedding_mode": preset.embedding_mode,
            "recommended_llm_model": preset.llm_model,
            "recommended_embedding_model": preset.embedding_model,
            "notes": preset.notes,
        }
        for preset in PROVIDER_PRESETS.values()
    ]


@dataclass(frozen=True)
class TokenBudgetConfig:
    total_budget: int = 12_000
    working_ratio: float = 0.45
    short_term_ratio: float = 0.20
    long_term_ratio: float = 0.20
    skill_ratio: float = 0.15


@dataclass(frozen=True)
class SchedulerConfig:
    simple_task_threshold: int = 5
    multi_agent_min_files: int = 3
    high_confidence_skill_bonus: int = 2


@dataclass(frozen=True)
class OpenAIExecutorConfig:
    provider: str
    display_name: str
    api_key: str | None
    api_key_env: str
    base_url: str
    model: str
    timeout_seconds: int
    max_output_tokens: int
    compatibility_mode: str
    extra_headers: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "OpenAIExecutorConfig":
        provider_name = os.getenv("LLM_PROVIDER", "openai").strip().lower()
        preset = provider_preset(provider_name)
        api_key_env = os.getenv("LLM_API_KEY_ENV", os.getenv("OPENAI_API_KEY_ENV", "OPENAI_API_KEY"))
        return cls(
            provider=provider_name,
            display_name=preset.display_name,
            api_key=os.getenv(api_key_env),
            api_key_env=api_key_env,
            base_url=os.getenv("LLM_BASE_URL", os.getenv("OPENAI_BASE_URL", preset.llm_base_url)),
            model=os.getenv("LLM_MODEL", os.getenv("OPENAI_MODEL", preset.llm_model)),
            timeout_seconds=int(os.getenv("LLM_TIMEOUT_SECONDS", os.getenv("OPENAI_TIMEOUT_SECONDS", "120"))),
            max_output_tokens=int(os.getenv("LLM_MAX_OUTPUT_TOKENS", os.getenv("OPENAI_MAX_OUTPUT_TOKENS", "4000"))),
            compatibility_mode=os.getenv("LLM_COMPATIBILITY_MODE", preset.llm_mode),
            extra_headers=_parse_headers(os.getenv("LLM_EXTRA_HEADERS_JSON")),
        )


@dataclass(frozen=True)
class EmbeddingConfig:
    provider: str
    display_name: str
    api_key: str | None
    api_key_env: str
    base_url: str
    model: str
    timeout_seconds: int
    enabled: bool
    compatibility_mode: str
    extra_headers: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "EmbeddingConfig":
        provider_name = os.getenv("EMBEDDING_PROVIDER", os.getenv("LLM_PROVIDER", "openai")).strip().lower()
        preset = provider_preset(provider_name)
        api_key_env = os.getenv(
            "EMBEDDING_API_KEY_ENV",
            os.getenv("OPENAI_EMBEDDING_API_KEY_ENV", os.getenv("OPENAI_API_KEY_ENV", "OPENAI_API_KEY")),
        )
        return cls(
            provider=provider_name,
            display_name=preset.display_name,
            api_key=os.getenv(api_key_env),
            api_key_env=api_key_env,
            base_url=os.getenv(
                "EMBEDDING_BASE_URL",
                os.getenv("OPENAI_EMBEDDING_BASE_URL", os.getenv("OPENAI_BASE_URL", preset.embedding_base_url)),
            ),
            model=os.getenv("EMBEDDING_MODEL", os.getenv("OPENAI_EMBEDDING_MODEL", preset.embedding_model)),
            timeout_seconds=int(os.getenv("EMBEDDING_TIMEOUT_SECONDS", os.getenv("OPENAI_TIMEOUT_SECONDS", "120"))),
            enabled=_env_flag("EMBEDDINGS_ENABLED", os.getenv("OPENAI_EMBEDDINGS_ENABLED", "1")),
            compatibility_mode=os.getenv("EMBEDDING_COMPATIBILITY_MODE", preset.embedding_mode),
            extra_headers=_parse_headers(os.getenv("EMBEDDING_EXTRA_HEADERS_JSON")),
        )


@dataclass(frozen=True)
class GitHubActionsConfig:
    token: str | None
    token_env: str
    api_url: str
    api_version: str
    default_owner: str | None
    default_repo: str | None
    log_tail_chars: int
    enabled: bool

    @classmethod
    def from_env(cls) -> "GitHubActionsConfig":
        token_env = os.getenv("GITHUB_TOKEN_ENV", "GITHUB_TOKEN")
        default_slug = os.getenv("GITHUB_REPOSITORY", "")
        owner, _, repo = default_slug.partition("/")
        return cls(
            token=os.getenv(token_env),
            token_env=token_env,
            api_url=os.getenv("GITHUB_API_URL", "https://api.github.com"),
            api_version=os.getenv("GITHUB_API_VERSION", "2022-11-28"),
            default_owner=owner or None,
            default_repo=repo or None,
            log_tail_chars=int(os.getenv("GITHUB_LOG_TAIL_CHARS", "16000")),
            enabled=_env_flag("GITHUB_ACTIONS_ENABLED", "1"),
        )


@dataclass(frozen=True)
class GitLabCiConfig:
    token: str | None
    token_env: str
    api_url: str
    default_project_id: str | None
    log_tail_chars: int
    enabled: bool

    @classmethod
    def from_env(cls) -> "GitLabCiConfig":
        token_env = os.getenv("GITLAB_TOKEN_ENV", "GITLAB_TOKEN")
        return cls(
            token=os.getenv(token_env),
            token_env=token_env,
            api_url=os.getenv("GITLAB_API_URL", "https://gitlab.com/api/v4"),
            default_project_id=os.getenv("GITLAB_PROJECT_ID") or None,
            log_tail_chars=int(os.getenv("GITLAB_LOG_TAIL_CHARS", "16000")),
            enabled=_env_flag("GITLAB_CI_ENABLED", "1"),
        )


@dataclass(frozen=True)
class JenkinsConfig:
    username: str | None
    token: str | None
    token_env: str
    base_url: str
    default_job: str | None
    log_tail_chars: int
    enabled: bool

    @classmethod
    def from_env(cls) -> "JenkinsConfig":
        token_env = os.getenv("JENKINS_TOKEN_ENV", "JENKINS_TOKEN")
        return cls(
            username=os.getenv("JENKINS_USERNAME"),
            token=os.getenv(token_env),
            token_env=token_env,
            base_url=os.getenv("JENKINS_BASE_URL", "http://localhost:8080"),
            default_job=os.getenv("JENKINS_JOB_NAME") or None,
            log_tail_chars=int(os.getenv("JENKINS_LOG_TAIL_CHARS", "16000")),
            enabled=_env_flag("JENKINS_ENABLED", "1"),
        )


@dataclass(frozen=True)
class RetrievalConfig:
    top_k: int = 5
    semantic_weight: float = 0.7
    lexical_weight: float = 0.2
    success_weight: float = 0.1
    error_type_boost: float = 0.08
    cluster_boost: float = 0.05
    max_memory_candidates: int = 12
    candidate_pool_size: int = 24
    min_combined_score: float = 0.05
    mmr_lambda: float = 0.75
    vector_backend: str = "auto"
    vector_backend_fallback: str = "sqlite_ann"
    ann_enabled: bool = True
    ann_signature_length: int = 16
    ann_probe_count: int = 6
    reranker_enabled: bool = True
    reranker_backend: str = "auto"
    reranker_model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"
    reranker_device: str = "cpu"
    reranker_batch_size: int = 8
    reranker_weight: float = 0.25
    reranker_query_window: int = 12
    milvus_uri: str = "http://127.0.0.1:19530"
    milvus_token: str | None = None
    milvus_collection_prefix: str = "repo_autonomy_"
    pgvector_dsn: str | None = None
    pgvector_table: str = "repo_autonomy_vectors"
    hnsw_space: str = "cosine"
    hnsw_m: int = 16
    hnsw_ef_construction: int = 200
    hnsw_ef_search: int = 64

    @classmethod
    def from_env(cls) -> "RetrievalConfig":
        return cls(
            vector_backend=os.getenv("VECTOR_BACKEND", "auto"),
            vector_backend_fallback=os.getenv("VECTOR_BACKEND_FALLBACK", "sqlite_ann"),
            ann_enabled=_env_flag("RETRIEVAL_ANN_ENABLED", "1"),
            ann_signature_length=int(os.getenv("RETRIEVAL_ANN_SIGNATURE_LENGTH", "16")),
            ann_probe_count=int(os.getenv("RETRIEVAL_ANN_PROBE_COUNT", "6")),
            reranker_enabled=_env_flag("RETRIEVAL_RERANKER_ENABLED", "1"),
            reranker_backend=os.getenv("RETRIEVAL_RERANKER_BACKEND", "auto"),
            reranker_model=os.getenv("RETRIEVAL_RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2"),
            reranker_device=os.getenv("RETRIEVAL_RERANKER_DEVICE", "cpu"),
            reranker_batch_size=int(os.getenv("RETRIEVAL_RERANKER_BATCH_SIZE", "8")),
            reranker_weight=float(os.getenv("RETRIEVAL_RERANKER_WEIGHT", "0.25")),
            reranker_query_window=int(os.getenv("RETRIEVAL_RERANKER_QUERY_WINDOW", "12")),
            milvus_uri=os.getenv("MILVUS_URI", "http://127.0.0.1:19530"),
            milvus_token=os.getenv("MILVUS_TOKEN") or None,
            milvus_collection_prefix=os.getenv("MILVUS_COLLECTION_PREFIX", "repo_autonomy_"),
            pgvector_dsn=os.getenv("PGVECTOR_DSN") or None,
            pgvector_table=os.getenv("PGVECTOR_TABLE", "repo_autonomy_vectors"),
            hnsw_space=os.getenv("RETRIEVAL_HNSW_SPACE", "cosine"),
            hnsw_m=int(os.getenv("RETRIEVAL_HNSW_M", "16")),
            hnsw_ef_construction=int(os.getenv("RETRIEVAL_HNSW_EF_CONSTRUCTION", "200")),
            hnsw_ef_search=int(os.getenv("RETRIEVAL_HNSW_EF_SEARCH", "64")),
        )


@dataclass(frozen=True)
class AgentReasoningConfig:
    enabled: bool = False
    max_steps: int = 4
    max_context_chars: int = 6000
    max_tool_rounds: int = 2

    @classmethod
    def from_env(cls) -> "AgentReasoningConfig":
        return cls(
            enabled=_env_flag("LLM_AGENT_REASONING_ENABLED", "0"),
            max_steps=int(os.getenv("LLM_AGENT_REASONING_MAX_STEPS", "4")),
            max_context_chars=int(os.getenv("LLM_AGENT_REASONING_MAX_CONTEXT_CHARS", "6000")),
            max_tool_rounds=int(os.getenv("LLM_AGENT_REASONING_MAX_TOOL_ROUNDS", "2")),
        )


@dataclass(frozen=True)
class LearningConfig:
    auto_run_on_successful_repair: bool = True
    async_queue_enabled: bool = True
    embedded_workers_enabled: bool = False
    batch_window_seconds: float = 1.0
    max_batch_size: int = 6
    lease_timeout_seconds: float = 45.0
    scheduler_lease_ttl_seconds: float = 12.0
    idle_poll_seconds: float = 2.0
    idle_after_seconds: float = 4.0
    idle_backfill_limit: int = 4
    repair_priority: int = 90
    idle_backfill_priority: int = 35
    retry_delay_seconds: float = 20.0
    max_retry_delay_seconds: float = 600.0
    max_job_failures: int = 3
    review_limit: int = 20

    @classmethod
    def from_env(cls) -> "LearningConfig":
        return cls(
            auto_run_on_successful_repair=_env_flag("AUTO_DREAM_ON_SUCCESSFUL_REPAIR", "1"),
            async_queue_enabled=_env_flag("AUTO_DREAM_ASYNC_ENABLED", "1"),
            embedded_workers_enabled=_env_flag("AUTO_DREAM_EMBEDDED_WORKERS_ENABLED", "0"),
            batch_window_seconds=float(os.getenv("AUTO_DREAM_BATCH_WINDOW_SECONDS", "1")),
            max_batch_size=int(os.getenv("AUTO_DREAM_MAX_BATCH_SIZE", "6")),
            lease_timeout_seconds=float(os.getenv("AUTO_DREAM_LEASE_TIMEOUT_SECONDS", "45")),
            scheduler_lease_ttl_seconds=float(os.getenv("AUTO_DREAM_SCHEDULER_LEASE_TTL_SECONDS", "12")),
            idle_poll_seconds=float(os.getenv("AUTO_DREAM_IDLE_POLL_SECONDS", "2")),
            idle_after_seconds=float(os.getenv("AUTO_DREAM_IDLE_AFTER_SECONDS", "4")),
            idle_backfill_limit=int(os.getenv("AUTO_DREAM_IDLE_BACKFILL_LIMIT", "4")),
            repair_priority=int(os.getenv("AUTO_DREAM_REPAIR_PRIORITY", "90")),
            idle_backfill_priority=int(os.getenv("AUTO_DREAM_IDLE_BACKFILL_PRIORITY", "35")),
            retry_delay_seconds=float(os.getenv("AUTO_DREAM_RETRY_DELAY_SECONDS", "20")),
            max_retry_delay_seconds=float(os.getenv("AUTO_DREAM_MAX_RETRY_DELAY_SECONDS", "600")),
            max_job_failures=int(os.getenv("AUTO_DREAM_MAX_JOB_FAILURES", "3")),
            review_limit=int(os.getenv("AUTO_DREAM_REVIEW_LIMIT", "20")),
        )


@dataclass(frozen=True)
class GraphConfig:
    enable_treesitter: bool = True
    treesitter_auto_detect: bool = True
    max_symbol_edges: int = 4_000
    max_call_depth: int = 6
    data_flow_enabled: bool = True
    control_flow_enabled: bool = True

    @classmethod
    def from_env(cls) -> "GraphConfig":
        return cls(
            enable_treesitter=_env_flag("TREE_SITTER_ENABLED", "1"),
            treesitter_auto_detect=_env_flag("TREE_SITTER_AUTO_DETECT", "1"),
            data_flow_enabled=_env_flag("DATA_FLOW_ANALYSIS_ENABLED", "1"),
            control_flow_enabled=_env_flag("CONTROL_FLOW_ANALYSIS_ENABLED", "1"),
        )


@dataclass(frozen=True)
class RuntimeConfig:
    backend: str = "process"
    max_workers: int = 4
    task_timeout_seconds: int = 120
    isolation_root_name: str = "agent_runtime"
    negotiation_max_rounds: int = 3
    negotiation_convergence_threshold: float = 0.72
    agent_sandbox_mode: str = "copy"
    agent_sandbox_max_files: int = 8
    agent_network_enabled: bool = False

    @classmethod
    def from_env(cls) -> "RuntimeConfig":
        return cls(
            backend=os.getenv("AGENT_RUNTIME_BACKEND", "process"),
            max_workers=int(os.getenv("AGENT_RUNTIME_MAX_WORKERS", "4")),
            task_timeout_seconds=int(os.getenv("AGENT_RUNTIME_TASK_TIMEOUT_SECONDS", "120")),
            negotiation_max_rounds=int(os.getenv("AGENT_NEGOTIATION_MAX_ROUNDS", "3")),
            negotiation_convergence_threshold=float(os.getenv("AGENT_NEGOTIATION_CONVERGENCE_THRESHOLD", "0.72")),
            agent_sandbox_mode=os.getenv("AGENT_SANDBOX_MODE", "copy"),
            agent_sandbox_max_files=int(os.getenv("AGENT_SANDBOX_MAX_FILES", "8")),
            agent_network_enabled=_env_flag("AGENT_SANDBOX_NETWORK_ENABLED", "0"),
        )


@dataclass(frozen=True)
class SecurityConfig:
    allow_remote_reads: bool = True
    require_github_write_approval: bool = False
    require_remote_execution_approval: bool = False
    allow_unapproved_local_validation: bool = True
    default_approval_ttl_hours: int = 24

    @classmethod
    def from_env(cls) -> "SecurityConfig":
        return cls(
            require_github_write_approval=_env_flag("REQUIRE_GITHUB_WRITE_APPROVAL", "0"),
            require_remote_execution_approval=_env_flag("REQUIRE_REMOTE_EXECUTION_APPROVAL", "0"),
            allow_unapproved_local_validation=_env_flag("ALLOW_UNAPPROVED_LOCAL_VALIDATION", "1"),
            default_approval_ttl_hours=int(os.getenv("APPROVAL_TTL_HOURS", "24")),
        )


@dataclass(frozen=True)
class SandboxConfig:
    max_context_files: int = 6
    max_file_chars: int = 14_000
    keep_sandboxes: bool = True
    max_repair_attempts: int = 2
    max_patch_edits: int = 12
    max_total_edit_chars: int = 120_000
    max_delete_edits: int = 2
    backend: str = "workspace"
    container_runtime: str = "docker"
    container_image: str = "python:3.11-slim"
    container_network_mode: str = "none"
    cpu_limit: float = 1.5
    memory_limit_mb: int = 768

    @classmethod
    def from_env(cls) -> "SandboxConfig":
        return cls(
            backend=os.getenv("SANDBOX_BACKEND", "workspace"),
            container_runtime=os.getenv("SANDBOX_CONTAINER_RUNTIME", "docker"),
            container_image=os.getenv("SANDBOX_CONTAINER_IMAGE", "python:3.11-slim"),
            container_network_mode=os.getenv("SANDBOX_CONTAINER_NETWORK_MODE", "none"),
            cpu_limit=float(os.getenv("SANDBOX_CPU_LIMIT", "1.5")),
            memory_limit_mb=int(os.getenv("SANDBOX_MEMORY_LIMIT_MB", "768")),
        )


@dataclass(frozen=True)
class ValidationConfig:
    command_timeout_seconds: int = 180
    max_log_chars: int = 12_000


@dataclass(frozen=True)
class ApiServerConfig:
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: list[str] = field(
        default_factory=lambda: ["http://localhost:5173"]
    )
    auto_bootstrap_demo: bool = False

    @classmethod
    def from_env(cls) -> "ApiServerConfig":
        return cls(
            host=os.getenv("API_HOST", "0.0.0.0"),
            port=int(os.getenv("API_PORT", "8000")),
            cors_origins=[item.strip() for item in os.getenv("API_CORS_ORIGINS", "http://localhost:5173").split(",") if item.strip()],
            auto_bootstrap_demo=_env_flag("API_BOOTSTRAP_DEMO", "0"),
        )


@dataclass(frozen=True)
class PlatformPaths:
    runtime_dir: Path
    api_data_dir: Path
    checkouts_dir: Path
    skills_path: Path
    memory_db_path: Path
    metrics_path: Path
    reports_dir: Path
    sandboxes_dir: Path
    vector_index_path: Path
    vector_store_path: Path
    approvals_path: Path
    audit_log_path: Path
    incidents_dir: Path
    runtime_tasks_dir: Path
    repos_path: Path
    tasks_path: Path
    thresholds_path: Path
    notifications_path: Path
    exports_dir: Path


@dataclass(frozen=True)
class PlatformConfig:
    root_dir: Path
    paths: PlatformPaths
    token_budget: TokenBudgetConfig
    scheduler: SchedulerConfig
    agent_reasoning: AgentReasoningConfig
    learning: LearningConfig
    openai: OpenAIExecutorConfig
    embeddings: EmbeddingConfig
    github: GitHubActionsConfig
    gitlab: GitLabCiConfig
    jenkins: JenkinsConfig
    retrieval: RetrievalConfig
    graph: GraphConfig
    runtime: RuntimeConfig
    security: SecurityConfig
    sandbox: SandboxConfig
    validation: ValidationConfig
    api: ApiServerConfig

    @property
    def llm(self) -> OpenAIExecutorConfig:
        return self.openai

    @classmethod
    def default(cls, root_dir: str | Path) -> "PlatformConfig":
        root = Path(root_dir).resolve()
        _load_dotenv(root)
        runtime_dir = root / "runtime"
        api_data_dir = runtime_dir / "api"
        paths = PlatformPaths(
            runtime_dir=runtime_dir,
            api_data_dir=api_data_dir,
            checkouts_dir=runtime_dir / "checkouts",
            skills_path=runtime_dir / "skills.json",
            memory_db_path=runtime_dir / "memory.sqlite3",
            metrics_path=runtime_dir / "metrics.jsonl",
            reports_dir=runtime_dir / "reports",
            sandboxes_dir=runtime_dir / "sandboxes",
            vector_index_path=runtime_dir / "vector_index.json",
            vector_store_path=runtime_dir / "vector_store.sqlite3",
            approvals_path=runtime_dir / "approvals.json",
            audit_log_path=runtime_dir / "audit.jsonl",
            incidents_dir=runtime_dir / "incidents",
            runtime_tasks_dir=runtime_dir / "agent_runtime",
            repos_path=api_data_dir / "repos.json",
            tasks_path=api_data_dir / "tasks.json",
            thresholds_path=api_data_dir / "thresholds.json",
            notifications_path=api_data_dir / "notifications.json",
            exports_dir=api_data_dir / "exports",
        )
        config = cls(
            root_dir=root,
            paths=paths,
            token_budget=TokenBudgetConfig(),
            scheduler=SchedulerConfig(),
            agent_reasoning=AgentReasoningConfig.from_env(),
            learning=LearningConfig.from_env(),
            openai=OpenAIExecutorConfig.from_env(),
            embeddings=EmbeddingConfig.from_env(),
            github=GitHubActionsConfig.from_env(),
            gitlab=GitLabCiConfig.from_env(),
            jenkins=JenkinsConfig.from_env(),
            retrieval=RetrievalConfig.from_env(),
            graph=GraphConfig.from_env(),
            runtime=RuntimeConfig.from_env(),
            security=SecurityConfig.from_env(),
            sandbox=SandboxConfig.from_env(),
            validation=ValidationConfig(),
            api=ApiServerConfig.from_env(),
        )
        config.ensure_dirs()
        return config

    def ensure_dirs(self) -> None:
        self.paths.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.paths.api_data_dir.mkdir(parents=True, exist_ok=True)
        self.paths.checkouts_dir.mkdir(parents=True, exist_ok=True)
        self.paths.reports_dir.mkdir(parents=True, exist_ok=True)
        self.paths.sandboxes_dir.mkdir(parents=True, exist_ok=True)
        self.paths.incidents_dir.mkdir(parents=True, exist_ok=True)
        self.paths.runtime_tasks_dir.mkdir(parents=True, exist_ok=True)
        self.paths.exports_dir.mkdir(parents=True, exist_ok=True)


def current_provider_snapshot(config: PlatformConfig) -> dict[str, Any]:
    return {
        "llm": {
            "provider": config.llm.provider,
            "label": config.llm.display_name,
            "model": config.llm.model,
            "base_url": config.llm.base_url,
            "compatibility_mode": config.llm.compatibility_mode,
        },
        "embedding": {
            "provider": config.embeddings.provider,
            "label": config.embeddings.display_name,
            "model": config.embeddings.model,
            "base_url": config.embeddings.base_url,
            "compatibility_mode": config.embeddings.compatibility_mode,
            "enabled": config.embeddings.enabled,
        },
    }
