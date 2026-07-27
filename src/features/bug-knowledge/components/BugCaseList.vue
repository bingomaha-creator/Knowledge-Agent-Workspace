<template>
  <section class="bug-case-list" aria-label="BugCase 列表">
    <button
      v-for="bugCase in cases"
      :key="bugCase.id"
      class="bug-case-row"
      :class="{ 'bug-case-row-active': bugCase.id === selectedId }"
      type="button"
      @click="emit('select', bugCase.id)"
    >
      <span class="bug-case-row-topline">
        <strong>{{ bugCase.title }}</strong>
        <span class="bug-status" :class="`bug-status-${bugCase.reviewStatus}`">
          {{ reviewLabel(bugCase.reviewStatus) }}
        </span>
      </span>
      <span class="bug-case-row-copy">{{ bugCase.symptom }}</span>
      <span class="bug-case-row-meta">
        {{ scopeLabel(bugCase) }} · {{ bugCase.context.framework || '未标框架' }}
        <template v-if="bugCase.context.versions.length">
          {{ bugCase.context.versions.join(', ') }}
        </template>
        · {{ processingLabel(bugCase.status) }}
      </span>
    </button>

    <div v-if="!cases.length" class="bug-case-empty">
      当前筛选下没有 BugCase。
    </div>
  </section>
</template>

<script setup lang="ts">
import type {
  BugCase,
  BugProcessingStatus,
  BugProject,
  BugReviewStatus
} from '../types';

const props = defineProps<{
  cases: BugCase[];
  projects: BugProject[];
  selectedId: string;
}>();

const emit = defineEmits<{ select: [id: string] }>();

const reviewLabels: Record<BugReviewStatus, string> = {
  candidate: '待审核',
  confirmed: '已确认',
  rejected: '已拒绝'
};
const processingLabels: Record<BugProcessingStatus, string> = {
  queued: '排队中',
  processing: '建索引',
  ready: '就绪',
  failed: '处理失败'
};

function reviewLabel(status: BugReviewStatus) {
  return reviewLabels[status];
}

function processingLabel(status: BugProcessingStatus) {
  return processingLabels[status];
}

function scopeLabel(bugCase: BugCase) {
  if (bugCase.scope === 'common') return '公共库';
  return props.projects.find((project) => project.projectRef === bugCase.sourceProjectRef)?.name
    || bugCase.sourceProjectRef;
}
</script>

<style scoped>
.bug-case-list {
  display: grid;
  gap: 8px;
  align-content: start;
  max-height: 610px;
  overflow: auto;
}

.bug-case-row {
  display: grid;
  gap: 7px;
  width: 100%;
  padding: 13px;
  text-align: left;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--panel-line);
  border-radius: 14px;
}

.bug-case-row:hover,
.bug-case-row-active {
  border-color: #8ab4f8;
  background: var(--accent-soft);
}

.bug-case-row-topline {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.bug-case-row-copy,
.bug-case-row-meta {
  overflow: hidden;
  color: var(--muted);
  font-size: 0.82rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bug-status {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 0.72rem;
}

.bug-status-candidate { color: var(--warning); background: #fef3df; }
.bug-status-confirmed { color: var(--success); background: #e6f4ea; }
.bug-status-rejected { color: var(--danger); background: #fce8e6; }

.bug-case-empty {
  padding: 30px 14px;
  text-align: center;
  color: var(--muted);
  border: 1px dashed var(--panel-line);
  border-radius: 14px;
}
</style>
