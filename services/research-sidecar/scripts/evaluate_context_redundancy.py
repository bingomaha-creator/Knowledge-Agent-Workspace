"""Replay legacy and Evidence Card context loading over one persisted real Run."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from urllib.request import urlopen

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = PROJECT_ROOT / "src"
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from deepresearch_agent.agents.multi_agent.core.retrieval_result import RetrievalResult
from deepresearch_agent.agents.multi_agent.reporter.evidence_cards import EvidenceCardPipeline
from deepresearch_agent.agents.multi_agent.reporter.outline_builder import ReportOutline, SectionOutline
from deepresearch_agent.context.tokens import count_tokens


def _get_json(url: str) -> dict:
    with urlopen(url, timeout=30) as response:  # noqa: S310 - caller supplies local API
        return json.load(response)


def _as_result(item: dict) -> RetrievalResult:
    metadata = dict(item.get("metadata") or {})
    metadata.update(
        source_id=item.get("source_id") or metadata.get("source_id") or item["evidence_id"],
        source_type=metadata.get("source_type") or "webpage",
        title=item.get("title") or metadata.get("title"),
        content_hash=item.get("content_hash") or metadata.get("content_hash"),
        confidence=float(metadata.get("confidence") or item.get("score") or 0.5),
    )
    return RetrievalResult(
        result_id=item["evidence_id"],
        granularity="Chunk",
        evidence=item.get("summary") or "",
        metadata=metadata,
        source="custom",
        source_mode=item.get("source_mode") or "web",
        score=float(item.get("score") or 0.5),
    )


def evaluate(*, api_base: str, run_id: str, section_count: int) -> dict:
    payload = _get_json(f"{api_base.rstrip('/')}/runs/{run_id}/evidence")
    results_by_id = {
        item["evidence_id"]: _as_result(item)
        for item in payload.get("items", [])
    }
    results = list(results_by_id.values())
    pipeline = EvidenceCardPipeline(
        card_max_tokens=200,
        section_token_budget=12_000,
        batch_budget_ratio=0.70,
        digest_max_tokens=600,
        max_cards_per_section_call=8,
    )
    cards, _ = pipeline.build_cards(results)
    outline = ReportOutline(
        report_type="long_document",
        title="上下文冗余重放",
        sections=[
            SectionOutline(
                section_id=f"section_{index}",
                title=f"研究章节 {index}",
                summary=f"研究主题、疗效、安全性、适用人群、局限与未来方向 {index}",
            )
            for index in range(1, section_count + 1)
        ],
    )
    routes = pipeline.route_cards(cards, outline)

    raw_unique_tokens = sum(count_tokens(str(item.evidence)) for item in results)
    legacy_section_tokens = [raw_unique_tokens for _ in outline.sections]
    legacy_exposure = sum(legacy_section_tokens)

    outline_preview = "\n".join(
        f"{card.evidence_id} | 主题:{','.join(card.topics[:4])} | {card.summary[:160]}"
        for card in cards
    )
    optimized_section_tokens: list[int] = []
    digest_count = 0
    covered_by_digests: set[str] = set()
    cards_by_id = {card.evidence_id: card for card in cards}
    for section in outline.sections:
        assigned = [cards_by_id[item] for item in routes[section.section_id]]
        prompt_entries, digests = pipeline.section_inputs(assigned)
        optimized_section_tokens.append(
            sum(count_tokens(str(item.evidence)) for item in prompt_entries)
        )
        digest_count += len(digests)
        covered_by_digests.update(
            evidence_id for digest in digests for evidence_id in digest.evidence_ids
        )
        if not digests:
            covered_by_digests.update(card.evidence_id for card in assigned)

    optimized_exposure = count_tokens(outline_preview) + sum(optimized_section_tokens)
    all_ids = set(results_by_id)
    return {
        "run_id": run_id,
        "evidence_count": len(results),
        "section_count": section_count,
        "raw_unique_evidence_tokens": raw_unique_tokens,
        "legacy": {
            "strategy": "full evidence repeated for every section",
            "evidence_section_assignments": len(results) * section_count,
            "context_exposure_tokens": legacy_exposure,
            "redundancy_multiple": round(legacy_exposure / max(1, raw_unique_tokens), 4),
            "max_section_evidence_tokens": max(legacy_section_tokens, default=0),
        },
        "evidence_card": {
            "strategy": "full card routing with bounded recursive digests",
            "evidence_section_assignments": sum(len(values) for values in routes.values()),
            "outline_preview_tokens": count_tokens(outline_preview),
            "section_context_tokens": optimized_section_tokens,
            "context_exposure_tokens": optimized_exposure,
            "redundancy_multiple": round(optimized_exposure / max(1, raw_unique_tokens), 4),
            "max_section_evidence_tokens": max(optimized_section_tokens, default=0),
            "digest_count": digest_count,
            "coverage_rate": round(len(covered_by_digests & all_ids) / max(1, len(all_ids)), 4),
        },
        "reduction": {
            "context_exposure": round(1 - optimized_exposure / max(1, legacy_exposure), 4),
            "cross_section_assignments": round(
                1 - sum(len(values) for values in routes.values()) / max(1, len(results) * section_count),
                4,
            ),
            "max_section_context": round(
                1 - max(optimized_section_tokens, default=0) / max(1, raw_unique_tokens),
                4,
            ),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--api-base", default="http://127.0.0.1:8000/api/v1")
    parser.add_argument("--sections", type=int, default=5)
    args = parser.parse_args()
    print(json.dumps(
        evaluate(api_base=args.api_base, run_id=args.run_id, section_count=max(1, args.sections)),
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    main()
