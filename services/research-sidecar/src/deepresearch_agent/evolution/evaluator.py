"""Small deterministic paired evaluation for Skill candidates."""

from __future__ import annotations

import json
import inspect

from deepresearch_agent.persistence.repositories import SkillRepository

from .linter import SkillLinter
from .schema import SkillSpec


class SkillEvaluator:
    def __init__(self, repository: SkillRepository, *, linter: SkillLinter | None = None, case_runner=None, semantic_judge=None):
        self.repository, self.linter, self.case_runner = repository, linter or SkillLinter(), case_runner
        self.semantic_judge = semantic_judge

    async def evaluate(self, candidate_id: str, *, metric_overrides: dict | None = None, progress=None):
        candidate = await self.repository.get_candidate(candidate_id)
        if candidate is None:
            raise ValueError("Skill candidate 不存在")
        payload = json.loads(candidate.payload_json or "{}")
        spec = SkillSpec.model_validate(payload.get("spec", {}))
        lint = self.linter.lint(spec, content=payload.get("content"))
        cases = payload.get("eval_cases", [])
        metrics = {
            "contract_pass_rate": 1.0 if lint.passed and len(cases) >= 2 else 0.0,
            "active_contract_pass_rate": 1.0,
            "citation_integrity": 1.0 if lint.passed else 0.0,
            "claim_support_rate": 1.0 if lint.passed else 0.0,
            "tool_policy_violations": 0 if lint.passed else 1,
            "source_leakage": 0,
            "safety_passed": lint.passed,
            "token_estimate": len(payload.get("content", "")) // 4,
            "tool_call_estimate": len(spec.steps),
            "latency_estimate_ms": len(spec.steps) * 10,
            "cases": cases,
            "lint_errors": lint.errors,
        }
        if self.case_runner is not None:
            pairs = []
            for case_index, case in enumerate(cases):
                query = str(case.get("query") or "").strip()
                if not query:
                    continue
                common = {
                    "query": query,
                    "source_mode": case.get("source_mode") or case.get("expected_source") or spec.source_modes[0],
                    "workflow_mode": case.get("workflow_mode") or "plan_execute_report",
                }
                if progress is not None:
                    update = progress({"phase": "case_started", "case_index": case_index, "split": case.get("split", "eval"), "arm": "control", "query": query[:240]})
                    if inspect.isawaitable(update): await update
                control = self.case_runner(**common, forced_skill=None)
                treatment = self.case_runner(**common, forced_skill={
                    "name": spec.name, "version": spec.version, "content": payload.get("content", ""),
                    "source_modes": spec.source_modes, "allowed_tools": spec.allowed_tools,
                    "machine_policy": spec.machine_policy,
                })
                if inspect.isawaitable(control): control = await control
                if progress is not None:
                    update = progress({"phase": "arm_completed", "case_index": case_index, "split": case.get("split", "eval"), "arm": "control", "result": control})
                    if inspect.isawaitable(update): await update
                    update = progress({"phase": "case_started", "case_index": case_index, "split": case.get("split", "eval"), "arm": "treatment", "query": query[:240]})
                    if inspect.isawaitable(update): await update
                if inspect.isawaitable(treatment): treatment = await treatment
                if progress is not None:
                    update = progress({"phase": "arm_completed", "case_index": case_index, "split": case.get("split", "eval"), "arm": "treatment", "result": treatment})
                    if inspect.isawaitable(update): await update
                pair = {"case": case, "control": control, "treatment": treatment}
                if self.semantic_judge is not None:
                    judgement = await self.semantic_judge.judge(case=case, control=control, treatment=treatment)
                    pair["semantic_judgement"] = judgement.model_dump(mode="json")
                pairs.append(pair)
            control_pass = sum(bool(p["control"].get("completed")) for p in pairs) / len(pairs) if pairs else 0.0
            treatment_pass = sum(bool(p["treatment"].get("completed")) for p in pairs) / len(pairs) if pairs else 0.0
            metrics.update({
                "evaluation_mode": "real_replay", "real_replay": bool(pairs), "pairs": pairs,
                "active_contract_pass_rate": control_pass, "contract_pass_rate": treatment_pass,
                "citation_integrity": min((float(p["treatment"].get("citation_integrity", 0)) for p in pairs), default=0.0),
                "claim_support_rate": min((float(p["treatment"].get("claim_support", 0)) for p in pairs), default=0.0),
                "tool_policy_violations": sum(int(p["treatment"].get("tool_policy_violations", 0)) for p in pairs),
                "source_leakage": sum(int(p["treatment"].get("source_leakage", 0)) for p in pairs),
                "safety_passed": bool(pairs) and all(bool(p["treatment"].get("safety_passed", False)) for p in pairs),
                "token_delta": sum(int(p["treatment"].get("llm_tokens", 0)) - int(p["control"].get("llm_tokens", 0)) for p in pairs),
                "latency_delta_seconds": sum(float(p["treatment"].get("wall_time_seconds", 0)) - float(p["control"].get("wall_time_seconds", 0)) for p in pairs),
                "semantic_regressions": sum(bool(p.get("semantic_judgement", {}).get("treatment_regressed")) for p in pairs),
                "holdout_passed": all(
                    bool(p["treatment"].get("completed")) and not bool(p.get("semantic_judgement", {}).get("treatment_regressed"))
                    for p in pairs if p["case"].get("split") == "holdout"
                ),
            })
        metrics.update(metric_overrides or {})
        passed = (
            metrics["citation_integrity"] == 1.0 and metrics["tool_policy_violations"] == 0
            and metrics["source_leakage"] == 0 and metrics["safety_passed"]
            and metrics["contract_pass_rate"] >= metrics["active_contract_pass_rate"]
            and metrics["claim_support_rate"] >= 1.0
            and (self.case_runner is None or metrics.get("real_replay") is True)
            and metrics.get("semantic_regressions", 0) == 0
            and metrics.get("holdout_passed", True) is True
        )
        result = await self.repository.add_eval(candidate_id=candidate_id, status="passed" if passed else "failed", metrics=metrics)
        await self.repository.update_candidate_status(candidate_id, "evaluated" if passed else "rejected")
        if progress is not None:
            update = progress({"phase": "evaluation_completed", "eval_run_id": result.eval_run_id, "status": result.status, "metrics": metrics})
            if inspect.isawaitable(update): await update
        return result

