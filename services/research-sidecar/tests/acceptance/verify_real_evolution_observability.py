"""Verify the Evolution Dashboard API against the latest real learning trace."""

import json
import sqlite3
import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from backend.app.main import create_app


def main() -> None:
    root = Path("data/acceptance/skill-learning-real")
    with sqlite3.connect(root / "app.db") as connection:
        review_id = connection.execute(
            "select review_id from learning_review_jobs order by created_at desc limit 1"
        ).fetchone()[0]
    app = create_app(
        database_url=f"sqlite+aiosqlite:///{(root / 'app.db').as_posix()}",
        artifact_root=root / "artifacts", skills_root=root / "skills", auto_resume=False,
    )
    with TestClient(app) as client:
        overview = client.get("/api/v1/evolution/overview")
        overview.raise_for_status()
        listing = client.get("/api/v1/evolution/reviews", params={"q": review_id})
        listing.raise_for_status()
        detail = client.get(f"/api/v1/evolution/reviews/{review_id}")
        detail.raise_for_status()
        payload = detail.json()
        event_types = [item["event_type"] for item in payload["timeline"]]
        result = {
            "review_id": review_id,
            "status": payload["status"],
            "model_snapshot": (payload.get("run") or {}).get("model"),
            "review_pack_episodes": len((payload.get("review_pack") or {}).get("episodes") or []),
            "proposal_decision": (payload.get("proposal") or {}).get("decision"),
            "critic_decision": (payload.get("critic") or {}).get("decision"),
            "timeline_events": event_types,
            "dashboard_review_total": overview.json()["reviews"]["total"],
            "search_hits": listing.json()["total"],
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        assert payload["status"] == "completed", result
        assert listing.json()["total"] == 1, result
        assert "learning.review_pack.built" in event_types, result
        assert "skill.proposal.created" in event_types, result
        assert "learning.review.ignored" in event_types, result


if __name__ == "__main__":
    main()
