"""FastAPI application entry wired to the persistent Harness main chain."""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.app.api.v1 import router as api_router
from backend.app.services import ChatService, EventStreamService, RunService
from deepresearch_agent.config import settings
from deepresearch_agent.harness.errors import AppError, ErrorCode
from deepresearch_agent.persistence import Database
from deepresearch_agent.persistence.repositories import MessageRepository, RunRepository, SessionRepository
from deepresearch_agent.memory import MemoryService
from deepresearch_agent.persistence.repositories import AuditRepository, MemoryRepository
from deepresearch_agent.persistence.repositories import LearningReviewRepository, SkillRepository
from deepresearch_agent.evolution import PromotionPolicy, SkillEvaluator


def _error(request: Request, *, status_code: int, code: str, message: str, retryable: bool = False, details=None):
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message, "retryable": retryable, "details": details or {}}, "request_id": getattr(request.state, "request_id", "unknown")},
    )


def create_app(
    *, database_url: str | None = None, workflow_factory=None,
    artifact_root: str | Path | None = None, skills_root: str | Path | None = None,
    auto_resume: bool | None = None,
) -> FastAPI:
    if not settings.LOCAL_MVP_SINGLE_WORKER:
        raise RuntimeError("本地 MVP 必须设置 FASTAPI_WORKERS=1")
    database = Database(database_url or settings.APP_DATABASE_URL)
    run_service = RunService(database, workflow_factory=workflow_factory, artifact_root=artifact_root or settings.ARTIFACT_ROOT, skills_root=skills_root or settings.SKILLS_ROOT)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await database.create_schema()
        await run_service.startup_recovery(auto_resume=settings.AUTO_RESUME_RUNS if auto_resume is None else auto_resume)
        yield
        await run_service.shutdown()
        await database.close()

    app = FastAPI(title="DeepResearch HybridRAG Local MVP", version="0.4.0", lifespan=lifespan)
    app.state.database = database
    app.state.run_service = run_service
    app.state.chat_service = ChatService(
        SessionRepository(database), RunRepository(database), MessageRepository(database), run_service,
    )
    app.state.event_stream = EventStreamService(run_service.events, run_service.runs, run_service.event_bus)
    app.state.memory_service = MemoryService(
        MemoryRepository(database), AuditRepository(database),
        user_max_tokens=settings.MEMORY_USER_MAX_TOKENS,
        project_max_tokens=settings.MEMORY_PROJECT_MAX_TOKENS,
        user_max_chars=settings.MEMORY_USER_MAX_CHARS,
        project_max_chars=settings.MEMORY_PROJECT_MAX_CHARS,
    )
    skill_repository = SkillRepository(database)
    app.state.skill_services = {
        "repository": skill_repository,
        "registry": run_service.skill_registry,
        "evaluator": SkillEvaluator(skill_repository, case_runner=run_service.run_evaluation_case if workflow_factory is None else None),
        "promotion": run_service.skill_promotion if workflow_factory is None else PromotionPolicy(
            skill_repository, run_service.skill_registry, AuditRepository(database),
        ),
        "learning": run_service.skill_learning,
        "reviews": LearningReviewRepository(database),
        "events": run_service.event_bus,
        "test_mode": workflow_factory is not None,
    }
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.FRONTEND_ORIGINS), allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request.state.request_id = request.headers.get("X-Request-ID") or f"req_{uuid.uuid4().hex}"
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError):
        status_code = {
            ErrorCode.NOT_FOUND: 404, ErrorCode.CONFLICT: 409, ErrorCode.IDEMPOTENCY_CONFLICT: 409,
            ErrorCode.INVALID_SOURCE_MODE: 422, ErrorCode.TAVILY_API_KEY_MISSING: 503,
            ErrorCode.SOURCE_UNAVAILABLE: 503, ErrorCode.DATABASE_UNAVAILABLE: 503,
        }.get(exc.code, 400)
        return _error(request, status_code=status_code, code=exc.code.value, message=exc.message, retryable=exc.retryable, details=exc.details)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        return _error(request, status_code=422, code="VALIDATION_ERROR", message="请求参数校验失败", details={"errors": exc.errors()})

    @app.exception_handler(Exception)
    async def unexpected_error_handler(request: Request, exc: Exception):
        return _error(request, status_code=500, code="INTERNAL_ERROR", message="服务内部错误")

    app.include_router(api_router)
    return app


app = create_app()
