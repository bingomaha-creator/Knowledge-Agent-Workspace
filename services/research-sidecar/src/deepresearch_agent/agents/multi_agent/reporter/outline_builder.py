"""
纲要生成模块

根据PlanSpec与执行证据构建结构化报告纲要
"""
from typing import List, Dict, Any, Optional
import logging

from pydantic import BaseModel, Field
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage

from deepresearch_agent.config.prompts import OUTLINE_PROMPT, OUTLINE_SYSTEM_PROMPT
from deepresearch_agent.config.settings import (
    LLM_MAX_TOKENS,
    OPENAI_BASE_URL,
    OPENAI_LLM_MODEL,
)
from deepresearch_agent.models.bailian_embeddings import is_bailian_compatible_url
from deepresearch_agent.models.get_models import get_llm_model
from deepresearch_agent.agents.multi_agent.tools.json_parser import parse_json_text

_LOGGER = logging.getLogger(__name__)
_OUTLINE_RETRY_MAX_TOKENS = 4000
_OUTLINE_RETRY_INSTRUCTION = (
    "\n\n重要：不要输出分析、推理过程或 Markdown 代码围栏；"
    "直接输出一个简洁且完整的 JSON 对象。"
)


class SectionOutline(BaseModel):
    """
    单个章节纲要信息
    """
    section_id: str = Field(description="章节唯一标识符")
    title: str = Field(description="章节标题")
    summary: str = Field(description="章节摘要说明")
    evidence_ids: List[str] = Field(default_factory=list, description="章节引用的证据ID列表")
    estimated_words: int = Field(default=400, description="预估字数")


class ReportOutline(BaseModel):
    """
    报告纲要结构
    """
    report_type: str = Field(description="报告类型 short_answer | long_document")
    title: str = Field(description="报告标题")
    abstract: Optional[str] = Field(default=None, description="摘要（长文档特有）")
    sections: List[SectionOutline] = Field(default_factory=list, description="章节列表")
    total_estimated_words: Optional[int] = Field(default=None, description="预估总字数")


class OutlineBuilder:
    """
    纲要生成器，调用LLM根据证据生成结构化大纲
    """

    def __init__(self, llm: Optional[BaseChatModel] = None) -> None:
        self._llm = llm or get_llm_model()

    def build_outline(
        self,
        *,
        query: str,
        plan_summary: str,
        evidence_summary: str,
        evidence_count: int,
        report_type: str,
    ) -> ReportOutline:
        """
        核心入口：生成报告纲要
        """
        prompt = OUTLINE_PROMPT.format(
            query=query,
            plan_summary=plan_summary,
            evidence_summary=evidence_summary,
            evidence_count=evidence_count,
            report_type=report_type,
        )
        response = self._invoke_llm(prompt)
        outline_data = self._parse_response(response)
        outline = ReportOutline(**outline_data)
        _LOGGER.debug("OutlineBuilder 输出: %s", outline.model_dump())
        return outline

    def _invoke_llm(self, prompt: str) -> str:
        """调用LLM生成大纲，并对百炼 Qwen 的空输出做一次有界重试。

        SystemMessage 保持全静态，变量内容全部在 HumanMessage 中，
        服务端前缀缓存（prefix cache）可以跨轮次复用 system 前缀。
        """
        invocation_kwargs = self._structured_invocation_kwargs()
        messages: List[BaseMessage] = [
            SystemMessage(content=OUTLINE_SYSTEM_PROMPT),
            HumanMessage(content=prompt),
        ]
        message: BaseMessage = self._llm.invoke(  # type: ignore[assignment]
            messages,
            **invocation_kwargs,
        )
        content = self._message_content(message)
        if content:
            return content

        first_finish_reason = self._finish_reason(message)
        _LOGGER.warning(
            "OutlineBuilder 返回空内容，finish_reason=%s，将进行一次有界重试",
            first_finish_reason,
        )
        retry_kwargs = dict(invocation_kwargs)
        if self._uses_bailian_qwen():
            retry_kwargs["max_tokens"] = max(
                _OUTLINE_RETRY_MAX_TOKENS,
                LLM_MAX_TOKENS or 0,
            )
        retry_messages: List[BaseMessage] = [
            SystemMessage(content=OUTLINE_SYSTEM_PROMPT),
            HumanMessage(content=prompt + _OUTLINE_RETRY_INSTRUCTION),
        ]
        retry_message: BaseMessage = self._llm.invoke(  # type: ignore[assignment]
            retry_messages,
            **retry_kwargs,
        )
        retry_content = self._message_content(retry_message)
        if retry_content:
            return retry_content

        retry_finish_reason = self._finish_reason(retry_message)
        raise ValueError(
            "纲要生成连续返回空内容"
            f"，finish_reason={retry_finish_reason or first_finish_reason or 'unknown'}"
        )

    def _structured_invocation_kwargs(self) -> Dict[str, Any]:
        """只对百炼 Qwen 的结构化输出关闭 thinking。"""
        if self._uses_bailian_qwen():
            return {"extra_body": {"enable_thinking": False}}
        return {}

    def _uses_bailian_qwen(self) -> bool:
        model_name = (
            getattr(self._llm, "model_name", None)
            or getattr(self._llm, "model", None)
            or OPENAI_LLM_MODEL
            or ""
        )
        base_url = (
            getattr(self._llm, "openai_api_base", None)
            or getattr(self._llm, "base_url", None)
            or OPENAI_BASE_URL
        )
        return "qwen" in str(model_name).lower() and is_bailian_compatible_url(
            str(base_url) if base_url else None
        )

    @staticmethod
    def _message_content(message: BaseMessage) -> str:
        content = getattr(message, "content", None)
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict) and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            return "".join(parts).strip()
        return ""

    @staticmethod
    def _finish_reason(message: BaseMessage) -> Optional[str]:
        metadata = getattr(message, "response_metadata", None) or {}
        value = metadata.get("finish_reason")
        return str(value) if value else None

    def _parse_response(self, response: str) -> Dict[str, Any]:
        """
        解析LLM返回的JSON字符串
        """
        try:
            return parse_json_text(response)
        except ValueError as exc:
            _LOGGER.error("OutlineBuilder JSON解析失败: %s | 原始输出: %s", exc, response)
            raise ValueError("纲要生成结果解析失败") from exc
