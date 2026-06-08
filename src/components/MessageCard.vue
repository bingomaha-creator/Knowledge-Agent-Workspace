<template>
  <article class="message-row" :class="[`message-${message.role}`]">
    <div class="avatar-dot">{{ avatar }}</div>
    <div class="message-main">
      <div class="message-meta">
        <strong>{{ roleLabel }}</strong>
        <span>{{ timeLabel }}</span>
        <span v-if="message.status === 'streaming'" class="streaming-indicator">流式输出中</span>
      </div>

      <div class="message-content" v-html="html"></div>

      <section v-if="message.tools?.length" class="tool-panel">
        <button class="source-header panel-header-button" type="button" @click="toggleTools">
          <strong>工具调用</strong>
          <span>{{ message.tools.length }} 次</span>
          <span class="panel-toggle">{{ toolsOpen ? '收起' : '展开' }}</span>
        </button>
        <article v-for="tool in message.tools" v-show="toolsOpen" :key="tool.id" class="tool-card">
          <div class="tool-topline">
            <strong>{{ tool.name }}</strong>
            <span>{{ getToolSummary(tool) }}</span>
            <span :class="['tool-status', `tool-${tool.status}`]">{{ tool.status }}</span>
          </div>
          <dl class="tool-detail-list">
            <div>
              <dt>参数</dt>
              <dd><pre>{{ JSON.stringify(tool.args, null, 2) }}</pre></dd>
            </div>
            <div v-if="tool.result">
              <dt>结果</dt>
              <dd class="tool-result">{{ tool.result }}</dd>
            </div>
          </dl>
        </article>
      </section>

      <section v-if="message.citations?.length" class="source-panel">
        <button class="source-header panel-header-button" type="button" @click="toggleSources">
          <strong>参考来源</strong>
          <span>{{ message.citations.length }} 条命中</span>
          <span class="panel-toggle">{{ sourcesOpen ? '收起' : '展开' }}</span>
        </button>
        <article v-for="citation in message.citations" v-show="sourcesOpen" :key="citation.id" class="source-card">
          <div class="source-title-line">
            <strong>{{ citation.title }}</strong>
            <span v-if="citation.score">相关度 {{ citation.score }}</span>
          </div>
          <p>{{ citation.snippet }}</p>
          <small>{{ citation.source }}</small>
        </article>
      </section>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick } from 'vue';
import { renderMarkdown } from '@/services/markdown';
import type { ChatMessage, ToolInvocation } from '@/types/chat';

type ExpandableMessage = ChatMessage & {
  sourcesOpen?: boolean;
  toolsOpen?: boolean;
};

const props = defineProps<{
  message: ChatMessage;
}>();

const expandableMessage = computed(() => props.message as ExpandableMessage);
const toolsOpen = computed(() => !!expandableMessage.value.toolsOpen);
const sourcesOpen = computed(() => !!expandableMessage.value.sourcesOpen);
const html = computed(() => renderMarkdown(props.message.content || (props.message.status === 'streaming' ? '正在思考中…' : '')));
const roleLabel = computed(() => (props.message.role === 'assistant' ? 'yuan-agent' : '你'));
const avatar = computed(() => (props.message.role === 'assistant' ? '✦' : '你'));
const timeLabel = computed(() =>
  new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(props.message.createdAt)
);

function getToolSummary(tool: ToolInvocation) {
  if (tool.name === 'retrieve_knowledge') {
    return '检索知识库';
  }
  if (tool.name === 'list_knowledge_documents') {
    return '查看文档列表';
  }
  return '已执行';
}

async function notifyLayoutChanged() {
  await nextTick();
  window.dispatchEvent(new Event('resize'));
}

function toggleTools() {
  expandableMessage.value.toolsOpen = !toolsOpen.value;
  notifyLayoutChanged();
}

function toggleSources() {
  expandableMessage.value.sourcesOpen = !sourcesOpen.value;
  notifyLayoutChanged();
}
</script>
