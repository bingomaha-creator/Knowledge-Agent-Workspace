from deepresearch_agent.harness.contracts import SourceMode
from types import SimpleNamespace

from deepresearch_agent.harness.report_safety import add_inline_citations, citation_evidence_ids, has_internal_material, sanitize_report
from deepresearch_agent.harness.verifiers.deterministic import DeterministicVerifiers


def evidence(evidence_id: str, source_id: str = "doc-1") -> dict:
    return {
        "evidence_id": evidence_id,
        "source_mode": "graphrag",
        "source_id": source_id,
        "metadata_json": "{}",
    }


def test_sanitize_report_removes_reasoning_and_internal_contract() -> None:
    raw = "<think># SYSTEM CONTRACT\nsecret\n</think>\n# 深度研究报告\n\n可见结论。"
    cleaned = sanitize_report(raw)
    assert cleaned == "# 深度研究报告\n\n可见结论。"
    assert not has_internal_material(cleaned)


def test_inline_citations_cover_first_claim_with_two_sources() -> None:
    report = add_inline_citations("# 报告\n\n这是一个需要证据支持的完整结论。", ["ev_a", "ev_b"])
    assert "[ev_a] [ev_b]" in report


def test_inline_citations_do_not_decorate_limitation_section() -> None:
    report = add_inline_citations("# 报告\n\n这是一个需要证据支持的完整结论。\n\n## 局限\n\n当前材料有限，不能覆盖全部细节。", ["ev_a"])
    assert "完整结论。 [ev_a]" in report
    assert "覆盖全部细节。 [ev_a]" not in report


def test_citations_stay_with_strongest_authority_tier() -> None:
    official = SimpleNamespace(result_id="ev_official", score=0.7, metadata=SimpleNamespace(domain="docs.brand.com", extra={"authority_rank": 3}))
    secondary = SimpleNamespace(result_id="ev_secondary", score=0.9, metadata=SimpleNamespace(domain="docs.other.com", extra={"authority_rank": 2}))
    assert citation_evidence_ids([secondary, official]) == ["ev_official"]


def test_verifier_rejects_null_consistency_and_uncited_claims() -> None:
    report = "# 报告\n\n这是第一条有引用的完整结论 [ev_a]\n\n这是第二条没有引用的完整结论。\n\n## 局限\n\n来源有限。"
    verifier = DeterministicVerifiers(
        run_id="run-1", source_mode=SourceMode.GRAPHRAG,
        report=report, evidence=[evidence("ev_a")],
    )
    assert verifier.citation_integrity().passed is False
    assert verifier.claim_support().passed is False
    assert verifier.report_consistency(None).passed is False


def test_verifier_uses_only_cited_sources_for_diversity() -> None:
    report = "# 报告\n\n这是一个有来源支持的完整结论 [ev_a]"
    verifier = DeterministicVerifiers(
        run_id="run-1", source_mode=SourceMode.GRAPHRAG, report=report,
        evidence=[evidence("ev_a", "doc-1"), evidence("ev_b", "doc-2")],
    )
    assert verifier.source_diversity().passed is False


def test_graphrag_source_diversity_counts_documents_not_chunks() -> None:
    same_document = [
        {**evidence("ev_a", "chunk-1"), "metadata_json": '{"extra":{"document_id":"architecture.md"}}'},
        {**evidence("ev_b", "chunk-2"), "metadata_json": '{"extra":{"document_id":"architecture.md"}}'},
    ]
    report = "# 报告\n\n第一条结论有证据支持 [ev_a]\n\n第二条结论也有证据支持 [ev_b]"

    verifier = DeterministicVerifiers(
        run_id="run-1", source_mode=SourceMode.GRAPHRAG,
        report=report, evidence=same_document,
    )

    assert verifier.source_diversity().passed is False
