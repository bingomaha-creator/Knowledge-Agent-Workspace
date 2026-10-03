from deepresearch_agent.harness.contracts import SourceMode
from types import SimpleNamespace
import pytest

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


def test_list_group_label_is_not_a_claim_but_its_uncited_child_is() -> None:
    report = "# 报告\n\n- **两条不能违反的依赖约束**：\n  1. 禁止 UI 导入业务 Feature [ev_a]。\n  2. 禁止 Service 导入 React 或 Store。"
    verifier = DeterministicVerifiers(run_id="run-1", source_mode=SourceMode.GRAPHRAG,
        report=report, evidence=[evidence("ev_a")])
    actual = verifier.citation_integrity().observed["actual"]
    assert actual["uncited_claims"] == ["2. 禁止 Service 导入 React 或 Store。"]
    assert verifier.claim_support().observed["actual"] == {"claims": 2, "supported": 1}
    # A standalone bold statement must not be exempted merely for ending in a colon.
    verifier.report = "# 报告\n\n**服务层禁止读取任何页面状态**："
    assert verifier.citation_integrity().passed is False


@pytest.mark.parametrize("report,passed", [
    ("1. **页面只负责路由页面的组装。**\n   > pages 只负责路由页面组装。 [ev_a]", True),
    ("这是一个需要原文支持的完整结论。\n> 第一段原文说明职责。\n> 第二段原文提供依据。 [ev_a]", True),
    ("这是一个没有证据支持的完整结论。\n\n> 另一段材料虽然带引用。 [ev_a]", False),
    ("1. 这是第一条没有证据支持的结论。\n2. 这是第二条带有引用的结论。 [ev_a]", False),
    ("这是一个需要原文支持的完整结论。\n> 引用了本轮不存在的材料。 [ev_foreign]", False),
    ("这是一个没有引用支持的完整结论。\n## 其他内容\n> 另一节的材料不能向前归属。 [ev_a]", False),
    ("这是一个需要原文支持的完整结论。\n> 紧邻原文明确说明该结论。 [ev_a]\n这是另一条没有证据支持的结论。", False),
])
def test_verifier_treats_only_adjacent_blockquote_as_claim_unit(report, passed) -> None:
    verifier = DeterministicVerifiers(run_id="run-1", source_mode=SourceMode.GRAPHRAG,
        report="# 报告\n\n" + report, evidence=[evidence("ev_a")])
    assert verifier.citation_integrity().passed is passed
    assert verifier.claim_support().passed is passed


@pytest.mark.parametrize("report,passed", [
    ('1. **页面只负责路由页面组装**：\n   “pages 只负责路由页面组装。”\n   [ev_a]', True),
    ('- **页面只负责路由页面组装**：\n  原文明确限定了页面职责。 [ev_a]', True),
    ('1. **页面只负责路由页面组装**：\n\n   “pages 只负责路由页面组装。” [ev_a]', False),
    ('1. **页面只负责路由页面组装**：\n2. 另一个结论只能引用自己的材料。 [ev_a]', False),
    ('1. **页面只负责路由页面组装**：\n   - 子条目有自己的原文引用。 [ev_a]', False),
    ('1. **页面只负责路由页面组装**：\n   ## 另一个章节\n   原文不能越过标题借给前一条。 [ev_a]', False),
    ('1. **页面只负责路由页面组装**：\n   原文的引用不属于本轮。 [ev_foreign]', False),
])
def test_verifier_groups_only_continuations_of_the_same_list_item(report, passed):
    verifier = DeterministicVerifiers(run_id="run-1", source_mode=SourceMode.GRAPHRAG,
        report="# 报告\n\n" + report, evidence=[evidence("ev_a")])
    assert verifier.citation_integrity().passed is passed
    assert verifier.claim_support().passed is passed
