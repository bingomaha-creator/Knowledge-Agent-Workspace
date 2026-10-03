from deepresearch_agent.agents.multi_agent.tools.json_parser import parse_json_text


def test_parse_json_text_ignores_thinking_object_before_fenced_payload():
    response = '<think>先检查 {not json}。</think>\n```json\n{"status": "ok", "items": [1]}\n```'

    assert parse_json_text(response) == {"status": "ok", "items": [1]}


def test_parse_json_text_returns_first_complete_object_with_trailing_object():
    response = '说明：\n{"status": "ok"}\n补充：{"debug": true}'

    assert parse_json_text(response) == {"status": "ok"}
