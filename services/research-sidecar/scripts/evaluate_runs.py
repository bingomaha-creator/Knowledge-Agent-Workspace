"""Export system evaluation metrics from the durable SQLite database."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys

# Keep the repository-local CLI runnable without requiring an editable install.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = PROJECT_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from deepresearch_agent.config.settings import APP_DATABASE_URL
from deepresearch_agent.evaluation import EvaluationLabels, EvaluationService
from deepresearch_agent.persistence import Database


def load_labels(path: Path | None) -> tuple[list[str], dict[str, EvaluationLabels]]:
    if path is None:
        return [], {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    cases = payload.get("cases", payload) if isinstance(payload, dict) else payload
    run_ids: list[str] = []
    labels: dict[str, EvaluationLabels] = {}
    for case in cases:
        run_id = str(case.get("run_id", "")).strip()
        if not run_id:
            continue
        run_ids.append(run_id)
        labels[run_id] = EvaluationLabels.model_validate(case.get("labels", {}))
    return run_ids, labels


async def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate persisted DeepResearch runs")
    parser.add_argument("--database-url", default=APP_DATABASE_URL)
    parser.add_argument("--labels", type=Path, help="JSON cases containing run_id and optional gold labels")
    parser.add_argument("--run-id", action="append", default=[], help="Run ID; repeat to evaluate multiple runs")
    parser.add_argument("--retrieval-k", type=int, default=10)
    parser.add_argument("--output", type=Path, help="Write JSON result to this path")
    parser.add_argument("--summary-only", action="store_true", help="Omit per-run records")
    args = parser.parse_args()

    label_run_ids, labels = load_labels(args.labels)
    selected = args.run_id or label_run_ids or None
    database = Database(args.database_url)
    try:
        result = await EvaluationService(database).summarize(
            run_ids=selected,
            labels_by_run=labels,
            retrieval_k=args.retrieval_k,
            include_runs=not args.summary_only,
        )
        rendered = json.dumps(result.model_dump(mode="json"), ensure_ascii=False, indent=2)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(rendered + "\n", encoding="utf-8")
        else:
            print(rendered)
    finally:
        await database.close()


if __name__ == "__main__":
    asyncio.run(main())
