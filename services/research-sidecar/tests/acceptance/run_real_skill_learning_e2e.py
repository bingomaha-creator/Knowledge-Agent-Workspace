"""One real plan-execute-report + Web Run followed by the built-in learning review."""

import json
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from backend.app.main import create_app


def main() -> None:
    root = Path("data/acceptance/skill-learning-real")
    root.mkdir(parents=True, exist_ok=True)
    app = create_app(
        database_url=f"sqlite+aiosqlite:///{(root / 'app.db').as_posix()}",
        artifact_root=root / "artifacts", skills_root=root / "skills", auto_resume=False,
    )
    with TestClient(app) as client:
        session = client.post("/api/v1/sessions", json={"title": "Skill 内置学习真实链路"})
        session.raise_for_status()
        accepted = client.post(f"/api/v1/sessions/{session.json()['session_id']}/messages", json={
            "client_message_id": f"skill-learning-{int(time.time())}",
            "content": "研究当前主流数据库中向量检索与关键词检索的差异，请基于网页证据给出结构清晰、有引用的简要报告。",
            "source_mode": "web", "workflow_mode": "plan_execute_report", "report_type": "brief",
        })
        accepted.raise_for_status()
        run_id = accepted.json()["run_id"]
        run = None
        for _ in range(1800):
            run = client.get(f"/api/v1/runs/{run_id}").json()
            if run["status"] in {"completed", "failed", "cancelled", "budget_exhausted"}:
                break
            time.sleep(0.5)
        evidence = client.get(f"/api/v1/runs/{run_id}/evidence").json()
        report = client.get(f"/api/v1/runs/{run_id}/report").json()
        reviews = {"items": []}
        for _ in range(600):
            reviews = client.get(f"/api/v1/runs/{run_id}/learning-reviews").json()
            if reviews["items"] and reviews["items"][0]["status"] in {"completed", "rejected", "failed"}:
                break
            time.sleep(0.5)
        review = reviews["items"][0] if reviews["items"] else None
        payload = {
            "session_id": session.json()["session_id"], "run_id": run_id,
            "run_status": run["status"], "error_code": run.get("error_code"),
            "error_message": run.get("error_message"), "evidence_count": evidence["total"],
            "source_modes": sorted({item["source_mode"] for item in evidence["items"]}),
            "contract": [{"kind": item["kind"], "passed": item["passed"]} for item in report["verification"]],
            "report_characters": len(report.get("content") or ""),
            "learning_review": None if review is None else {
                "review_id": review["review_id"], "status": review["status"],
                "proposal_decision": (review.get("proposal") or {}).get("decision"),
                "critic_decision": (review.get("critic") or {}).get("decision"),
                "validation_passed": (review.get("validation") or {}).get("passed"),
                "candidate_id": review.get("candidate_id"), "error_message": review.get("error_message"),
            },
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        assert run["status"] == "completed", payload
        assert evidence["total"] > 0 and payload["source_modes"] == ["web"], payload
        assert all(item["passed"] for item in payload["contract"] if item["kind"] in {"source_match", "citation_integrity", "claim_support", "report_consistency"}), payload
        assert review is not None and review["status"] in {"completed", "rejected"}, payload


if __name__ == "__main__":
    main()
