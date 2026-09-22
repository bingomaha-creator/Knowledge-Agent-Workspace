"""One-shot real API -> Harness -> Tavily/LLM acceptance smoke.

Run only after all offline tests pass; one invocation creates exactly one Run.
"""

import json
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.main import create_app


def main() -> None:
    root = Path("data/acceptance/phase45-real")
    root.mkdir(parents=True, exist_ok=True)
    app = create_app(
        database_url=f"sqlite+aiosqlite:///{(root / 'app.db').as_posix()}",
        artifact_root=root / "artifacts",
        auto_resume=False,
    )
    with TestClient(app) as client:
        session = client.post("/api/v1/sessions", json={"title": "阶段4-5真实链路验收"})
        session.raise_for_status()
        session_id = session.json()["session_id"]
        accepted = client.post(
            f"/api/v1/sessions/{session_id}/messages",
            json={
                "client_message_id": "phase45-real-once",
                "content": "Tavily Search 是什么？请基于当前网页资料给出简短、有引用的说明。",
                "source_mode": "web",
                "workflow_mode": "deep_research",
                "report_type": "brief",
            },
        )
        accepted.raise_for_status()
        run_id = accepted.json()["run_id"]
        run = None
        for _ in range(600):
            run = client.get(f"/api/v1/runs/{run_id}").json()
            if run["status"] in {"completed", "failed", "cancelled", "budget_exhausted"}:
                break
            time.sleep(0.1)
        evidence = client.get(f"/api/v1/runs/{run_id}/evidence").json()
        report = client.get(f"/api/v1/runs/{run_id}/report").json()
        events_text = ""
        with client.stream("GET", f"/api/v1/runs/{run_id}/events") as stream:
            events_text = "".join(stream.iter_text())
        print(json.dumps({
            "session_id": session_id, "run_id": run_id, "status": run["status"],
            "error_code": run.get("error_code"), "error_message": run.get("error_message"),
            "evidence_count": evidence["total"], "source_modes": sorted({item["source_mode"] for item in evidence["items"]}),
            "contract": [{"kind": item["kind"], "passed": item["passed"]} for item in report["verification"]],
            "report_characters": len(report.get("content") or ""),
            "completed_event": "event: run.completed" in events_text,
        }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
