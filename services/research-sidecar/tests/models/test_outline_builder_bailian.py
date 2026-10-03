from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from deepresearch_agent.agents.multi_agent.reporter import outline_builder as module
from deepresearch_agent.agents.multi_agent.reporter.outline_builder import OutlineBuilder


class _FakeLLM:
    model_name = "qwen3.7-plus"

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def invoke(self, prompt, **kwargs):
        self.calls.append((prompt, kwargs))
        return self.responses.pop(0)


@pytest.fixture(autouse=True)
def _bailian_settings(monkeypatch):
    monkeypatch.setattr(
        module,
        "OPENAI_BASE_URL",
        "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    )
    monkeypatch.setattr(module, "LLM_MAX_TOKENS", 2000)


def test_outline_disables_thinking_for_bailian_qwen() -> None:
    llm = _FakeLLM([AIMessage(content='{"report_type":"short_answer"}')])

    response = OutlineBuilder(llm=llm)._invoke_llm("prompt")

    assert response == '{"report_type":"short_answer"}'
    assert llm.calls[0][1] == {"extra_body": {"enable_thinking": False}}
    # 前缀缓存形态：SystemMessage 全静态，变量内容只出现在 HumanMessage
    assert isinstance(llm.calls[0][0][0], SystemMessage)
    assert llm.calls[0][0][0].content == module.OUTLINE_SYSTEM_PROMPT
    assert isinstance(llm.calls[0][0][1], HumanMessage)
    assert llm.calls[0][0][1].content == "prompt"


def test_outline_retries_empty_length_response_once() -> None:
    llm = _FakeLLM([
        AIMessage(content="", response_metadata={"finish_reason": "length"}),
        AIMessage(content='{"report_type":"short_answer"}'),
    ])

    response = OutlineBuilder(llm=llm)._invoke_llm("prompt")

    assert response == '{"report_type":"short_answer"}'
    assert len(llm.calls) == 2
    assert llm.calls[1][1]["extra_body"] == {"enable_thinking": False}
    assert llm.calls[1][1]["max_tokens"] == 4000
    # 重试同样保持 SystemMessage 静态，追加指令进入 HumanMessage
    assert isinstance(llm.calls[1][0][0], SystemMessage)
    assert llm.calls[1][0][0].content == module.OUTLINE_SYSTEM_PROMPT
    assert "直接输出一个简洁且完整的 JSON 对象" in llm.calls[1][0][1].content


def test_outline_fails_clearly_after_bounded_retry() -> None:
    llm = _FakeLLM([
        AIMessage(content="", response_metadata={"finish_reason": "length"}),
        AIMessage(content="", response_metadata={"finish_reason": "length"}),
    ])

    with pytest.raises(ValueError, match="连续返回空内容.*finish_reason=length"):
        OutlineBuilder(llm=llm)._invoke_llm("prompt")

    assert len(llm.calls) == 2
