"""Read-only system evaluation endpoints."""

from fastapi import APIRouter, Depends, Query

from backend.app.dependencies import get_database
from deepresearch_agent.evaluation import EvaluationService
from deepresearch_agent.harness.errors import AppError, ErrorCode
from deepresearch_agent.persistence.repositories import RunRepository

router = APIRouter(prefix="/evaluations", tags=["evaluations"])


@router.get("/runs/{run_id}")
async def evaluate_run(
    run_id: str,
    retrieval_k: int = Query(10, ge=1, le=100),
    database=Depends(get_database),
):
    if await RunRepository(database).get(run_id) is None:
        raise AppError(ErrorCode.NOT_FOUND, "Run 不存在")
    return await EvaluationService(database).evaluate_run(run_id, retrieval_k=retrieval_k)


@router.get("/summary")
async def evaluation_summary(
    run_id: list[str] | None = Query(default=None),
    retrieval_k: int = Query(10, ge=1, le=100),
    include_runs: bool = True,
    database=Depends(get_database),
):
    """Aggregate all runs, or the repeated ``run_id`` query parameters."""
    return await EvaluationService(database).summarize(
        run_ids=run_id,
        retrieval_k=retrieval_k,
        include_runs=include_runs,
    )
