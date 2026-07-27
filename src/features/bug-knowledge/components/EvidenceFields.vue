<template>
  <div class="evidence-fields">
    <div class="evidence-fields-row">
      <label>
        <span>证据类型</span>
        <select v-model="model.type" class="workspace-filter-select">
          <option value="error">Error / Stack Trace</option>
          <option value="network">Network Error</option>
          <option value="test_failure">测试失败</option>
          <option value="code">代码上下文</option>
          <option value="environment">运行环境</option>
          <option value="reproduction">复现步骤</option>
          <option value="verification">人工验证结果</option>
          <option value="note">补充说明</option>
        </select>
      </label>
      <label v-if="model.type === 'code'">
        <span>文件名</span>
        <input v-model="metadata.fileName" maxlength="500" placeholder="src/stores/chat.ts" />
      </label>
      <label v-if="model.type === 'code'">
        <span>语言</span>
        <input v-model="metadata.language" maxlength="80" placeholder="TypeScript" />
      </label>
    </div>
    <label>
      <span>{{ contentLabel }}</span>
      <textarea
        v-model="model.content"
        data-testid="evidence-content"
        rows="8"
        maxlength="24000"
        :placeholder="guidance || placeholder"
      ></textarea>
    </label>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { BugEvidenceInput, BugEvidenceType } from '../investigation-types';

defineProps<{ guidance?: string }>();
const model = defineModel<BugEvidenceInput>({ required: true });

const metadata = computed(() => {
  if (!model.value.metadata) {
    model.value.metadata = { fileName: '', language: '', lineStart: null };
  }
  return model.value.metadata;
});

const contentLabel = computed(() => {
  const labels: Partial<Record<BugEvidenceType, string>> = {
    code: '相关代码片段',
    reproduction: '操作步骤',
    verification: '验证过程与结果'
  };
  return labels[model.value.type] || '原始内容';
});

const placeholder = computed(() => ({
  error: '粘贴完整 Error 与 Stack Trace，不必先整理字段',
  network: '粘贴请求 URL、状态码和失败响应（凭证会自动遮盖）',
  test_failure: '粘贴 Vitest、Playwright、构建或 TypeScript 失败输出',
  code: '粘贴与错误直接相关的函数或组件片段',
  environment: '例如 Vue 3.5、Chrome、开发环境',
  reproduction: '每行一个可执行步骤',
  verification: '记录执行了什么，以及观察到的支持或反驳信号',
  note: '补充与当前错误直接相关的信息'
}[model.value.type]));
</script>

<style scoped>
.evidence-fields { display: grid; gap: 12px; }
.evidence-fields-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.evidence-fields label { display: grid; gap: 6px; color: var(--muted); font-size: 0.8rem; }
.evidence-fields input, .evidence-fields select, .evidence-fields textarea { width: 100%; padding: 10px 11px; font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--panel-line); border-radius: 10px; }
.evidence-fields textarea { resize: vertical; line-height: 1.55; }
@media (max-width: 680px) { .evidence-fields-row { grid-template-columns: 1fr; } }
</style>
