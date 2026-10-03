"""One controlled real Run after every offline gate has passed.

Budget for one invocation: at most 3 LLM calls, 2 Tavily calls, 0 Embedding calls,
and exactly one end-to-end Run. Runtime data stays under ignored data/.
"""

import json
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.main import create_app


def main() -> None:
    root = Path("data/acceptance/phase8-real")
    root.mkdir(parents=True, exist_ok=True)
    app = create_app(
        database_url=f"sqlite+aiosqlite:///{(root / 'app.db').as_posix()}",
        artifact_root=root / "artifacts", skills_root=root / "skills", auto_resume=False,
    )
    with TestClient(app) as client:
        session = client.post("/api/v1/sessions", json={"title": "阶段8受控真实验收"})
        session.raise_for_status()
        session_id = session.json()["session_id"]
        accepted = client.post(f"/api/v1/sessions/{session_id}/messages", json={
            "client_message_id": "phase8-real-web-once",
            "content": "Tavily Search 的核心用途是什么？请用当前网页证据给出简短、有引用的说明。",
            "source_mode": "web", "workflow_mode": "deep_research", "report_type": "brief",
        })
        accepted.raise_for_status()
        run_id = accepted.json()["run_id"]
        run = None
        for _ in range(900):
            run = client.get(f"/api/v1/runs/{run_id}").json()
            if run["status"] in {"completed", "failed", "cancelled", "budget_exhausted"}:
                break
            time.sleep(0.1)
        evidence = client.get(f"/api/v1/runs/{run_id}/evidence").json()
        report = client.get(f"/api/v1/runs/{run_id}/report").json()
        memories = client.get("/api/v1/memories").json()
        skills = client.get("/api/v1/skills").json()
        print(json.dumps({
            "session_id": session_id, "run_id": run_id, "status": run["status"],
            "error_code": run.get("error_code"), "evidence_count": evidence["total"],
            "source_modes": sorted({item["source_mode"] for item in evidence["items"]}),
            "contract": [{"kind": item["kind"], "passed": item["passed"]} for item in report["verification"]],
            "report_characters": len(report.get("content") or ""),
            "memory_candidates": len(memories["items"]), "skill_candidates": len(skills["candidates"]),
            "declared_budget": {"llm_max": 3, "tavily_max": 2, "embedding_max": 0, "runs": 1},
        }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
