"""Version 1 API router."""

from fastapi import APIRouter

from .cache import router as cache_router
from .evaluations import router as evaluations_router
from .health import router as health_router
from .learning import router as learning_router
from .runs import router as runs_router
from .sessions import router as sessions_router

router = APIRouter(prefix="/api/v1")
router.include_router(health_router)
router.include_router(sessions_router)
router.include_router(runs_router)
router.include_router(learning_router)
router.include_router(cache_router)
router.include_router(evaluations_router)
