"""
BM25 关键词倒排索引模块（RAG 知识增强层）

基于 BM25 算法实现关键词召回，与向量语义检索互补：
- 向量检索：擅长语义相似（但可能召回语义相近但关键词不同的文档）
- BM25 检索：擅长关键词精确匹配（如特定 API 名称、错误码、函数名）
- 混合召回：两者结合后 rerank，兼顾语义和词汇精度

不依赖外部库，纯 Python 实现 BM25F 算法。
"""
from __future__ import annotations

import json
import math
import re
import sqlite3
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class BM25Document:
    """BM25 索引文档"""
    doc_id: str
    doc_type: str           # knowledge_entry / bug_report / trace
    title: str
    body: str
    keywords: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def full_text(self) -> str:
        """合并所有字段用于索引"""
        parts = [self.title]
        parts.extend(self.keywords)
        if self.body:
            parts.append(self.body)
        return " ".join(filter(None, parts))


@dataclass
class BM25SearchResult:
    """BM25 搜索结果"""
    doc_id: str
    doc_type: str
    score: float
    title: str
    metadata: dict[str, Any] = field(default_factory=dict)
    matched_terms: list[str] = field(default_factory=list)


class BM25Index:
    """
    BM25 关键词倒排索引

    实现 BM25+ 算法（BM25 的改进版本，避免词频权重为 0 的问题）：
    score(q, d) = Σ IDF(t) * (tf(t,d) * (k1+1)) / (tf(t,d) + k1*(1-b+b*|d|/avgdl)) + δ

    参数：
    - k1: 控制词频饱和度（通常 1.2-2.0）
    - b: 控制文档长度归一化（0-1）
    - delta: BM25+ 改进项
    """

    _CREATE_TABLE = """
    CREATE TABLE IF NOT EXISTS bm25_documents (
        doc_id TEXT NOT NULL,
        doc_type TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        keywords TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        PRIMARY KEY (doc_id, doc_type)
    )
    """

    _CREATE_INDEX_TABLE = """
    CREATE TABLE IF NOT EXISTS bm25_inverted_index (
        term TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        doc_type TEXT NOT NULL,
        tf INTEGER NOT NULL DEFAULT 1,
        doc_len INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (term, doc_id, doc_type)
    )
    """

    _CREATE_STATS_TABLE = """
    CREATE TABLE IF NOT EXISTS bm25_stats (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """

    def __init__(
        self,
        db_path: str | Path,
        k1: float = 1.5,
        b: float = 0.75,
        delta: float = 0.5,
    ) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.k1 = k1
        self.b = b
        self.delta = delta
        self._local = threading.local()
        self._init_db()

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
        return conn

    def _init_db(self) -> None:
        with self._conn() as conn:
            conn.execute(self._CREATE_TABLE)
            conn.execute(self._CREATE_INDEX_TABLE)
            conn.execute(self._CREATE_STATS_TABLE)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_bm25_term ON bm25_inverted_index (term)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_bm25_doc ON bm25_inverted_index (doc_id, doc_type)")

    def index_document(self, doc: BM25Document) -> None:
        """索引单个文档"""
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()

        with self._conn() as conn:
            # 先删除旧索引
            conn.execute(
                "DELETE FROM bm25_inverted_index WHERE doc_id = ? AND doc_type = ?",
                (doc.doc_id, doc.doc_type),
            )
            conn.execute(
                "INSERT OR REPLACE INTO bm25_documents VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    doc.doc_id,
                    doc.doc_type,
                    doc.title,
                    doc.body,
                    json.dumps(doc.keywords, ensure_ascii=False),
                    json.dumps(doc.metadata, ensure_ascii=False),
                    now,
                ),
            )

            # 分词并建立倒排索引
            tokens = self._tokenize(doc.full_text)
            doc_len = len(tokens)
            term_freq: dict[str, int] = {}
            for token in tokens:
                term_freq[token] = term_freq.get(token, 0) + 1

            for term, tf in term_freq.items():
                conn.execute(
                    "INSERT OR REPLACE INTO bm25_inverted_index VALUES (?, ?, ?, ?, ?)",
                    (term, doc.doc_id, doc.doc_type, tf, doc_len),
                )

        # 更新统计
        self._update_stats()

    def index_batch(self, docs: list[BM25Document]) -> None:
        """批量索引文档"""
        for doc in docs:
            self.index_document(doc)

    def remove_document(self, doc_id: str, doc_type: str) -> None:
        """从索引中删除文档"""
        with self._conn() as conn:
            conn.execute(
                "DELETE FROM bm25_documents WHERE doc_id = ? AND doc_type = ?",
                (doc_id, doc_type),
            )
            conn.execute(
                "DELETE FROM bm25_inverted_index WHERE doc_id = ? AND doc_type = ?",
                (doc_id, doc_type),
            )
        self._update_stats()

    def search(
        self,
        query: str,
        doc_types: list[str] | None = None,
        limit: int = 10,
    ) -> list[BM25SearchResult]:
        """
        BM25 关键词搜索

        Args:
            query: 搜索查询
            doc_types: 过滤文档类型（None=全部）
            limit: 返回结果数量

        Returns:
            按 BM25 分数排序的结果列表
        """
        query_terms = self._tokenize(query)
        if not query_terms:
            return []

        # 获取统计信息
        stats = self._get_stats()
        n_docs = stats.get("n_docs", 0)
        avg_doc_len = stats.get("avg_doc_len", 100.0)

        if n_docs == 0:
            return []

        # 计算每个文档的 BM25 分数
        doc_scores: dict[tuple[str, str], float] = {}
        doc_matched_terms: dict[tuple[str, str], list[str]] = {}

        for term in set(query_terms):  # 去重 term
            # 获取包含该 term 的文档列表
            rows = self._get_term_docs(term, doc_types)
            df = len(rows)  # 文档频率
            if df == 0:
                continue

            # IDF（BM25+）
            idf = math.log((n_docs - df + 0.5) / (df + 0.5) + 1)

            for row in rows:
                tf = row["tf"]
                doc_len = row["doc_len"]
                doc_key = (row["doc_id"], row["doc_type"])

                # BM25+ 分数
                tf_normalized = (tf * (self.k1 + 1)) / (
                    tf + self.k1 * (1 - self.b + self.b * doc_len / max(avg_doc_len, 1))
                ) + self.delta

                score = idf * tf_normalized
                doc_scores[doc_key] = doc_scores.get(doc_key, 0.0) + score

                if doc_key not in doc_matched_terms:
                    doc_matched_terms[doc_key] = []
                if term not in doc_matched_terms[doc_key]:
                    doc_matched_terms[doc_key].append(term)

        if not doc_scores:
            return []

        # 按分数排序，取 top-K
        sorted_docs = sorted(doc_scores.items(), key=lambda x: x[1], reverse=True)[:limit]

        # 获取文档元数据
        results: list[BM25SearchResult] = []
        for (doc_id, doc_type), score in sorted_docs:
            doc_row = self._get_document(doc_id, doc_type)
            if doc_row is None:
                continue
            try:
                metadata = json.loads(doc_row["metadata"]) if doc_row["metadata"] else {}
            except Exception:  # noqa: BLE001
                metadata = {}
            results.append(BM25SearchResult(
                doc_id=doc_id,
                doc_type=doc_type,
                score=round(score, 4),
                title=doc_row["title"],
                metadata=metadata,
                matched_terms=doc_matched_terms.get((doc_id, doc_type), []),
            ))

        return results

    def get_document_count(self) -> int:
        """获取索引文档总数"""
        row = self._conn().execute("SELECT COUNT(*) as cnt FROM bm25_documents").fetchone()
        return int(row["cnt"]) if row else 0

    def _tokenize(self, text: str) -> list[str]:
        """
        分词（中英文混合）

        中文：按字/词分割（简单 2-gram）
        英文：空格分割 + 小写化 + 去停用词
        """
        if not text:
            return []

        tokens: list[str] = []

        # 英文分词（支持驼峰拆分）
        english_text = re.sub(r"[^\u0000-\u007F]+", " ", text)
        # 驼峰拆分
        english_text = re.sub(r"([a-z])([A-Z])", r"\1 \2", english_text)
        english_words = re.findall(r"[a-zA-Z][a-zA-Z0-9]*", english_text)
        english_tokens = [w.lower() for w in english_words if len(w) >= 2]
        english_tokens = [w for w in english_tokens if w not in _ENGLISH_STOPWORDS]
        tokens.extend(english_tokens)

        # 中文分词（bigram）
        chinese_chars = re.findall(r"[\u4e00-\u9fff]", text)
        if len(chinese_chars) >= 2:
            for i in range(len(chinese_chars) - 1):
                tokens.append(chinese_chars[i] + chinese_chars[i + 1])
        elif chinese_chars:
            tokens.extend(chinese_chars)

        # 数字（版本号等）
        numbers = re.findall(r"\d+(?:\.\d+)+", text)
        tokens.extend(numbers)

        return tokens

    def _get_term_docs(
        self,
        term: str,
        doc_types: list[str] | None,
    ) -> list[sqlite3.Row]:
        if doc_types:
            placeholders = ",".join("?" for _ in doc_types)
            return self._conn().execute(
                f"SELECT * FROM bm25_inverted_index WHERE term = ? AND doc_type IN ({placeholders})",
                [term, *doc_types],
            ).fetchall()
        return self._conn().execute(
            "SELECT * FROM bm25_inverted_index WHERE term = ?",
            (term,),
        ).fetchall()

    def _get_document(self, doc_id: str, doc_type: str) -> sqlite3.Row | None:
        return self._conn().execute(
            "SELECT * FROM bm25_documents WHERE doc_id = ? AND doc_type = ?",
            (doc_id, doc_type),
        ).fetchone()

    def _update_stats(self) -> None:
        """更新索引统计信息"""
        row = self._conn().execute(
            "SELECT COUNT(*) as n_docs, AVG(doc_len) as avg_len "
            "FROM (SELECT DISTINCT doc_id, doc_type, doc_len FROM bm25_inverted_index)"
        ).fetchone()
        n_docs = int(row["n_docs"]) if row and row["n_docs"] else 0
        avg_len = float(row["avg_len"]) if row and row["avg_len"] else 0.0

        with self._conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO bm25_stats VALUES ('n_docs', ?)",
                (str(n_docs),),
            )
            conn.execute(
                "INSERT OR REPLACE INTO bm25_stats VALUES ('avg_doc_len', ?)",
                (str(avg_len),),
            )

    def _get_stats(self) -> dict[str, float]:
        rows = self._conn().execute("SELECT key, value FROM bm25_stats").fetchall()
        stats: dict[str, float] = {}
        for row in rows:
            try:
                stats[row["key"]] = float(row["value"])
            except (ValueError, TypeError):
                pass
        return stats


# 英文停用词（轻量版）
_ENGLISH_STOPWORDS = frozenset([
    "the", "a", "an", "in", "on", "at", "to", "for", "of", "and", "or",
    "but", "is", "are", "was", "were", "be", "been", "being", "have",
    "has", "had", "do", "does", "did", "will", "would", "could", "should",
    "may", "might", "it", "its", "this", "that", "these", "those", "with",
    "from", "by", "as", "not", "no", "so", "if", "then", "when", "where",
    "how", "what", "which", "who", "all", "each", "some", "any", "more",
    "one", "two", "can", "get", "use", "used", "new", "also", "than",
])


def create_knowledge_entry_document(
    entry_id: str,
    name: str,
    description: str,
    keywords: list[str],
    triggers: list[str],
    action_template: str = "",
    applicable_context: str = "",
) -> BM25Document:
    """便捷函数：将知识条目转为 BM25Document"""
    all_keywords = list(dict.fromkeys(keywords + triggers))
    body = "\n".join(filter(None, [description, action_template, applicable_context]))
    return BM25Document(
        doc_id=entry_id,
        doc_type="knowledge_entry",
        title=name,
        body=body,
        keywords=all_keywords,
    )


def create_bug_report_document(
    report_id: str,
    title: str,
    description: str,
    keywords: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> BM25Document:
    """便捷函数：将 Bug 报告转为 BM25Document"""
    return BM25Document(
        doc_id=report_id,
        doc_type="bug_report",
        title=title,
        body=description,
        keywords=keywords or [],
        metadata=metadata or {},
    )
