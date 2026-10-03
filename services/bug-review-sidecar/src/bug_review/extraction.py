import json
import os
import re
from repo_maintainer.config import OpenAIExecutorConfig, SandboxConfig
from repo_maintainer.llm_executor import OpenAIPatchExecutor
from repo_maintainer.models import BugReport
from .github import ReviewError, select_sources

class QwenExtractor:
    def __init__(self):
        self.executor = OpenAIPatchExecutor(OpenAIExecutorConfig(
            provider='qwen', display_name='Qwen', api_key=os.getenv('QWEN_API_KEY'), api_key_env='QWEN_API_KEY',
            base_url=os.getenv('QWEN_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
            model=os.getenv('QWEN_MODEL', 'qwen-plus'), timeout_seconds=90,
            max_output_tokens=6000, compatibility_mode='openai_compatible_chat'), SandboxConfig.from_env())

    def generate(self, material):
        if not self.executor.is_configured():
            raise ReviewError('MODEL_NOT_CONFIGURED', '请在后端配置现有 QWEN_API_KEY。', 503)
        # The persisted snapshot records precisely which source slices reached the model.
        context_tokens = int(os.getenv("QWEN_CONTEXT_WINDOW_TOKENS", "32768"))
        budget = min(44000, max(1000, context_tokens - 8500))
        sources = material['sources']
        selected = select_sources(sources, budget)
        gaps = [source['id'] + ' 在模型上下文中截断。' for source, kept in zip(sources, selected)
                if len(source['text']) != len(kept['text'])]
        material['model_sources'] = selected
        material['model_gaps'] = gaps
        report = BugReport(id='pr-review', title=material['pr']['title'], description='', logs='', source_type='pr', pr_id=str(material.get('identity', {}).get('number', '')), commit_sha=material.get('head_sha'),
                           changed_files=[f['filename'] for f in material.get('files', [])])
        try:
            document = self.executor.generate_bug_review(report, source_text=json.dumps(selected, ensure_ascii=False), max_retries=2, knowledge_context='location 必须逐字等于以下非空 source id 之一，不能使用 URL、文件名或自然语言描述：' + json.dumps([source['id'] for source in selected if source['text'].strip()], ensure_ascii=False)).to_dict()
        except Exception as error:
            # Classify known failure signals; never persist reflected provider bodies.
            text = str(error)
            status = re.search(r"HTTP (\d{3})", text)
            if status:
                message = f"Qwen 返回 HTTP {status[1]}，请检查现有模型配置、凭据或调用额度。"
            elif "Schema 校验失败" in text or "JSON" in text:
                message = "Qwen 输出不符合复盘结构，材料已保留，可重新生成。"
            elif "timed out" in text.lower() or isinstance(error, TimeoutError):
                message = "Qwen 响应超时，材料已保留，可重新生成。"
            elif "no text output" in text:
                message = "Qwen 未返回正文，材料已保留，可重新生成。"
            else:
                message = "Qwen 连接或生成失败，材料已保留，可重新生成。"
            raise ReviewError('MODEL_FAILED', message, 502)
        document['root_cause']['basis'] = document.pop('basis', 'inference')
        return document
