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

      <div v-if="message.role === 'user' && message.content.trim()" class="message-secondary-actions">
        <button
          data-testid="message-to-research"
          type="button"
          @click="emit('research', { question: message.content.trim(), sourceMessageId: message.id })"
        >
          转为深度研究
        </button>
        <button
          data-testid="message-to-bug-investigation"
          type="button"
          @click="emit('bug-investigation', { content: message.content.trim(), sourceMessageId: message.id })"
        >
          转为 Bug 调查
        </button>
      </div>

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

      <section v-if="contextManifest || message.run" class="answer-detail-panel">
        <button
          data-testid="answer-detail-toggle"
          class="source-header panel-header-button"
          type="button"
          :aria-expanded="answerDetailsOpen"
          @click="toggleAnswerDetails"
        >
          <strong>回答详情</strong>
          <span>{{ answerDetailSummary }}</span>
          <span class="panel-toggle">{{ answerDetailsOpen ? '收起' : '展开' }}</span>
        </button>
        <div
          v-show="answerDetailsOpen"
          data-testid="answer-detail-content"
          class="answer-detail-content"
        >
          <section v-if="contextManifest" class="answer-detail-section">
            <div class="answer-detail-section-heading">
              <strong>本轮使用的信息</strong>
            </div>
            <p class="context-usage-summary">使用了 {{ contextUsageSummary }}。</p>
            <div class="context-group-grid">
              <div v-for="group in contextGroups" :key="group.kind" class="context-group-row">
                <span class="context-group-icon" aria-hidden="true">{{ group.icon }}</span>
                <span>{{ group.label }}</span>
                <strong>{{ group.count }} {{ group.unit }}</strong>
              </div>
            </div>
            <p v-if="unusedContextSources.length" class="context-unused-summary">
              未进入本轮回答：
              <strong>{{ unusedContextSources.join('、') }}</strong>
            </p>
            <div v-if="excludedContextReasons.length" class="context-exclusion-summary">
              <strong>另有 {{ contextManifest.summary.excludedCount }} 项未采用</strong>
              <span v-for="reason in excludedContextReasons" :key="reason.reason">
                {{ reason.label }} {{ reason.count }}
              </span>
            </div>
            <div v-if="contextManifest.decisions.length" class="context-decision-details">
              <button
                data-testid="context-decisions-toggle"
                class="context-decisions-toggle"
                type="button"
                :aria-expanded="contextDecisionsOpen"
                @click="toggleContextDecisions"
              >
                {{ contextDecisionsOpen ? '收起选择说明' : '为什么使用这些信息' }}
              </button>
              <ul v-show="contextDecisionsOpen" data-testid="context-decisions-detail">
                <li
                  v-for="decision in contextDecisionRows"
                  :key="decision.candidateId"
                  :class="{ 'context-decision-excluded': decision.decision === 'excluded' }"
                >
                  <span
                    :class="decision.decision === 'included' ? 'context-included' : 'context-excluded'"
                    aria-hidden="true"
                  >
                    {{ decision.decision === 'included' ? '✓' : '–' }}
                  </span>
                  <span class="context-decision-copy">
                    <strong>{{ decision.label }}</strong>
                    <small>{{ contextReasonLabel(decision.reason) }}</small>
                    <code v-if="rawContextIdentifiersOpen">{{ decision.sourceRef.id }}</code>
                  </span>
                  <span class="context-decision-status">
                    {{ decision.decision === 'included' ? '已采用' : '未采用' }}
                  </span>
                </li>
              </ul>
              <button
                v-if="contextDecisionsOpen"
                data-testid="context-raw-identifiers-toggle"
                class="context-raw-identifiers-toggle"
                type="button"
                :aria-expanded="rawContextIdentifiersOpen"
                @click="toggleRawContextIdentifiers"
              >
                {{ rawContextIdentifiersOpen ? '隐藏技术标识' : '查看技术标识' }}
              </button>
            </div>
          </section>

          <section v-if="knowledgeEvidence" class="answer-detail-section knowledge-evidence-section">
            <div class="answer-detail-section-heading">
              <strong>资料库取证</strong>
              <span :class="['knowledge-evidence-status', `knowledge-evidence-${knowledgeEvidence.status}`]">
                {{ knowledgeEvidenceStatusLabel }}
              </span>
            </div>
            <p class="knowledge-evidence-copy">{{ knowledgeEvidenceCopy }}</p>
            <div class="knowledge-evidence-metrics" aria-label="资料库取证统计">
              <span>候选 {{ knowledgeEvidence.candidateCount }}</span>
              <span>采用 {{ knowledgeEvidence.selectedCount }}</span>
              <span>过滤 {{ knowledgeEvidence.filteredCount }}</span>
            </div>
          </section>

          <section v-if="message.run" class="answer-detail-section run-diagnostic-section">
            <button
              data-testid="run-diagnostics-toggle"
              class="answer-detail-section-heading run-diagnostics-toggle"
              type="button"
              :aria-expanded="runDiagnosticsOpen"
              @click="toggleRunDiagnostics"
            >
              <strong>技术诊断</strong>
              <span>{{ runSummary }}</span>
              <span class="panel-toggle">{{ runDiagnosticsOpen ? '收起' : '展开' }}</span>
            </button>
            <div
              v-show="runDiagnosticsOpen"
              data-testid="run-diagnostics-detail"
              class="run-timeline"
            >
              <article v-for="span in message.run.spans || []" :key="span.id" class="run-span">
                <strong>{{ runStepLabel(span.name) }}</strong>
                <span>{{ runKindLabel(span.kind) }} · {{ runStatusLabel(span.status) }}</span>
                <span>{{ formatDuration(span.durationMs) }}</span>
                <small v-if="span.inputTokens || span.outputTokens">
                  输入 {{ span.inputTokens }} · 输出 {{ span.outputTokens }} tokens
                </small>
                <small v-if="span.metadata?.contextManifest">
                  本地估算上下文
                  {{ formatTokens(span.metadata.contextManifest.estimatedInputTokens) }} /
                  {{ formatTokens(span.metadata.contextManifest.profile.inputBudgetTokens) }}
                </small>
                <small v-if="span.estimatedCost">${{ span.estimatedCost.toFixed(6) }}</small>
                <small v-if="span.errorMessage">{{ span.errorMessage }}</small>
              </article>
            </div>
          </section>
        </div>
      </section>

      <section v-if="message.memoryCandidate" class="memory-candidate-panel">
        <div class="memory-candidate-topline">
          <strong>长期记忆候选</strong>
          <span>{{ memoryTypeLabel }} · {{ memoryStatusLabel }}</span>
        </div>
        <template v-if="!memoryEditing">
          <p>{{ message.memoryCandidate.title }}</p>
          <div class="memory-candidate-content">{{ message.memoryCandidate.content }}</div>
          <div class="memory-confidence">
            置信度 {{ Math.round(message.memoryCandidate.confidence * 100) }}%
          </div>
          <details v-if="message.memoryCandidate.sourceExcerpt" class="memory-source-details">
            <summary>
              查看来源片段{{ message.memoryCandidate.sourceExcerptTruncated ? '（已截断）' : '' }}
            </summary>
            <pre>{{ message.memoryCandidate.sourceExcerpt }}</pre>
          </details>
          <div v-if="memoryReviewable" class="memory-candidate-actions">
            <button
              class="secondary-button"
              type="button"
              :disabled="memoryBusy"
              @click="emit('review-memory', message.memoryCandidate.id, 'rejected')"
            >
              拒绝
            </button>
            <button
              class="secondary-button"
              type="button"
              data-testid="edit-memory-candidate"
              :disabled="memoryBusy"
              @click="startMemoryEdit"
            >
              编辑后确认
            </button>
            <button
              class="primary-button"
              type="button"
              :disabled="memoryBusy"
              @click="emit('review-memory', message.memoryCandidate.id, 'confirmed')"
            >
              确认记忆
            </button>
          </div>
        </template>
        <form
          v-else
          class="memory-candidate-edit-form"
          data-testid="candidate-memory-form"
          @submit.prevent="submitMemoryCorrection"
        >
          <label>
            类型
            <select
              v-model="memoryDraft.type"
              data-testid="candidate-memory-type"
              aria-label="候选记忆类型"
            >
              <option v-for="type in memoryTypes" :key="type" :value="type">
                {{ memoryTypeOptionLabel(type) }}
              </option>
            </select>
          </label>
          <label>
            标题
            <input
              v-model="memoryDraft.title"
              data-testid="candidate-memory-title"
              maxlength="160"
              aria-label="候选记忆标题"
            />
          </label>
          <label>
            内容
            <textarea
              v-model="memoryDraft.content"
              data-testid="candidate-memory-content"
              rows="4"
              maxlength="8000"
              aria-label="候选记忆内容"
            ></textarea>
          </label>
          <div class="memory-candidate-actions">
            <button
              class="primary-button"
              type="submit"
              :disabled="memoryBusy || !memoryCorrectionValid"
            >
              确认并保存
            </button>
            <button
              class="secondary-button"
              type="button"
              :disabled="memoryBusy"
              @click="cancelMemoryEdit"
            >
              取消
            </button>
          </div>
        </form>
      </section>

    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue';
import { renderMarkdown } from '@/services/markdown';
import type {
  AgentSpan,
  ChatMessage,
  ContextDecisionReason,
  ContextKind,
  RunStatus,
  ToolInvocation
} from '@/features/chat/types';
import type { MemoryCorrection, MemoryType } from '@/features/memory/types';

/**
 * MessageCard 是单条消息的“可观测性聚合视图”：除了正文，它还展示工具状态、RAG 引用、
 * Agent run/span 时间线以及需要用户审查的长期记忆候选。
 *
 * message prop 的源头是 chat store。SSE 每到一个 token/tool/run 事件，store 就地更新同一消息对象，
 * 本组件的 computed 因此会连续重算，不需要自己订阅网络流。
 */

// 展开标记是纯界面状态，不属于后端 ChatMessage 契约。
// 当前实现将它们附着在消息对象上，所以组件重渲染时仍能保留展开状态。
type ExpandableMessage = ChatMessage & {
  sourcesOpen?: boolean;
  toolsOpen?: boolean;
  answerDetailsOpen?: boolean;
  contextDecisionsOpen?: boolean;
  rawContextIdentifiersOpen?: boolean;
  runDiagnosticsOpen?: boolean;
};

const props = withDefaults(defineProps<{
  message: ChatMessage;
  memoryBusyIds?: string[];
  memoryFailedIds?: string[];
}>(), {
  memoryBusyIds: () => [],
  memoryFailedIds: () => []
});

const emit = defineEmits<{
  research: [seed: { question: string; sourceMessageId: string }];
  'bug-investigation': [seed: { content: string; sourceMessageId: string }];
  'review-memory': [id: string, decision: 'confirmed' | 'rejected'];
  'correct-memory': [id: string, correction: MemoryCorrection];
  'layout-change': [];
}>();

// 消息数据从 props 单向传入；跨领域 Memory 意图通过 emits 交回 Workspace 组合。
const expandableMessage = computed(() => props.message as ExpandableMessage);
// 下面的 computed 是展开标记的布尔投影，模板无需处理 undefined。
const toolsOpen = computed(() => !!expandableMessage.value.toolsOpen);
const sourcesOpen = computed(() => !!expandableMessage.value.sourcesOpen);
const answerDetailsOpen = computed(() => !!expandableMessage.value.answerDetailsOpen);
const contextDecisionsOpen = computed(() => !!expandableMessage.value.contextDecisionsOpen);
const rawContextIdentifiersOpen = computed(() => !!expandableMessage.value.rawContextIdentifiersOpen);
const runDiagnosticsOpen = computed(() => !!expandableMessage.value.runDiagnosticsOpen);
const memoryTypes: MemoryType[] = ['profile', 'preference', 'fact', 'event', 'pitfall'];
const memoryEditing = ref(false);
const memoryDraft = reactive({
  type: 'fact' as MemoryType,
  title: '',
  content: ''
});
const memoryCorrectionValid = computed(() =>
  Boolean(memoryDraft.title.trim() && memoryDraft.content.trim())
);
const generationSpan = computed(() =>
  [...(props.message.run?.spans || [])]
    .reverse()
    .find((span) => span.name === 'generation' && span.metadata?.contextManifest)
);
const contextManifest = computed(() => generationSpan.value?.metadata?.contextManifest);
const knowledgeEvidence = computed(() =>
  [...(props.message.run?.spans || [])]
    .reverse()
    .find((span) => span.name === 'knowledge_evidence_gate')
    ?.metadata?.evidence
);
const knowledgeEvidenceStatusLabel = computed(() => {
  const status = knowledgeEvidence.value?.status;
  if (status === 'evidence') return '已采用可信资料';
  if (status === 'unavailable') return '检索暂不可用';
  return '未找到可用证据';
});
const knowledgeEvidenceCopy = computed(() => {
  const evidence = knowledgeEvidence.value;
  if (!evidence) return '';
  if (evidence.status === 'evidence') {
    return evidence.reason === 'hybrid_match'
      ? '采用同时具备词法与语义信号的资料片段。'
      : '采用具备明确词法命中的资料片段。';
  }
  if (evidence.status === 'unavailable') {
    return '本轮没有把资料库内容作为回答依据。';
  }
  return evidence.reason === 'weak_candidates'
    ? '候选仅有弱语义关联，未注入回答。'
    : '当前资料范围内没有与问题相关的资料片段。';
});
const answerDetailSummary = computed(() => {
  const parts: string[] = [];
  const counts = contextManifest.value?.summary.includedByKind || {};
  const summaryKinds: Array<[ContextKind, (count: number) => string]> = [
    ['conversation_turn', (count) => `${count} 轮历史`],
    ['knowledge_chunk', (count) => `${count} 个资料片段`],
    ['memory', (count) => `${count} 条记忆`],
    ['research_evidence', (count) => `${count} 条研究证据`],
    ['tool_exchange', (count) => `${count} 次工具结果`]
  ];
  for (const [kind, format] of summaryKinds) {
    const count = counts[kind] || 0;
    if (count > 0) parts.push(format(count));
  }
  if (props.message.tools?.length && !counts.tool_exchange) {
    parts.push(`${props.message.tools.length} 次工具`);
  }
  if (!parts.length && contextManifest.value) {
    parts.push('基础上下文');
  }
  const run = props.message.run;
  if (run) {
    parts.push(formatDuration(run.finishedAt ? run.finishedAt - run.createdAt : null));
  }
  return parts.join(' · ');
});
const contextKindPresentation: Record<ContextKind, { label: string; unit: string; icon: string }> = {
  system_rule: { label: '助手规则', unit: '项', icon: '规' },
  current_user: { label: '当前问题', unit: '项', icon: '问' },
  conversation_turn: { label: '对话历史', unit: '轮', icon: '聊' },
  knowledge_chunk: { label: '资料库', unit: '个片段', icon: '资' },
  memory: { label: '长期记忆', unit: '条', icon: '忆' },
  research_evidence: { label: '研究证据', unit: '条', icon: '研' },
  tool_exchange: { label: '工具结果', unit: '次', icon: '工' },
  few_shot: { label: '预设示例', unit: '组', icon: '例' }
};
const contextGroups = computed(() => {
  const counts = contextManifest.value?.summary.includedByKind || {};
  return (Object.entries(contextKindPresentation) as Array<
    [ContextKind, { label: string; unit: string; icon: string }]
  >)
    .map(([kind, presentation]) => ({
      kind,
      ...presentation,
      count: counts[kind] || 0
    }))
    .filter((group) => group.count > 0);
});
const contextUsageSummary = computed(() => {
  const counts = contextManifest.value?.summary.includedByKind || {};
  const parts = [
    counts.conversation_turn ? `${counts.conversation_turn} 轮对话历史` : '',
    counts.knowledge_chunk ? `${counts.knowledge_chunk} 个资料片段` : '',
    counts.memory ? `${counts.memory} 条长期记忆` : '',
    counts.research_evidence ? `${counts.research_evidence} 条研究证据` : '',
    counts.tool_exchange ? `${counts.tool_exchange} 次工具结果` : ''
  ].filter(Boolean);
  return parts.length ? parts.join('、') : '当前问题和助手规则';
});
const unusedContextSources = computed(() => {
  const counts = contextManifest.value?.summary.includedByKind || {};
  return [
    ['knowledge_chunk', '资料库'],
    ['memory', '长期记忆'],
    ['research_evidence', '研究证据']
  ]
    .filter(([kind]) => !(counts[kind as ContextKind] || 0))
    .map(([, label]) => label);
});
const contextDecisionRows = computed(() => {
  const sequence = new Map<ContextKind, number>();
  return (contextManifest.value?.decisions || []).map((decision) => {
    const position = (sequence.get(decision.kind) || 0) + 1;
    sequence.set(decision.kind, position);
    return {
      ...decision,
      label: contextDecisionLabel(decision.kind, position)
    };
  });
});
const contextReasonPresentation: Partial<Record<ContextDecisionReason, string>> = {
  required: '必选',
  conversation_continuity: '保持对话连续',
  active_tool_chain: '保持工具链完整',
  relevant: '与当前问题相关',
  out_of_scope: '不符合本轮范围',
  duplicate: '重复',
  over_budget: '超出预算',
  stale: '内容过旧',
  superseded: '已被更新内容替代',
  invalid: '格式无效',
  low_relevance: '相关性不足'
};
const excludedContextReasons = computed(() => {
  const reasons = contextManifest.value?.summary.excludedByReason || {};
  return Object.entries(reasons)
    .filter(([, count]) => Number(count) > 0)
    .map(([reason, count]) => ({
      reason,
      count,
      label: contextReasonPresentation[reason as ContextDecisionReason] || reason
    }));
});
// runSummary 概括整个 run；具体步骤来自 run.spans，按服务端事件更新后展示在时间线中。
// 未结束的 run 没有 finishedAt，formatDuration 会明确显示“进行中”。
const runSummary = computed(() => {
  const run = props.message.run;
  if (!run) return '';
  const duration = run.finishedAt ? run.finishedAt - run.createdAt : null;
  return `${runStatusLabel(run.status)} · ${formatDuration(duration)} · 输入 ${run.inputTokens} / 输出 ${run.outputTokens}`;
});
// 流式消息尚无 token 时显示占位文案；一旦 content 增长，Markdown 会随响应式更新重新渲染。
const html = computed(() => renderMarkdown(props.message.content || (props.message.status === 'streaming' ? '正在思考中…' : '')));
const roleLabel = computed(() => (props.message.role === 'assistant' ? "Matthew's Workspace" : '你'));
const avatar = computed(() => (props.message.role === 'assistant' ? '✦' : '你'));
const memoryBusy = computed(() => {
  const id = props.message.memoryCandidate?.id;
  return !!id && props.memoryBusyIds.includes(id);
});
const memoryFailed = computed(() => {
  const id = props.message.memoryCandidate?.id;
  return !!id && props.memoryFailedIds.includes(id);
});
const memoryReviewable = computed(() =>
  props.message.memoryStatus === 'candidate'
  || props.message.memoryStatus === 'error'
  || memoryFailed.value
);
const memoryTypeLabel = computed(() => {
  return props.message.memoryCandidate
    ? memoryTypeOptionLabel(props.message.memoryCandidate.type)
    : '';
});
const memoryStatusLabel = computed(() => {
  const labels: Record<string, string> = {
    candidate: '待审查',
    confirmed: '已确认',
    corrected: '已纠正',
    rejected: '已拒绝',
    saving: '保存中',
    error: '操作失败'
  };
  if (memoryBusy.value) return labels.saving;
  if (memoryFailed.value) return labels.error;
  return labels[props.message.memoryStatus || props.message.memoryCandidate?.status || 'candidate'];
});
const timeLabel = computed(() =>
  new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(props.message.createdAt)
);

// 工具名是服务端契约；这里只做显示友好化，未识别的新工具仍会安全显示通用文案。
function getToolSummary(tool: ToolInvocation) {
  if (tool.name === 'retrieve_knowledge') {
    return '检索资料库';
  }
  if (tool.name === 'list_knowledge_documents') {
    return '查看文档列表';
  }
  return '已执行';
}

function memoryTypeOptionLabel(type: MemoryType) {
  return {
    profile: '画像',
    preference: '偏好',
    fact: '事实',
    event: '事件',
    pitfall: '踩坑'
  }[type];
}

function startMemoryEdit() {
  const candidate = props.message.memoryCandidate;
  if (!candidate) return;
  beginLayoutChange();
  memoryDraft.type = candidate.type;
  memoryDraft.title = candidate.title;
  memoryDraft.content = candidate.content;
  memoryEditing.value = true;
  notifyLayoutChanged();
}

function cancelMemoryEdit() {
  beginLayoutChange();
  memoryEditing.value = false;
  notifyLayoutChanged();
}

function submitMemoryCorrection() {
  const candidate = props.message.memoryCandidate;
  if (!candidate || !memoryCorrectionValid.value || memoryBusy.value) return;
  emit('correct-memory', candidate.id, {
    type: memoryDraft.type,
    title: memoryDraft.title.trim(),
    content: memoryDraft.content.trim()
  });
  cancelMemoryEdit();
}

// 展开详情会改变卡片高度。等 Vue 完成 DOM 更新后派发 resize，
// 让聊天容器中依赖布局高度的滚动/定位逻辑能感知变化。
async function notifyLayoutChanged() {
  await nextTick();
  window.dispatchEvent(new Event('resize'));
}

// 用户主动改变卡片高度前先通知滚动容器，让它暂停自动跟随并保持阅读位置。
function beginLayoutChange() {
  emit('layout-change');
}

// toggle 只改变局部展示标记，不会改变工具、引用或 run 的业务数据。
function toggleTools() {
  beginLayoutChange();
  expandableMessage.value.toolsOpen = !toolsOpen.value;
  notifyLayoutChanged();
}

function toggleSources() {
  beginLayoutChange();
  expandableMessage.value.sourcesOpen = !sourcesOpen.value;
  notifyLayoutChanged();
}

function toggleAnswerDetails() {
  beginLayoutChange();
  expandableMessage.value.answerDetailsOpen = !answerDetailsOpen.value;
  notifyLayoutChanged();
}

function toggleContextDecisions() {
  beginLayoutChange();
  expandableMessage.value.contextDecisionsOpen = !contextDecisionsOpen.value;
  notifyLayoutChanged();
}

function toggleRawContextIdentifiers() {
  beginLayoutChange();
  expandableMessage.value.rawContextIdentifiersOpen = !rawContextIdentifiersOpen.value;
  notifyLayoutChanged();
}

function toggleRunDiagnostics() {
  beginLayoutChange();
  expandableMessage.value.runDiagnosticsOpen = !runDiagnosticsOpen.value;
  notifyLayoutChanged();
}

function contextDecisionLabel(kind: ContextKind, position: number) {
  const labels: Record<ContextKind, string> = {
    system_rule: '通用助手规则',
    current_user: '当前问题',
    conversation_turn: `第 ${position} 轮对话`,
    knowledge_chunk: `资料片段 ${position}`,
    memory: `长期记忆 ${position}`,
    research_evidence: `研究证据 ${position}`,
    tool_exchange: `工具结果 ${position}`,
    few_shot: `预设示例 ${position}`
  };
  return labels[kind];
}

function contextReasonLabel(reason: ContextDecisionReason) {
  return contextReasonPresentation[reason] || reason;
}

const runStepPresentation: Record<string, string> = {
  mcp_connect: '连接工具服务',
  mcp_tool_discovery: '发现可用工具',
  knowledge_scope_check: '检查资料范围',
  retrieve_memory: '检索长期记忆',
  retrieve_knowledge: '检索资料库',
  knowledge_evidence_gate: '评估资料证据',
  tool_planning: '规划工具调用',
  generation: '生成最终回答',
  memory_candidate_extraction: '提取记忆候选'
};

function runStepLabel(name: string) {
  return runStepPresentation[name] || name;
}

const runKindPresentation: Record<string, string> = {
  internal: '内部准备',
  retrieval: '检索',
  model: '模型',
  tool: '工具'
};

function runKindLabel(kind: AgentSpan['kind']) {
  return runKindPresentation[kind] || kind;
}

const runStatusPresentation: Record<RunStatus, string> = {
  running: '进行中',
  success: '成功',
  error: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
};

function runStatusLabel(status: RunStatus) {
  return runStatusPresentation[status];
}

function formatTokens(value: number) {
  const tokens = Math.max(0, Number(value) || 0);
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}

// duration 可能在 SSE 进行中缺失，因此先收敛为“进行中”，再按 ms/s 选择可读单位。
function formatDuration(duration?: number | null) {
  if (!duration || duration < 0) return '进行中';
  return duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`;
}
</script>
