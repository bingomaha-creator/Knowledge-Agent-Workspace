<template>
  <section class="composer-shell">
    <div class="composer-toolbar">
      <div class="composer-status-group">
        <span class="status-badge">{{ ragEnabled ? 'RAG 已启用' : 'RAG 已关闭' }}</span>
        <span class="status-badge soft">{{ documentCount }} 份文档</span>
        <details class="composer-scope-picker">
          <summary>资料范围 · {{ selectedKnowledgeBaseIds.length }} 个</summary>
          <div class="composer-scope-menu">
            <label v-for="base in knowledgeBases" :key="base.id">
              <input
                type="checkbox"
                :aria-label="`检索 ${base.name}`"
                :checked="selectedKnowledgeBaseIds.includes(base.id)"
                @change="$emit('toggle-knowledge-base', base.id)"
              />
              <span><strong>{{ base.name }}</strong><small>{{ base.publishedDocumentCount }} 份可检索</small></span>
            </label>
            <small v-if="!knowledgeBases.length">暂无可用资料库</small>
          </div>
        </details>
      </div>
      <div class="composer-toolbox">
        <select
          aria-label="角色预设"
          class="composer-control"
          :disabled="disabled"
          :value="presetId"
          @change="$emit('preset', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="preset in presets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
        </select>
        <button aria-label="切换 RAG" class="tool-button" type="button" @click="$emit('toggle-rag')">
          {{ ragEnabled ? 'RAG On' : 'RAG Off' }}
        </button>
        <button
          v-if="isResponding"
          aria-label="停止输出"
          class="tool-button stop-chip"
          type="button"
          @click="$emit('stop')"
        >
          停止输出
        </button>
        <button class="tool-button" :class="[`voice-${voiceStatus}`]" :disabled="!voiceSupported" @click="$emit('voice')">
          {{ voiceButtonLabel }}
        </button>
      </div>
    </div>

    <textarea
      :value="modelValue"
      class="composer-input"
      placeholder="问问 Matthew's Workspace：请结合资料库总结当前项目的 RAG 与工具调用链路"
      @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      @keydown.enter.exact.prevent="$emit('submit')"
    />

    <div class="composer-footer">
      <p class="composer-hint">
        Enter 发送，Shift + Enter 换行
        <span v-if="voiceError"> · {{ voiceError }}</span>
      </p>
      <button class="send-action" :disabled="disabled || !modelValue.trim()" @click="$emit('submit')">
        {{ disabled ? '思考中…' : '发送' }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { VoiceStatus } from '@/composables/useSpeechRecognition';
import type { KnowledgeBase } from '@/features/knowledge/types';
import type { AgentPreset } from '@/features/chat/types';

const props = defineProps<{
  modelValue: string;
  disabled: boolean;
  isResponding: boolean;
  ragEnabled: boolean;
  documentCount: number;
  voiceSupported: boolean;
  voiceStatus: VoiceStatus;
  voiceError: string;
  knowledgeBases: KnowledgeBase[];
  selectedKnowledgeBaseIds: string[];
  presetId: string;
  presets: AgentPreset[];
}>();

defineEmits<{
  'update:modelValue': [value: string];
  submit: [];
  voice: [];
  'toggle-knowledge-base': [id: string];
  preset: [id: string];
  'toggle-rag': [];
  stop: [];
}>();

const voiceButtonLabel = computed(() => {
  if (!props.voiceSupported) return '语音不可用';
  if (props.voiceStatus === 'recording') return '停止录音';
  if (props.voiceStatus === 'processing') return '识别中';
  return '语音输入';
});
</script>
