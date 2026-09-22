from backend.app.api.v1.runs import _report_presentation


def test_legacy_budget_report_moves_full_annex_out_of_reading_flow() -> None:
    content = """# 研究报告（预算保护模式）

## 一个非常长的研究任务标题，需要在阅读界面中被安全压缩并避免破坏布局

- 第一条结论 [ev_1]
- 第二条结论 [ev_2]
- 第三条结论 [ev_3]
- 第四条结论 [ev_4]
- Skip to content Navigation Menu Loading Loading Loading 第五条网页噪声 [ev_5]

## 全量证据索引
- [ev_1] 原始网页全文
"""

    body, mode, sections = _report_presentation(content, evidence_count=5)

    assert mode == "budget_fallback"
    assert "全量证据索引" not in body
    assert "原始网页全文" not in body
    assert "第五条网页噪声" not in body
    assert "另有 1 条证据" in body
    assert "完整证据台账共 5 条" in body
    assert len(sections) == 2


def test_normal_report_is_not_compacted() -> None:
    content = "# 正常报告\n\n## 结论\n\n" + "\n".join(f"- 结论 {index} [ev_{index}]" for index in range(8))
    body, mode, _ = _report_presentation(content, evidence_count=8)
    assert mode == "normal"
    assert "结论 7" in body

