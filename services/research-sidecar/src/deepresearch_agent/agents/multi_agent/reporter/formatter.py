"""
引用格式化模块
"""
from typing import Iterable, List

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage

from deepresearch_agent.config.prompts import CITATION_FORMAT_PROMPT
from deepresearch_agent.models.get_models import get_llm_model
from deepresearch_agent.agents.multi_agent.core.retrieval_result import RetrievalResult


class CitationFormatter:
    """
    引用格式化器，将RetrievalResult转换成符合要求的引用列表
    """

    def __init__(self, llm: BaseChatModel | None = None) -> None:
        self._llm = llm or get_llm_model()

    def format_references(
        self,
        retrieval_results: Iterable[RetrievalResult],
        citation_style: str = "default",
    ) -> str:
        results = list(retrieval_results)
        serialized = [result.to_dict() for result in results]
        prompt = CITATION_FORMAT_PROMPT.format(
            retrieval_results=serialized,
            citation_style=citation_style,
        )
        message: BaseMessage = self._llm.invoke(prompt)  # type: ignore[assignment]
        content = getattr(message, "content", None) or str(message)
        provenance = []
        for result in results:
            label = "[Web]" if result.source_mode == "web" else "[私有库]"
            location = result.metadata.url or result.metadata.source_id
            title = result.metadata.title or result.metadata.source_type
            provenance.append(f"- {label} [{result.result_id}] {title}: {location}")
        provenance_block = "\n".join(provenance)
        return f"{content.strip()}\n\n### 来源追踪\n{provenance_block}".strip()
