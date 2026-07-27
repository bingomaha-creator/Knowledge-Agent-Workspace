<template>
  <section class="memory-center memory-workspace" aria-labelledby="memory-workspace-title">
    <div class="memory-center-header">
      <div>
        <p class="section-label">Memory</p>
        <h2 id="memory-workspace-title">记忆审查</h2>
      </div>
      <div class="memory-header-actions">
        <span class="knowledge-count">{{ memories.length }} 条</span>
        <button
          type="button"
          class="primary-button compact-button"
          data-testid="new-memory"
          :aria-expanded="createOpen"
          @click="createOpen = !createOpen"
        >
          {{ createOpen ? '收起' : '新建记忆' }}
        </button>
      </div>
    </div>

    <p v-if="errorMessage" class="knowledge-inline-feedback knowledge-inline-error" data-testid="memory-error">
      {{ errorMessage }}
    </p>
    <p v-if="noticeMessage" class="knowledge-inline-feedback knowledge-inline-notice" data-testid="memory-notice">
      {{ noticeMessage }}
    </p>

    <form
      v-if="createOpen"
      class="memory-create-form"
      data-testid="memory-create-form"
      @submit.prevent="submitCreate"
    >
      <div class="memory-create-heading">
        <div>
          <strong>新建长期记忆</strong>
          <p>由你主动填写的内容会直接保存为已确认记忆。</p>
        </div>
      </div>
      <label>
        类型
        <select
          v-model="createDraft.type"
          class="workspace-filter-select"
          data-testid="memory-create-type"
          aria-label="新记忆类型"
        >
          <option v-for="type in memoryTypes" :key="type" :value="type">
            {{ typeLabel(type) }}
          </option>
        </select>
        <small>{{ typeDescription(createDraft.type) }}</small>
      </label>
      <label>
        标题
        <input
          v-model="createDraft.title"
          data-testid="memory-create-title"
          maxlength="160"
          placeholder="一句话概括这条记忆"
          aria-label="新记忆标题"
        />
      </label>
      <label>
        内容
        <textarea
          v-model="createDraft.content"
          data-testid="memory-create-content"
          rows="4"
          maxlength="8000"
          placeholder="写成脱离当前对话也能独立理解的完整陈述"
          aria-label="新记忆内容"
        ></textarea>
      </label>
      <div class="memory-card-actions">
        <button
          class="primary-button compact-button"
          type="submit"
          :disabled="creating || createSubmitted || !canCreate"
        >
          {{ creating || createSubmitted ? '保存中…' : '保存为已确认' }}
        </button>
        <button
          class="secondary-button compact-button"
          type="button"
          :disabled="creating || createSubmitted"
          @click="cancelCreate"
        >
          取消
        </button>
      </div>
    </form>

    <div class="memory-filters">
      <select v-model="statusFilter" class="workspace-filter-select" aria-label="记忆状态筛选">
        <option value="all">全部状态</option>
        <option value="candidate">待审查</option>
        <option value="confirmed">已确认</option>
        <option value="corrected">已纠正</option>
        <option value="rejected">已拒绝</option>
      </select>
      <select v-model="typeFilter" class="workspace-filter-select" aria-label="记忆类型筛选">
        <option value="all">全部类型</option>
        <option v-for="type in memoryTypes" :key="type" :value="type">
          {{ typeLabel(type) }}
        </option>
      </select>
    </div>

    <div v-if="filteredMemories.length" class="memory-list">
      <article v-for="memory in filteredMemories" :key="memory.id" class="memory-card">
        <template v-if="editingId !== memory.id">
          <div class="memory-card-topline">
            <span class="memory-type-badge">{{ typeLabel(memory.type) }}</span>
            <span :class="['memory-status-badge', `memory-status-${memory.status}`]">
              {{ statusLabel(memory.status) }}
            </span>
            <span class="memory-confidence">{{ Math.round(memory.confidence * 100) }}%</span>
            <span v-if="isFailed(memory.id)" class="memory-status-badge memory-status-rejected">操作失败</span>
          </div>
          <strong>{{ memory.title }}</strong>
          <p>{{ memory.content }}</p>
          <details v-if="memory.sourceExcerpt" class="memory-source-details">
            <summary>来源{{ memory.sourceExcerptTruncated ? '（片段已截断）' : '' }}</summary>
            <pre>{{ memory.sourceExcerpt }}</pre>
          </details>
          <div class="memory-card-actions">
            <button
              v-if="memory.status === 'candidate'"
              type="button"
              class="primary-button compact-button"
              :disabled="isBusy(memory.id)"
              @click="$emit('review', memory.id, 'confirmed')"
            >确认</button>
            <button
              v-if="memory.status === 'candidate'"
              type="button"
              class="secondary-button compact-button"
              :disabled="isBusy(memory.id)"
              @click="$emit('review', memory.id, 'rejected')"
            >拒绝</button>
            <button type="button" class="inline-link" :disabled="isBusy(memory.id)" @click="startEdit(memory)">编辑</button>
            <button
              v-if="memory.sourceConversationId"
              type="button"
              class="inline-link"
              :disabled="isBusy(memory.id)"
              @click="$emit('open-source', memory)"
            >来源会话</button>
            <button type="button" class="inline-link danger-link" :disabled="isBusy(memory.id)" @click="remove(memory)">删除</button>
          </div>
        </template>

        <form v-else class="memory-edit-form" @submit.prevent="saveEdit(memory.id)">
          <select v-model="draft.type" aria-label="记忆类型">
            <option v-for="type in memoryTypes" :key="type" :value="type">{{ typeLabel(type) }}</option>
          </select>
          <input v-model="draft.title" maxlength="100" aria-label="记忆标题" />
          <textarea v-model="draft.content" rows="4" maxlength="3000" aria-label="记忆内容"></textarea>
          <label>
            置信度 {{ Math.round(draft.confidence * 100) }}%
            <input v-model.number="draft.confidence" type="range" min="0" max="1" step="0.05" />
          </label>
          <div class="memory-card-actions">
            <button class="primary-button compact-button" type="submit">保存纠正</button>
            <button class="secondary-button compact-button" type="button" @click="editingId = ''">取消</button>
          </div>
        </form>
      </article>
    </div>
    <div v-else class="knowledge-empty">
      <p>没有符合筛选条件的记忆</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type {
  MemoryCreateInput,
  MemoryRecord,
  MemoryStatus,
  MemoryType
} from '../types';

/**
 * MemoryPanel 是长期记忆的“创建与人工审查视图”，而不是聊天记录编辑器。
 * 用户显式创建的内容直接成为 confirmed；模型提出的内容先以 candidate 进入审查队列。
 * 用户确认、拒绝或纠正后，emit 再触发 store 更新。只有 confirmed/corrected 才能被召回。
 * 组件本身不直接改写 props.memories。
 */
const props = defineProps<{
  memories: MemoryRecord[];
  busyIds: string[];
  failedIds: string[];
  creating: boolean;
  errorMessage: string;
  noticeMessage: string;
}>();
// busyIds 是 store 中的并发锁投影；对同一记忆发请求时，所有相关操作都会被禁用。
const emit = defineEmits<{
  create: [input: MemoryCreateInput];
  review: [id: string, status: 'confirmed' | 'rejected'];
  edit: [id: string, patch: Partial<MemoryRecord>];
  remove: [id: string];
  'open-source': [memory: MemoryRecord];
}>();

// 筛选条件、当前编辑项和草稿都是短命的局部 UI 状态，无需进入 Pinia 或 localStorage。
const memoryTypes: MemoryType[] = ['profile', 'preference', 'fact', 'event', 'pitfall'];
const statusFilter = ref<MemoryStatus | 'all'>('all');
const typeFilter = ref<MemoryType | 'all'>('all');
const createOpen = ref(false);
const createSubmitted = ref(false);
const editingId = ref('');
const createDraft = reactive({
  type: 'fact' as MemoryType,
  title: '',
  content: ''
});
const draft = reactive({ type: 'fact' as MemoryType, title: '', content: '', confidence: 0.5 });
const canCreate = computed(() => Boolean(createDraft.title.trim() && createDraft.content.trim()));

// 创建成功后收起并清空表单；失败时保留输入，方便用户修正后重试。
watch(() => props.noticeMessage, (notice) => {
  if (createSubmitted.value && notice === '记忆已创建并确认。') cancelCreate();
});
watch(() => props.errorMessage, (error) => {
  if (createSubmitted.value && error) createSubmitted.value = false;
});

// 筛选结果是派生状态；原始 memories 更新或任一筛选值改变都会自动重算。
const filteredMemories = computed(() =>
  props.memories.filter((memory) =>
    (statusFilter.value === 'all' || memory.status === statusFilter.value) &&
    (typeFilter.value === 'all' || memory.type === typeFilter.value)
  )
);

// 不只在按钮自身显示 loading，而是按记忆 ID 锁住同一条记忆的所有操作入口。
function isBusy(id: string) {
  return props.busyIds.includes(id);
}

function isFailed(id: string) {
  return props.failedIds.includes(id);
}

function typeLabel(type: MemoryType) {
  return { profile: '画像', preference: '偏好', fact: '事实', event: '事件', pitfall: '踩坑' }[type];
}

function typeDescription(type: MemoryType) {
  return {
    profile: '你的稳定背景，例如职业、技术方向或职责。',
    preference: '你希望助手长期遵循的表达或协作偏好。',
    fact: '项目、业务或环境中相对稳定的事实。',
    event: '带有时间属性的经历、计划或节点。',
    pitfall: '经过验证、未来可能复用的技术踩坑。'
  }[type];
}

function statusLabel(status: MemoryStatus) {
  return { candidate: '待审查', confirmed: '已确认', corrected: '已纠正', rejected: '已拒绝' }[status];
}

// 进入编辑态时复制快照到 draft；用户未保存前，props 中的持久化记忆保持不变。
function startEdit(memory: MemoryRecord) {
  editingId.value = memory.id;
  draft.type = memory.type;
  draft.title = memory.title;
  draft.content = memory.content;
  draft.confidence = memory.confidence;
}

// 提交只上报经过最小校验的 patch；成功/失败的真实收敛由 store 根据 API 结果处理。
// 此处关闭表单不等于后端已保存，全局 notice/error 会告知最终结果。
function saveEdit(id: string) {
  if (!draft.title.trim() || !draft.content.trim()) return;
  emit('edit', id, {
    type: draft.type,
    title: draft.title.trim(),
    content: draft.content.trim(),
    confidence: draft.confidence
  });
  editingId.value = '';
}

function submitCreate() {
  if (!canCreate.value || props.creating || createSubmitted.value) return;
  createSubmitted.value = true;
  emit('create', {
    type: createDraft.type,
    title: createDraft.title.trim(),
    content: createDraft.content.trim()
  });
}

function cancelCreate() {
  createSubmitted.value = false;
  createOpen.value = false;
  createDraft.type = 'fact';
  createDraft.title = '';
  createDraft.content = '';
}

// 不可逆删除在 UI 边界先要求人工确认，确认后仍只 emit ID，由 store 执行 API 与状态同步。
function remove(memory: MemoryRecord) {
  if (window.confirm(`删除记忆“${memory.title}”？此操作不可撤销。`)) {
    emit('remove', memory.id);
  }
}
</script>
