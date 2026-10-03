"""Retry the latest persisted real learning review without rerunning research."""

import json
import sqlite3
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from backend.app.main import create_app


def main() -> None:
    root = Path("data/acceptance/skill-learning-real")
    with sqlite3.connect(root / "app.db") as connection:
        review_id, run_id = connection.execute(
            "select review_id,run_id from learning_review_jobs order by created_at desc limit 1"
        ).fetchone()
    app = create_app(
        database_url=f"sqlite+aiosqlite:///{(root / 'app.db').as_posix()}",
        artifact_root=root / "artifacts", skills_root=root / "skills", auto_resume=False,
    )
    with TestClient(app) as client:
        response = client.post(f"/api/v1/learning-reviews/{review_id}/retry")
        response.raise_for_status()
        review = None
        for _ in range(600):
            review = client.get(f"/api/v1/learning-reviews/{review_id}").json()
            if review["status"] in {"completed", "rejected", "failed"}:
                break
            time.sleep(0.5)
        result = {
            "run_id": run_id, "review_id": review_id, "status": review["status"],
            "proposal_decision": (review.get("proposal") or {}).get("decision"),
            "critic_decision": (review.get("critic") or {}).get("decision"),
            "validation_passed": (review.get("validation") or {}).get("passed"),
            "candidate_id": review.get("candidate_id"), "error_message": review.get("error_message"),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        assert review["status"] in {"completed", "rejected"}, result


if __name__ == "__main__":
    main()
