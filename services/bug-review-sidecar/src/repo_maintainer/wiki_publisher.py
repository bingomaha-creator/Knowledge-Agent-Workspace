"""
Wiki 发布器（Wiki Publisher）
将审核通过的 BugReviewDocument 发布为：
1. 本地 Markdown 文件（第一版：本地模拟发布）
2. 在线 Wiki API（第二版：对接 Confluence / 飞书 Wiki）

与 remote_delivery.py（WikiPublisher）的关系：
- remote_delivery.py 负责代码变更的远程交付（PR/MR）
- 本模块负责知识文档的 Wiki 发布（复盘文档归档）
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .flow_debug import flow_log


class WikiPublisherService:
    """
    Wiki 发布服务。

    Two modes:
    - local:  output to local Markdown files (default, dev)
    - remote: upstream Wiki API (future)
    """

    def __init__(
        self,
        *,
        output_dir: str | Path | None = None,
        mode: str = "local",
    ) -> None:
        self.mode = mode
        if output_dir is None:
            output_dir = Path(".wiki_output")
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def publish(
        self,
        *,
        bug_report_id: str,
        title: str,
        content: dict[str, Any] | str,
        repo_name: str = "",
        keywords: list[str] | None = None,
    ) -> dict[str, Any]:
        if self.mode == "local":
            return self._publish_local(
                bug_report_id=bug_report_id,
                title=title,
                content=content,
                repo_name=repo_name,
                keywords=keywords,
            )
        return {"status": "skipped", "message": f"Remote Wiki API not implemented (mode={self.mode})"}

    def publish_batch(self, documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for doc in documents:
            result = self.publish(
                bug_report_id=str(doc.get("bug_report_id", "unknown")),
                title=str(doc.get("title", "untitled")),
                content=doc.get("content", doc),
                repo_name=str(doc.get("repo_name", "")),
                keywords=doc.get("keywords"),
            )
            results.append(result)
        return results

    # --- local markdown ----------------------------------------------------------

    def _publish_local(
        self,
        bug_report_id: str,
        title: str,
        content: dict[str, Any] | str,
        repo_name: str = "",
        keywords: list[str] | None = None,
    ) -> dict[str, Any]:
        slug = self._slugify(title) + f"-{bug_report_id}"
        filepath = self.output_dir / f"{slug}.md"

        if isinstance(content, dict):
            markdown = self.render_markdown(title, content, repo_name, keywords)
        else:
            markdown = str(content)

        temporary = filepath.with_suffix(".md.tmp")
        temporary.write_text(markdown, encoding="utf-8")
        temporary.replace(filepath)

        flow_log("wiki.published", bug_report_id=bug_report_id, filepath=str(filepath))
        return {
            "status": "published",
            "path": str(filepath),
            "url": f"file://{filepath}",
            "message": f"Published to {filepath}",
        }

    def render_markdown(
        self,
        title: str,
        doc: dict[str, Any],
        repo_name: str,
        keywords: list[str] | None,
    ) -> str:
        lines: list[str] = []

        lines.append(f"# {title}")
        lines.append("")
        lines.append(f"> **来源仓库**: {repo_name or '(unspecified)'}  ")
        lines.append(f"> **关键词**: {', '.join(keywords or []) or '(none)'}  ")
        lines.append("")

        # Impact
        impact = doc.get("impact") or {}
        if isinstance(impact, dict):
            lines.append("## 影响评估")
            lines.append("")
            severity = impact.get('severity', 'unknown')
            lines.append(f"- **严重程度**: {'待确认' if severity == 'unknown' else severity}")
            if impact.get("scope"):
                lines.append(f"- **影响范围**: {impact['scope']}")
            if impact.get("affected_users"):
                lines.append(f"- **受影响用户**: {impact['affected_users']}")
            lines.append("")

        # Root Cause
        root_cause = doc.get("root_cause", {})
        if isinstance(root_cause, dict) and root_cause.get("content"):
            lines.append("## 根本原因")
            lines.append("")
            lines.append(root_cause["content"])
            source = root_cause.get("source", {})
            if isinstance(source, dict) and source.get("snippet"):
                lines.append("")
                lines.append(f"> **来源引用**: {source.get('location', '')}")
                lines.append("> ```")
                lines.append("> " + source["snippet"].replace("\n", "\n> "))
                lines.append("> ```")
            lines.append("")

        # Fix Solution
        fix = doc.get("fix_solution", "")
        if fix:
            lines.append("## 修复方案")
            lines.append("")
            lines.append(str(fix))
            lines.append("")

        # Prevention
        prevention = doc.get("prevention", "")
        if prevention:
            lines.append("## 预防措施")
            lines.append("")
            lines.append(str(prevention))
            lines.append("")

        # Related Modules
        modules = doc.get("related_modules", [])
        if modules:
            lines.append("## 相关模块")
            lines.append("")
            for m in modules:
                lines.append(f"- {m}")
            lines.append("")

        # Footer
        confidence = doc.get("confidence")
        lines.append("---")
        score = f"模型自评分（未校准）: {confidence:.0%}" if confidence is not None else "未提供可靠性评分"
        lines.append(f"*{score} | 审核状态: {doc.get('review_status', 'draft')}*")
        lines.append("")

        return "\n".join(lines)

    @staticmethod
    def _slugify(text: str) -> str:
        slug = text.strip().lower()
        slug = re.sub(r"[\s/\\]+", "-", slug)
        slug = re.sub(r"[^a-z0-9\-_\.]", "", slug)
        slug = re.sub(r"-{2,}", "-", slug).strip("-")
        return slug or "untitled"


def publish_bug_review_to_local(
    *,
    bug_report_id: str,
    title: str,
    review_doc: dict[str, Any],
    output_dir: str | Path = ".wiki_output",
    repo_name: str = "",
) -> dict[str, Any]:
    service = WikiPublisherService(output_dir=output_dir, mode="local")
    return service.publish(
        bug_report_id=bug_report_id,
        title=title,
        content=review_doc,
        repo_name=repo_name,
        keywords=review_doc.get("keywords", []),
    )
