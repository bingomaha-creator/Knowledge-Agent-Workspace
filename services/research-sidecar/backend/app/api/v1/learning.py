"""Phase-4 schemas and durable reads for later Memory/Skill business stages."""

import json

from fastapi import APIRouter, Depends, Query, Response, status
from pydantic import BaseModel
from sqlalchemy import func, select

from backend.app.dependencies import get_database, get_memory_service, get_skill_services
from backend.app.schemas import MemoryCreate, MemoryLifecycleUpdate
from deepresearch_agent.harness.errors import AppError, ErrorCode
from deepresearch_agent.persistence.models import (
    AuditEventModel, EvalRunModel, LearningReviewJobModel, MemoryModel, MessageModel,
    RunEventModel, RunModel, SkillCandidateModel, SkillDeploymentModel, SkillVersionModel,
)
from deepresearch_agent.memory import MemoryRejected
from deepresearch_agent.persistence.repositories import MemoryRepository
from deepresearch_agent.evolution import PromotionRejected
from deepresearch_agent.persistence.repositories import AuditRepository

router = APIRouter(tags=["learning"])


class SkillPromotionConfirmation(BaseModel):
    confirmation: str = ""


class LearnRequest(BaseModel):
    run_id: str


class SkillStageConfirmation(BaseModel):
    target_stage: str
    confirmation: str


class SkillSuspendConfirmation(BaseModel):
    reason: str
    confirmation: str


def _review_payload(item):
    return {
        "review_id": item.review_id, "run_id": item.run_id, "status": item.status,
        "policy_version": item.policy_version, "retry_count": item.retry_count,
        "revision_count": item.revision_count, "candidate_id": item.candidate_id,
        "review_pack": json.loads(item.review_pack_json or "{}"),
        "proposal": json.loads(item.proposal_json or "{}"),
        "critic": json.loads(item.critic_json or "{}"),
        "validation": json.loads(item.validation_json or "{}"),
        "error_message": item.error_message, "created_at": item.created_at,
        "updated_at": item.updated_at, "completed_at": item.completed_at,
    }


def _json(value, default=None):
    try:
        return json.loads(value or "{}")
    except (TypeError, json.JSONDecodeError):
        return {} if default is None else default


def _review_stage(item) -> str:
    return str(_json(item.checkpoint_json).get("stage") or item.status)


async def _publish(services, run_id: str, event_type: str, payload: dict):
    events = services.get("events")
    if events is not None:
        await events.publish(run_id, event_type, stage="learning", payload=payload)


@router.get("/evolution/overview")
async def evolution_overview(database=Depends(get_database)):
    async with database.sessions() as session:
        reviews = list((await session.execute(select(LearningReviewJobModel))).scalars())
        candidates = list((await session.execute(select(SkillCandidateModel))).scalars())
        versions = list((await session.execute(select(SkillVersionModel))).scalars())
        evaluations = list((await session.execute(select(EvalRunModel))).scalars())
        deployments = list((await session.execute(select(SkillDeploymentModel).where(
            SkillDeploymentModel.status == "active"
        ))).scalars())
    review_counts: dict[str, int] = {}
    for item in reviews:
        review_counts[item.status] = review_counts.get(item.status, 0) + 1
    candidate_counts: dict[str, int] = {}
    for item in candidates:
        candidate_counts[item.status] = candidate_counts.get(item.status, 0) + 1
    version_counts: dict[str, int] = {}
    for item in versions:
        version_counts[item.status] = version_counts.get(item.status, 0) + 1
    eval_counts: dict[str, int] = {}
    token_delta = latency_delta = 0.0
    real_eval_count = 0
    for item in evaluations:
        eval_counts[item.status] = eval_counts.get(item.status, 0) + 1
        metrics = _json(item.metrics_json)
        if metrics.get("real_replay"):
            real_eval_count += 1
            token_delta += float(metrics.get("token_delta", 0) or 0)
            latency_delta += float(metrics.get("latency_delta_seconds", 0) or 0)
    return {
        "reviews": {"total": len(reviews), "by_status": review_counts},
        "candidates": {"total": len(candidates), "by_status": candidate_counts},
        "evaluations": {"total": len(evaluations), "by_status": eval_counts, "real_replay": real_eval_count},
        "versions": {"total": len(versions), "by_status": version_counts},
        "deployments": {"active": len(deployments), "canary": sum(item.stage == "canary" for item in deployments)},
        "impact": {
            "token_delta": token_delta, "latency_delta_seconds": latency_delta,
            "evaluated_samples": real_eval_count,
        },
        "funnel": [
            {"stage": "Run Review", "count": len(reviews)},
            {"stage": "Proposed", "count": sum(bool(item.proposal_json) for item in reviews)},
            {"stage": "Critic Passed", "count": sum(_json(item.critic_json).get("decision") == "pass" for item in reviews)},
            {"stage": "Candidate", "count": len(candidates)},
            {"stage": "Evaluated", "count": sum(item.status in {"evaluated", "promoted"} for item in candidates)},
            {"stage": "Active", "count": version_counts.get("active", 0)},
        ],
    }


@router.get("/evolution/reviews")
async def evolution_reviews(
    review_status: str | None = Query(default=None, alias="status"), q: str | None = None,
    limit: int = Query(default=100, ge=1, le=500), database=Depends(get_database),
):
    async with database.sessions() as session:
        statement = (
            select(LearningReviewJobModel, RunModel, MessageModel)
            .join(RunModel, RunModel.run_id == LearningReviewJobModel.run_id)
            .join(MessageModel, MessageModel.message_id == RunModel.trigger_message_id)
            .order_by(LearningReviewJobModel.created_at.desc()).limit(limit)
        )
        rows = list((await session.execute(statement)).all())
    items = []
    for review, run, message in rows:
        proposal = _json(review.proposal_json)
        if review_status and review.status != review_status:
            continue
        if q and q.lower() not in f"{review.review_id} {review.run_id} {message.content} {review.candidate_id or ''} {proposal.get('name', '')} {proposal.get('target_skill_id', '')}".lower():
            continue
        critic = _json(review.critic_json)
        validation = _json(review.validation_json)
        items.append({
            "review_id": review.review_id, "run_id": review.run_id,
            "goal": message.content[:500], "workflow_mode": run.workflow_mode,
            "source_mode": run.source_mode, "run_status": run.status,
            "status": review.status, "stage": _review_stage(review),
            "decision": proposal.get("decision"), "skill_name": proposal.get("name") or proposal.get("target_skill_id"),
            "critic_decision": critic.get("decision"), "validation_passed": validation.get("passed"),
            "candidate_id": review.candidate_id, "retry_count": review.retry_count,
            "revision_count": review.revision_count, "error_message": review.error_message,
            "created_at": review.created_at, "updated_at": review.updated_at,
        })
    return {"items": items, "total": len(items)}


@router.get("/evolution/reviews/{review_id}")
async def evolution_review_detail(review_id: str, services=Depends(get_skill_services), database=Depends(get_database)):
    review = await services["reviews"].get(review_id)
    if review is None:
        raise AppError(ErrorCode.NOT_FOUND, "Learning Review 不存在")
    async with database.sessions() as session:
        run = await session.get(RunModel, review.run_id)
        message = await session.get(MessageModel, run.trigger_message_id) if run else None
        events = list((await session.execute(select(RunEventModel).where(
            RunEventModel.run_id == review.run_id
        ).order_by(RunEventModel.event_id))).scalars())
        candidate = await session.get(SkillCandidateModel, review.candidate_id) if review.candidate_id else None
        evaluation = None
        version = None
        deployments = []
        audits = []
        if candidate is not None:
            evaluation = (await session.execute(select(EvalRunModel).where(
                EvalRunModel.candidate_id == candidate.candidate_id
            ).order_by(EvalRunModel.created_at.desc()))).scalars().first()
            version = (await session.execute(select(SkillVersionModel).where(
                SkillVersionModel.name == candidate.name,
                SkillVersionModel.version == candidate.proposed_version,
            ))).scalar_one_or_none()
            if version is not None:
                deployments = list((await session.execute(select(SkillDeploymentModel).where(
                    SkillDeploymentModel.skill_version_id == version.skill_version_id
                ).order_by(SkillDeploymentModel.started_at))).scalars())
            audits = list((await session.execute(select(AuditEventModel).where(
                AuditEventModel.entity_id.in_((f"{candidate.name}:{candidate.proposed_version}", candidate.name))
            ).order_by(AuditEventModel.audit_event_id))).scalars())
    timeline = [{
        "id": f"event:{event.event_id}", "event_type": event.event_type,
        "stage": event.stage, "payload": _json(event.payload_json), "created_at": event.created_at,
    } for event in events if event.event_type.startswith(("learning.", "skill."))]
    timeline.extend({
        "id": f"audit:{item.audit_event_id}", "event_type": item.action,
        "stage": "deployment", "payload": _json(item.payload_json), "created_at": item.created_at,
    } for item in audits)
    timeline.sort(key=lambda item: (item["created_at"], item["id"]))
    payload = _review_payload(review)
    payload.update({
        "goal": message.content if message else "",
        "run": None if run is None else {
            "run_id": run.run_id, "status": run.status, "workflow_mode": run.workflow_mode,
            "source_mode": run.source_mode, "usage": _json(run.usage_json),
            "model": _json(run.model_snapshot_json), "created_at": run.created_at,
            "completed_at": run.completed_at,
        },
        "timeline": timeline,
        "candidate": None if candidate is None else {
            "candidate_id": candidate.candidate_id, "name": candidate.name,
            "version": candidate.proposed_version, "status": candidate.status,
            "payload": _json(candidate.payload_json), "created_at": candidate.created_at,
        },
        "evaluation": None if evaluation is None else {
            "eval_run_id": evaluation.eval_run_id, "status": evaluation.status,
            "metrics": _json(evaluation.metrics_json), "created_at": evaluation.created_at,
            "completed_at": evaluation.completed_at,
        },
        "version": None if version is None else {
            "skill_version_id": version.skill_version_id, "name": version.name,
            "version": version.version, "status": version.status,
            "content_hash": version.content_hash, "created_at": version.created_at,
        },
        "deployments": [{
            "deployment_id": item.deployment_id, "stage": item.stage,
            "allocation_percent": item.allocation_percent, "status": item.status,
            "metrics": _json(item.metrics_json), "started_at": item.started_at,
            "stopped_at": item.stopped_at,
        } for item in deployments],
    })
    return payload


@router.post("/skills/learn", status_code=status.HTTP_202_ACCEPTED)
async def learn_from_run(payload: LearnRequest, services=Depends(get_skill_services)):
    job = await services["learning"].enqueue_for_run(payload.run_id)
    if job is None:
        raise AppError(ErrorCode.CONFLICT, "该 Run 不满足学习条件或学习功能未启用")
    return _review_payload(job)


@router.get("/learning-reviews/{review_id}")
async def get_learning_review(review_id: str, services=Depends(get_skill_services)):
    item = await services["reviews"].get(review_id)
    if item is None:
        raise AppError(ErrorCode.NOT_FOUND, "Learning Review 不存在")
    return _review_payload(item)


@router.post("/learning-reviews/{review_id}/retry", status_code=status.HTTP_202_ACCEPTED)
async def retry_learning_review(review_id: str, services=Depends(get_skill_services)):
    try:
        item = await services["learning"].retry(review_id)
    except ValueError as exc:
        raise AppError(ErrorCode.CONFLICT, str(exc)) from exc
    if item is None:
        raise AppError(ErrorCode.NOT_FOUND, "Learning Review 不存在")
    return _review_payload(item)


@router.get("/runs/{run_id}/learning-reviews")
async def list_run_learning_reviews(run_id: str, services=Depends(get_skill_services)):
    items = await services["reviews"].list_for_run(run_id)
    return {"items": [_review_payload(item) for item in items], "total": len(items)}


@router.get("/memories")
async def list_memories(q: str | None = None, status_filter: str | None = None, target: str | None = None, database=Depends(get_database)):
    if q:
        items = await MemoryRepository(database).search(q, status=status_filter, limit=100)
        if target:
            items = [item for item in items if (item.target or item.scope) == target]
    else:
        async with database.sessions() as session:
            statement = select(MemoryModel).where(MemoryModel.deleted_at.is_(None))
            if status_filter:
                statement = statement.where(MemoryModel.status == status_filter)
            if target:
                statement = statement.where((MemoryModel.target == target) | ((MemoryModel.target.is_(None)) & (MemoryModel.scope == target)))
            items = list((await session.execute(statement.order_by(MemoryModel.updated_at.desc()).limit(100))).scalars())
    return {"items": [
        {"memory_id": item.memory_id, "target": item.target or item.scope, "scope": item.target or item.scope, "kind": item.kind,
         "content": item.content, "provenance_refs": json.loads(item.provenance_json or "[]"), "confidence": item.confidence,
         "valid_from": item.valid_from, "expires_at": item.expires_at, "supersedes": item.supersedes,
         "status": item.status, "created_by": item.created_by, "created_at": item.created_at, "updated_at": item.updated_at}
        for item in items
    ], "total": len(items)}


@router.get("/memories/capacity")
async def memory_capacity(memory_service=Depends(get_memory_service)):
    return {"targets": await memory_service.capacities()}


@router.post("/memories", status_code=status.HTTP_201_CREATED)
async def create_memory(payload: MemoryCreate, memory_service=Depends(get_memory_service)):
    try:
        item = await memory_service.create_candidate(
            target=payload.target, content=payload.content, kind=payload.kind,
            provenance_refs=payload.provenance_refs, created_by="user",
            activate=payload.activate,
        )
    except MemoryRejected as exc:
        raise AppError(ErrorCode.CONFLICT, str(exc)) from exc
    return memory_service.serialize(item)


@router.patch("/memories/{memory_id}")
async def patch_memory(memory_id: str, payload: MemoryLifecycleUpdate, memory_service=Depends(get_memory_service)):
    try:
        item = await memory_service.update(memory_id, content=payload.content, status=payload.status, expires_at=payload.expires_at)
    except MemoryRejected as exc:
        raise AppError(ErrorCode.CONFLICT, str(exc)) from exc
    if item is None:
        raise AppError(ErrorCode.NOT_FOUND, "Memory 不存在")
    return memory_service.serialize(item)


@router.delete("/memories/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_memory(memory_id: str, memory_service=Depends(get_memory_service)):
    if not await memory_service.delete(memory_id):
        raise AppError(ErrorCode.NOT_FOUND, "Memory 不存在")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/skills")
async def list_skills(database=Depends(get_database)):
    async with database.sessions() as session:
        versions = list((await session.execute(select(SkillVersionModel).order_by(SkillVersionModel.name, SkillVersionModel.created_at.desc()))).scalars())
        candidates = list((await session.execute(
            select(SkillCandidateModel)
            .where(SkillCandidateModel.status.in_(("candidate", "evaluated")))
            .order_by(SkillCandidateModel.created_at.desc())
        )).scalars())
    return {
        "versions": [{"skill_version_id": item.skill_version_id, "name": item.name, "version": item.version, "status": item.status, "source_run_ids": json.loads(item.source_run_ids_json or "[]"), "created_at": item.created_at} for item in versions],
        "candidates": [{"candidate_id": item.candidate_id, "run_id": item.run_id, "name": item.name, "proposed_version": item.proposed_version, "status": item.status, "payload": json.loads(item.payload_json or "{}"), "created_at": item.created_at} for item in candidates],
    }


@router.get("/skills/{name}/versions/{version}")
async def get_skill(name: str, version: str, database=Depends(get_database), services=Depends(get_skill_services)):
    async with database.sessions() as session:
        item = (await session.execute(select(SkillVersionModel).where(SkillVersionModel.name == name, SkillVersionModel.version == version))).scalar_one_or_none()
    if item is None:
        raise AppError(ErrorCode.NOT_FOUND, "Skill 版本不存在")
    candidate = await services["repository"].find_candidate(name, version)
    evaluation = await services["repository"].latest_eval(candidate.candidate_id) if candidate else None
    return {"skill_version_id": item.skill_version_id, "name": item.name, "version": item.version, "status": item.status, "content_path": item.content_path, "content_hash": item.content_hash, "content": services["registry"].read_text(item.content_path), "source_run_ids": json.loads(item.source_run_ids_json or "[]"), "evaluation": None if evaluation is None else {"eval_run_id": evaluation.eval_run_id, "status": evaluation.status, "metrics": json.loads(evaluation.metrics_json or "{}")}, "created_at": item.created_at}


@router.post("/skills/{name}/versions/{version}/evaluate")
async def evaluate_skill(name: str, version: str, services=Depends(get_skill_services), database=Depends(get_database)):
    candidate = await services["repository"].find_candidate(name, version)
    if candidate is None:
        raise AppError(ErrorCode.NOT_FOUND, "Skill candidate 不存在")
    await _publish(services, candidate.run_id, "skill.evaluation.started", {"candidate_id": candidate.candidate_id, "name": name, "version": version})
    async def progress(payload):
        await _publish(services, candidate.run_id, f"skill.evaluation.{payload.get('phase')}", {"candidate_id": candidate.candidate_id, **payload})
    result = await services["evaluator"].evaluate(candidate.candidate_id, progress=progress)
    await AuditRepository(database).append(action="skill.evaluated", entity_type="skill", entity_id=f"{name}:{version}", payload={"eval_run_id": result.eval_run_id, "status": result.status})
    return {"eval_run_id": result.eval_run_id, "candidate_id": candidate.candidate_id, "status": result.status, "metrics": json.loads(result.metrics_json or "{}")}


@router.post("/skills/{name}/versions/{version}/promote")
async def promote_skill(name: str, version: str, approval: SkillPromotionConfirmation | None = None, services=Depends(get_skill_services)):
    approved = bool(approval and approval.confirmation == f"PROMOTE {name}@{version}") or services.get("test_mode") is True
    try:
        item = await services["promotion"].promote(name=name, version=version, human_approved=approved)
    except PromotionRejected as exc:
        raise AppError(ErrorCode.CONFLICT, str(exc)) from exc
    candidate = await services["repository"].find_candidate(name, version)
    if candidate is not None:
        await _publish(services, candidate.run_id, "skill.shadow_started", {"candidate_id": candidate.candidate_id, "name": name, "version": version})
    return {"accepted": True, "name": name, "version": item.version, "status": item.status}


@router.get("/skills/candidates/{candidate_id}")
async def get_skill_candidate(candidate_id: str, services=Depends(get_skill_services)):
    candidate = await services["repository"].get_candidate(candidate_id)
    if candidate is None:
        raise AppError(ErrorCode.NOT_FOUND, "Skill candidate 不存在")
    evaluation = await services["repository"].latest_eval(candidate.candidate_id)
    payload = json.loads(candidate.payload_json or "{}")
    review = await services["reviews"].get(str(payload.get("review_id"))) if payload.get("review_id") else None
    return {
        "candidate_id": candidate.candidate_id, "run_id": candidate.run_id,
        "name": candidate.name, "version": candidate.proposed_version,
        "status": candidate.status, "payload": payload,
        "review": None if review is None else _review_payload(review),
        "evaluation": None if evaluation is None else {
            "eval_run_id": evaluation.eval_run_id, "status": evaluation.status,
            "metrics": json.loads(evaluation.metrics_json or "{}"),
        },
        "created_at": candidate.created_at,
    }


@router.post("/skills/candidates/{candidate_id}/evaluate")
async def evaluate_skill_candidate(candidate_id: str, services=Depends(get_skill_services), database=Depends(get_database)):
    candidate = await services["repository"].get_candidate(candidate_id)
    if candidate is None:
        raise AppError(ErrorCode.NOT_FOUND, "Skill candidate 不存在")
    await _publish(services, candidate.run_id, "skill.evaluation.started", {"candidate_id": candidate.candidate_id, "name": candidate.name, "version": candidate.proposed_version})
    async def progress(payload):
        await _publish(services, candidate.run_id, f"skill.evaluation.{payload.get('phase')}", {"candidate_id": candidate.candidate_id, **payload})
    result = await services["evaluator"].evaluate(candidate.candidate_id, progress=progress)
    await AuditRepository(database).append(
        action="skill.evaluated", entity_type="skill",
        entity_id=f"{candidate.name}:{candidate.proposed_version}",
        payload={"candidate_id": candidate_id, "eval_run_id": result.eval_run_id, "status": result.status},
    )
    return {
        "eval_run_id": result.eval_run_id, "candidate_id": candidate.candidate_id,
        "status": result.status, "metrics": json.loads(result.metrics_json or "{}"),
    }


@router.post("/skills/candidates/{candidate_id}/promote")
async def promote_skill_candidate(candidate_id: str, approval: SkillPromotionConfirmation | None = None, services=Depends(get_skill_services)):
    candidate = await services["repository"].get_candidate(candidate_id)
    if candidate is None:
        raise AppError(ErrorCode.NOT_FOUND, "Skill candidate 不存在")
    approved = bool(approval and approval.confirmation == f"PROMOTE {candidate.name}@{candidate.proposed_version}") or services.get("test_mode") is True
    try:
        item = await services["promotion"].promote(
            name=candidate.name, version=candidate.proposed_version,
            human_approved=approved, candidate_id=candidate.candidate_id,
        )
    except PromotionRejected as exc:
        raise AppError(ErrorCode.CONFLICT, str(exc)) from exc
    await _publish(services, candidate.run_id, "skill.shadow_started", {"candidate_id": candidate_id, "name": item.name, "version": item.version})
    return {"accepted": True, "candidate_id": candidate_id, "name": item.name, "version": item.version, "status": item.status}


@router.post("/skills/{name}/rollback")
async def rollback_skill(name: str, services=Depends(get_skill_services)):
    try:
        item = await services["promotion"].rollback(name)
    except PromotionRejected as exc:
        raise AppError(ErrorCode.CONFLICT, str(exc)) from exc
    return {"accepted": True, "name": name, "version": item.version, "status": item.status}


@router.post("/skills/{name}/versions/{version}/deploy")
async def deploy_skill_stage(name: str, version: str, payload: SkillStageConfirmation, services=Depends(get_skill_services)):
    expected = f"ADVANCE {name}@{version} TO {payload.target_stage}"
    try:
        item = await services["promotion"].advance(
            name=name, version=version, target_stage=payload.target_stage,
            human_approved=payload.confirmation == expected,
        )
    except PromotionRejected as exc:
        raise AppError(ErrorCode.CONFLICT, str(exc)) from exc
    candidate = await services["repository"].find_candidate(name, version)
    if candidate is not None:
        event_type = "skill.canary_started" if payload.target_stage == "canary" else "skill.activated"
        await _publish(services, candidate.run_id, event_type, {"candidate_id": candidate.candidate_id, "name": name, "version": version, "stage": payload.target_stage})
    return {"accepted": True, "name": name, "version": version, "status": item.status}


@router.post("/skills/{name}/versions/{version}/suspend")
async def suspend_skill(name: str, version: str, payload: SkillSuspendConfirmation, services=Depends(get_skill_services)):
    if payload.confirmation != f"SUSPEND {name}@{version}":
        raise AppError(ErrorCode.CONFLICT, "必须输入精确的暂停确认短语")
    try:
        item = await services["promotion"].suspend(name=name, version=version, reason=payload.reason)
    except PromotionRejected as exc:
        raise AppError(ErrorCode.CONFLICT, str(exc)) from exc
    candidate = await services["repository"].find_candidate(name, version)
    if candidate is not None:
        await _publish(services, candidate.run_id, "skill.suspended", {"candidate_id": candidate.candidate_id, "name": name, "version": version, "reason": payload.reason})
    return {"accepted": True, "name": name, "version": version, "status": item.status}
