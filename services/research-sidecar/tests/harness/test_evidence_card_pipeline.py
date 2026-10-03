from __future__ import annotations

from deepresearch_agent.agents.multi_agent.core.retrieval_result import RetrievalResult
from deepresearch_agent.agents.multi_agent.reporter.evidence_cards import EvidenceCardPipeline
from deepresearch_agent.agents.multi_agent.reporter.outline_builder import ReportOutline, SectionOutline
from deepresearch_agent.harness.contracts import SourceMode
from deepresearch_agent.harness.verifiers.deterministic import DeterministicVerifiers


def _evidence(index: int) -> RetrievalResult:
    evidence_id = f"ev_{index:03d}"
    return RetrievalResult(
        result_id=evidence_id,
        granularity="Chunk",
        evidence=(
            f"第 {index} 项研究证据说明药物治疗效果与风险。"
            f"然而不同研究人群之间可能存在不一致，需要进一步验证。" * 8
        ),
        metadata={
            "source_id": f"https://example{index % 3}.org/article/{index}",
            "source_type": "webpage",
            "title": f"研究证据 {index}",
            "url": f"https://example{index % 3}.org/article/{index}",
            "domain": f"example{index % 3}.org",
            "content_hash": f"hash-{index}",
            "confidence": 0.9,
        },
        source="tavily_search",
        source_mode="web",
        score=0.9,
    )


def _outline() -> ReportOutline:
    return ReportOutline(
        report_type="long_document",
        title="测试报告",
        sections=[
            SectionOutline(section_id="treatment", title="治疗", summary="药物治疗效果"),
            SectionOutline(section_id="safety", title="安全性", summary="风险和局限"),
            SectionOutline(section_id="conclusion", title="结论", summary="综合证据"),
        ],
    )


def test_full_card_routing_and_recursive_digest_preserve_all_ids() -> None:
    pipeline = EvidenceCardPipeline(
        card_max_tokens=80,
        section_token_budget=1000,
        batch_budget_ratio=0.7,
        digest_max_tokens=120,
        max_cards_per_section_call=4,
    )
    cards, cache_hits = pipeline.build_cards([_evidence(index) for index in range(65)])
    routes = pipeline.route_cards(cards, _outline())

    assert cache_hits == 0
    assert len(cards) == 65
    assert {item for values in routes.values() for item in values} == {
        f"ev_{index:03d}" for index in range(65)
    }
    assert all(card.primary_section for card in cards)
    assert all(card.source_mode == "web" and card.url for card in cards)
    assert all(card.conflict_findings for card in cards)

    prompt_entries, digests = pipeline.section_inputs(cards)
    assert len(prompt_entries) <= 4
    assert digests
    assert {evidence_id for digest in digests for evidence_id in digest.evidence_ids} == {
        card.evidence_id for card in cards
    }


def test_annex_and_contract_require_exact_ledger_coverage() -> None:
    pipeline = EvidenceCardPipeline(max_cards_per_section_call=4)
    cards, _ = pipeline.build_cards([_evidence(index) for index in range(12)])
    outline = _outline()
    routes = pipeline.route_cards(cards, outline)
    annex, annex_ids = pipeline.annex(cards)
    processed = [item for values in routes.values() for item in values]
    coverage = pipeline.coverage(cards, routes, processed, annex_ids)
    ledger = [{"evidence_id": card.evidence_id} for card in cards]
    verifier = DeterministicVerifiers(
        run_id="run_cards",
        source_mode=SourceMode.WEB,
        report=annex,
        evidence=ledger,
    )

    assert coverage["passed"] is True
    assert verifier.evidence_card_coverage(coverage).passed is True

    broken = dict(coverage)
    broken["processed_ids"] = broken["processed_ids"][:-1]
    failed = verifier.evidence_card_coverage(broken)
    assert failed.passed is False
    assert failed.observed["actual"]["missing_by_stage"]["processed"]

    duplicate = dict(coverage)
    duplicate["card_count"] = duplicate["card_count"] + 1
    assert verifier.evidence_card_coverage(duplicate).passed is False


def test_card_cache_reuses_content_but_refreshes_run_identity() -> None:
    pipeline = EvidenceCardPipeline()
    original = _evidence(1)
    cards, _ = pipeline.build_cards([original])
    cached = {cards[0].content_hash: cards[0].model_dump(mode="json")}
    rerun = original.model_copy(update={"result_id": "ev_new"})

    rebuilt, hits = pipeline.build_cards([rerun], cached_by_hash=cached)

    assert hits == 1
    assert rebuilt[0].evidence_id == "ev_new"
    assert rebuilt[0].original_evidence_ref == "ev_new"
    assert rebuilt[0].source_mode == "web"
