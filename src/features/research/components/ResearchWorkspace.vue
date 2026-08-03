<template>
  <section class="research-workspace" aria-labelledby="research-workspace-title">
    <header class="research-workspace-header">
      <div>
        <p class="section-label">Research Workspace</p>
        <h1 id="research-workspace-title">异步深度研究</h1>
        <p>任务在后台独立执行；你可以离开页面，稍后通过地址继续阅读。</p>
      </div>
      <button data-testid="research-new-draft" type="button" @click="beginBlankDraft">
        新建研究
      </button>
    </header>

    <div v-if="store.errorMessage" class="research-alert research-alert-error" role="alert">
      {{ store.errorMessage }}
    </div>
    <div v-if="store.noticeMessage" class="research-alert research-alert-notice">
      {{ store.noticeMessage }}
    </div>

    <div
      class="research-workspace-grid"
      :class="{
        'research-detail-open': Boolean(taskId),
        'research-draft-open': showDraft && !taskId
      }"
    >
      <aside ref="listPane" data-testid="research-list-pane" class="research-list-pane" aria-label="研究任务列表">
        <div class="research-list-heading">
          <div>
            <strong>研究会话</strong>
            <span>{{ visibleSessions.length }} 项 · {{ store.activeTaskCount }} 轮进行中</span>
          </div>
          <button type="button" :disabled="store.loading" @click="store.refreshTasks">
            {{ store.loading ? '同步中…' : '同步' }}
          </button>
        </div>

        <label class="research-status-filter">
          <span>状态筛选</span>
          <select v-model="statusFilter" data-testid="research-status-filter">
            <option value="all">全部状态</option>
            <option value="active">进行中</option>
            <option value="completed">已完成</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
          </select>
        </label>

        <div v-if="visibleSessions.length" class="research-task-list">
          <button
            v-for="session in visibleSessions"
            :key="session.id"
            type="button"
            class="research-task-card"
            :class="{ 'research-task-selected': session.runs.some((task) => task.id === taskId) }"
            @click="openSession(session)"
          >
            <span class="research-task-card-topline">
              <strong>{{ session.root.question }}</strong>
              <span :class="`research-status-${session.latest.status}`">{{ statusLabel(session.latest.status) }}</span>
            </span>
            <span>第 {{ session.latest.turnIndex }} 轮 · {{ session.runs.length }} 轮研究</span>
            <span>
              {{ searchModeLabel(session.latest.searchMode) }} · {{ formatTime(session.latest.updatedAt) }}
              <template v-if="session.latest.status === 'completed'"> · {{ resultQualityLabel(session.latest.resultQuality) }}</template>
            </span>
          </button>
        </div>
        <div v-else class="research-empty-list">还没有研究任务，从一个问题开始。</div>
      </aside>

      <main class="research-detail-pane">
        <button v-if="taskId || showDraft" data-testid="research-back" class="research-mobile-back" type="button" @click="backToList">
          ← 返回任务列表
        </button>

        <form
          v-if="showDraft && store.draft && !taskId"
          data-testid="research-draft-form"
          class="research-draft"
          @submit.prevent="submitDraft"
        >
          <header>
            <div>
              <p class="section-label">Research Draft</p>
              <h2>确认研究范围</h2>
            </div>
            <span v-if="store.draft.sourceSessionId">来自聊天草稿</span>
          </header>

          <label>
            <span>研究问题</span>
            <textarea
              data-testid="research-question"
              :value="store.draft.question"
              maxlength="4000"
              rows="5"
              placeholder="输入需要深入研究的问题"
              @input="updateQuestion"
            ></textarea>
          </label>

          <label>
            <span>资料范围</span>
            <select
              data-testid="research-mode"
              :value="store.draft.searchMode"
              @change="updateMode"
            >
              <option value="local">仅项目资料</option>
              <option value="hybrid" :disabled="!publicSearchAvailable">项目资料 + 公开一手资料</option>
            </select>
          </label>

          <fieldset v-if="knowledgeBases.length">
            <legend>知识库范围</legend>
            <label v-for="knowledgeBase in knowledgeBases" :key="knowledgeBase.id" class="research-kb-option">
              <input
                type="checkbox"
                :value="knowledgeBase.id"
                :checked="store.draft.knowledgeBaseIds.includes(knowledgeBase.id)"
                @change="toggleKnowledgeBase(knowledgeBase.id)"
              />
              {{ knowledgeBase.name }}
            </label>
          </fieldset>

          <p class="research-mode-help">{{ searchModeHelp }}</p>
          <p v-if="!publicSearchAvailable" class="research-capability-note">
            当前部署尚未配置公开资料搜索；配置安全的搜索 Provider 后即可启用补充检索。
          </p>
          <button
            class="research-primary-action"
            type="submit"
            :disabled="!store.draft.question.trim() || store.draft.status === 'submitting'"
          >
            {{ store.draft.status === 'submitting' ? '创建中…' : '创建研究任务' }}
          </button>
        </form>

        <article v-else-if="selectedTask" class="research-task-detail">
          <header class="research-detail-header">
            <div>
              <p class="section-label">Research Run · 第 {{ selectedTask.turnIndex }} 轮</p>
              <h2>{{ selectedTask.question }}</h2>
              <p v-if="selectedTask.turnIndex > 1" class="research-session-origin">研究会话：{{ sessionRoot?.question }}</p>
            </div>
            <span class="research-detail-status" :class="`research-status-${selectedTask.status}`">
              {{ statusLabel(selectedTask.status) }}
            </span>
          </header>

          <div class="research-progress-copy">
            <span>{{ stageLabel(selectedTask.stage) }}</span>
            <span>{{ clampProgress(selectedTask.progress) }}%</span>
          </div>
          <div class="research-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="clampProgress(selectedTask.progress)">
            <span :style="{ width: `${clampProgress(selectedTask.progress)}%` }"></span>
          </div>

          <ol class="research-stage-track" aria-label="七阶段研究进度">
            <li
              v-for="stage in RESEARCH_STAGES"
              :key="stage.id"
              data-testid="research-stage"
              :class="`research-stage-${stageState(selectedTask, stage.id)}`"
            >
              <span aria-hidden="true"></span>
              <strong>{{ stage.label }}</strong>
            </li>
          </ol>

          <dl class="research-task-meta">
            <div><dt>资料模式</dt><dd>{{ searchModeLabel(selectedTask.searchMode) }}</dd></div>
            <div><dt>联网状态</dt><dd>{{ webStatusLabel(selectedTask.webSearchStatus) }}</dd></div>
            <div><dt>结果质量</dt><dd>{{ resultQualityLabel(selectedTask.resultQuality) }}</dd></div>
            <div><dt>执行次数</dt><dd>第 {{ Math.max(1, selectedTask.attempt || 1) }} 次</dd></div>
            <div><dt>最后更新</dt><dd>{{ formatTime(selectedTask.updatedAt) }}</dd></div>
          </dl>

          <section v-if="sessionRuns.length > 1" class="research-run-timeline" aria-label="研究轮次">
            <header>
              <div>
                <p class="section-label">Research Session</p>
                <h3>研究轮次</h3>
              </div>
              <span>{{ sessionRuns.length }} 轮</span>
            </header>
            <button
              v-for="run in sessionRuns"
              :key="run.id"
              type="button"
              :class="{ 'research-run-selected': run.id === selectedTask.id }"
              @click="openTask(run.id)"
            >
              <strong>第 {{ run.turnIndex }} 轮</strong>
              <span>{{ run.question }}</span>
              <em :class="`research-status-${run.status}`">{{ statusLabel(run.status) }}</em>
            </button>
          </section>

          <ResearchPlanPanel v-if="runView.plan" :plan="runView.plan" />

          <ResearchEvidencePanel
            v-if="runView.evidencePack"
            :pack="runView.evidencePack"
            :reading="selectedTask.artifacts?.reading"
          />

          <section
            v-if="selectedTask.status === 'completed' && selectedTask.resultQuality !== 'sufficient'"
            class="research-quality-alert"
            :class="`research-quality-${selectedTask.resultQuality}`"
            role="status"
          >
            <strong>证据质量：{{ resultQualityLabel(selectedTask.resultQuality) }}</strong>
            <p>任务已执行完成，但报告可信度仍受以下证据边界影响：</p>
            <ul v-if="selectedTask.limitations.length">
              <li v-for="limitation in selectedTask.limitations" :key="limitation.code">
                {{ limitation.message }}
              </li>
            </ul>
          </section>

          <section v-if="selectedTask.status === 'failed' || selectedTask.error" class="research-task-error" role="alert">
            <strong v-if="selectedTask.failedStage">失败步骤：{{ stageLabel(selectedTask.failedStage) }}</strong>
            <p>{{ selectedTask.error || '任务执行失败，可稍后重试。' }}</p>
          </section>

          <div class="research-task-actions">
            <button v-if="canRetry(selectedTask)" type="button" :disabled="isBusy(selectedTask.id)" @click="store.retryTask(selectedTask.id)">重试</button>
            <button v-if="canCancel(selectedTask)" class="research-cancel-action" type="button" :disabled="isBusy(selectedTask.id)" @click="store.cancelTask(selectedTask.id)">取消任务</button>
          </div>

          <ResearchDiagnosticsPanel
            v-if="runView.diagnostics"
            :diagnostics="runView.diagnostics"
          />

          <section v-if="selectedTask.report" class="research-report" aria-labelledby="research-report-title">
            <h3 id="research-report-title">研究报告</h3>
            <div class="research-report-body" v-html="renderMarkdown(selectedTask.report)"></div>
          </section>

          <section v-if="selectedTask.citations.length" class="research-citations" aria-labelledby="research-citations-title">
            <h3 id="research-citations-title">引用来源（{{ selectedTask.citations.length }}）</h3>
            <ol>
              <li v-for="citation in selectedTask.citations" :key="citation.id">
                <a v-if="safeExternalUrl(citation.url)" :href="safeExternalUrl(citation.url)" target="_blank" rel="noopener noreferrer">{{ citation.title }}</a>
                <strong v-else>{{ citation.title }}</strong>
                <span>{{ citation.source }}</span>
                <p v-if="citation.snippet">{{ citation.snippet }}</p>
              </li>
            </ol>
          </section>

          <form
            v-if="selectedTask.status === 'completed'"
            class="research-follow-up"
            data-testid="research-follow-up-form"
            @submit.prevent="submitFollowUp"
          >
            <header>
              <div>
                <p class="section-label">Continue Research</p>
                <h3>继续研究</h3>
              </div>
              <span>沿用本轮资料范围</span>
            </header>
            <p v-if="selectedTask.continuationContext" class="research-follow-up-context">
              已继承第 {{ Math.max(1, selectedTask.turnIndex - 1) }} 轮的结论摘要、{{ selectedTask.continuationContext.citations.length }} 条引用与证据缺口；它们仅用于聚焦本轮研究。
            </p>
            <textarea
              v-model="followUpQuestion"
              data-testid="research-follow-up-question"
              rows="3"
              maxlength="4000"
              :disabled="sessionHasActiveRun"
              placeholder="例如：只比较 OpenHands、Aider 与 SWE-agent 的 Agent Loop"
            ></textarea>
            <div class="research-follow-up-actions">
              <span v-if="sessionHasActiveRun">当前会话已有进行中的研究轮次。</span>
              <button type="submit" :disabled="!followUpQuestion.trim() || sessionHasActiveRun || isBusy(selectedTask.id)">
                {{ isBusy(selectedTask.id) ? '创建中…' : '开始下一轮研究' }}
              </button>
            </div>
          </form>
        </article>

        <section v-else-if="taskId" class="research-missing-task">
          <h2>无法打开研究任务</h2>
          <p>任务可能不存在，或者当前暂时无法从服务端读取。</p>
          <button type="button" @click="backToList">返回任务列表</button>
        </section>

        <section v-else class="research-welcome">
          <p class="section-label">Independent Workspace</p>
          <h2>让长任务拥有自己的阅读空间</h2>
          <p>选择左侧任务继续阅读，或者创建一份新的研究草稿。</p>
          <button type="button" @click="beginBlankDraft">开始研究</button>
        </section>
      </main>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { renderMarkdown } from '@/services/markdown';
import { useResearchStore } from '../store';
import { buildResearchRunViewModel } from '../presentation';
import ResearchDiagnosticsPanel from './ResearchDiagnosticsPanel.vue';
import ResearchEvidencePanel from './ResearchEvidencePanel.vue';
import ResearchPlanPanel from './ResearchPlanPanel.vue';
import type {
  ResearchSearchMode,
  ResearchStage,
  ResearchTask,
  ResearchTaskStatus,
  ResearchWebSearchStatus
} from '../types';

const props = defineProps<{
  knowledgeBases: Array<{ id: string; name: string }>;
  defaultKnowledgeBaseIds: string[];
}>();

const store = useResearchStore();
const route = useRoute();
const router = useRouter();
const taskId = computed(() => typeof route.params.taskId === 'string' ? route.params.taskId : '');
const selectedTask = computed(() => store.tasks.find((task) => task.id === taskId.value) || null);
const runView = computed(() => buildResearchRunViewModel(selectedTask.value));
const showDraft = computed(() => Boolean(store.draft && store.draft.status !== 'submitted'));
const statusFilter = ref<'all' | 'active' | 'completed' | 'failed' | 'cancelled'>('all');
const followUpQuestion = ref('');
const listPane = ref<HTMLElement | null>(null);
const savedListScrollTop = ref(0);
const researchSessions = computed(() => {
  const groups = new Map<string, ResearchTask[]>();
  for (const task of store.sortedTasks) {
    const key = task.sessionId || task.id;
    groups.set(key, [...(groups.get(key) || []), task]);
  }
  return [...groups.entries()].map(([id, runs]) => {
    const orderedRuns = [...runs].sort((left, right) => left.turnIndex - right.turnIndex || left.createdAt - right.createdAt);
    return {
      id,
      runs: orderedRuns,
      root: orderedRuns.find((task) => !task.parentTaskId) || orderedRuns[0],
      latest: [...orderedRuns].sort((left, right) => right.updatedAt - left.updatedAt)[0]
    };
  }).sort((left, right) => right.latest.updatedAt - left.latest.updatedAt);
});
const visibleSessions = computed(() => researchSessions.value.filter((session) => {
  if (statusFilter.value === 'all') return true;
  if (statusFilter.value === 'active') {
    return session.runs.some((task) => task.status === 'queued' || task.status === 'running');
  }
  return session.runs.some((task) => task.status === statusFilter.value);
}));
const sessionRuns = computed(() => selectedTask.value
  ? (researchSessions.value.find((session) => session.id === selectedTask.value?.sessionId)?.runs || [selectedTask.value])
  : []);
const sessionRoot = computed(() => sessionRuns.value.find((task) => !task.parentTaskId) || sessionRuns.value[0] || null);
const sessionHasActiveRun = computed(() => sessionRuns.value.some((task) => task.status === 'queued' || task.status === 'running'));
const publicSearchAvailable = computed(() => store.capabilities.publicPrimarySearch.available);
const searchModeHelp = computed(() => {
  if (store.draft?.searchMode === 'local') return '只检索选中的项目资料，不发起联网请求。';
  if (store.draft?.searchMode === 'web') return '这是历史任务模式；联网不可用时会降级为项目资料检索。';
  return '以项目资料为主，公开一手资料只用于补充与交叉核对。';
});

let mounted = false;

onMounted(async () => {
  mounted = true;
  if (taskId.value) await store.ensureSession(taskId.value);
});

watch(taskId, async (id) => {
  followUpQuestion.value = '';
  if (mounted && id) await store.ensureSession(id);
});

function beginBlankDraft() {
  store.startDraft({ knowledgeBaseIds: [...props.defaultKnowledgeBaseIds] });
  if (taskId.value) void router.push('/research');
}

function updateQuestion(event: Event) {
  store.updateDraft({ question: (event.target as HTMLTextAreaElement).value });
}

function updateMode(event: Event) {
  store.updateDraft({ searchMode: (event.target as HTMLSelectElement).value as ResearchSearchMode });
}

function toggleKnowledgeBase(id: string) {
  if (!store.draft) return;
  const selected = store.draft.knowledgeBaseIds.includes(id)
    ? store.draft.knowledgeBaseIds.filter((value) => value !== id)
    : [...store.draft.knowledgeBaseIds, id];
  store.updateDraft({ knowledgeBaseIds: selected });
}

async function submitDraft() {
  const id = await store.submitDraft();
  if (id) await router.push(`/research/${encodeURIComponent(id)}`);
}

function openTask(id: string) {
  savedListScrollTop.value = listPane.value?.scrollTop || 0;
  void router.push(`/research/${encodeURIComponent(id)}`);
}

function openSession(session: { latest: ResearchTask; runs: ResearchTask[] }) {
  const selected = session.runs.find((task) => task.id === taskId.value);
  openTask(selected?.id || session.latest.id);
}

async function submitFollowUp() {
  if (!selectedTask.value || !followUpQuestion.value.trim() || sessionHasActiveRun.value) return;
  const id = await store.continueTask(selectedTask.value.id, {
    question: followUpQuestion.value.trim()
  });
  if (id) {
    followUpQuestion.value = '';
    await router.push(`/research/${encodeURIComponent(id)}`);
  }
}

async function backToList() {
  if (!taskId.value) store.discardDraft();
  await router.push('/research');
  await nextTick();
  if (listPane.value) listPane.value.scrollTop = savedListScrollTop.value;
}

const RESEARCH_STAGES: Array<{ id: ResearchStage; label: string }> = [
  { id: 'planning', label: '拆解问题' },
  { id: 'retrieving', label: '检索资料' },
  { id: 'extracting', label: '提炼证据' },
  { id: 'outlining', label: '组织提纲' },
  { id: 'writing', label: '撰写报告' },
  { id: 'verifying', label: '核验引用' },
  { id: 'completed', label: '研究完成' }
];

function stageState(task: ResearchTask, stage: ResearchStage) {
  const current = task.failedStage || task.stage;
  const currentIndex = RESEARCH_STAGES.findIndex((item) => item.id === current);
  const stageIndex = RESEARCH_STAGES.findIndex((item) => item.id === stage);
  if (task.status === 'completed' || stageIndex < currentIndex) return 'done';
  if (stageIndex === currentIndex) return task.status === 'failed' ? 'failed' : 'current';
  return 'pending';
}

function statusLabel(status: ResearchTaskStatus) {
  return ({ queued: '排队中', running: '研究中', completed: '已完成', failed: '失败', cancelled: '已取消' })[status];
}

function stageLabel(stage: string) {
  return ({ planning: '拆解问题', retrieving: '检索资料', extracting: '提炼证据', outlining: '组织提纲', writing: '撰写报告', verifying: '核验引用', completed: '研究完成' } as Record<string, string>)[stage] || stage;
}

function searchModeLabel(mode: ResearchSearchMode) {
  return ({ local: '仅项目资料', hybrid: '项目资料 + 公开一手资料', web: '旧版联网优先' })[mode];
}

function resultQualityLabel(quality: ResearchTask['resultQuality']) {
  return ({ pending: '待评估', sufficient: '证据充分', limited: '证据受限', insufficient: '证据不足' })[quality] || '待评估';
}

function webStatusLabel(status: ResearchWebSearchStatus) {
  return ({ not_requested: '仅本地检索', pending: '等待联网检索', available: '联网检索完成', unavailable: '不可用，已降级本地', partial: '部分成功', error: '联网失败，已保留本地结果' })[status];
}

function clampProgress(progress: number) {
  return Number.isFinite(progress) ? Math.min(100, Math.max(0, Math.round(progress))) : 0;
}

function formatTime(value: number) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
}

function canCancel(task: ResearchTask) {
  return task.status === 'queued' || task.status === 'running';
}

function canRetry(task: ResearchTask) {
  return task.status === 'failed' || task.status === 'cancelled';
}

function isBusy(id: string) {
  return store.busyTaskIds.includes(id);
}

function safeExternalUrl(value?: string) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}
</script>

<style scoped>
.research-workspace { display: flex; flex-direction: column; gap: 18px; min-height: 0; height: 100%; padding: 18px 6px 30px; overflow: hidden; }
.research-workspace-header, .research-list-heading, .research-detail-header, .research-draft header, .research-progress-copy, .research-task-card-topline, .research-task-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.research-workspace-header h1, .research-detail-header h2, .research-draft h2, .research-welcome h2 { margin: 2px 0 5px; color: var(--heading); }
.research-workspace-header p, .research-welcome p, .research-missing-task p { margin: 0; color: var(--muted); }
.research-workspace button, .research-workspace textarea, .research-workspace select { font: inherit; }
.research-workspace-header > button, .research-primary-action, .research-welcome button { padding: 10px 15px; color: #fff; background: var(--accent-strong); border: 0; border-radius: 11px; font-weight: 700; }
.research-alert { padding: 10px 13px; border-radius: 11px; }
.research-alert-error, .research-task-error { color: var(--danger); background: #fce8e6; }
.research-alert-notice { color: #7a4b00; background: #fef7e0; }
.research-workspace-grid { display: grid; flex: 1 1 auto; grid-template-columns: minmax(270px, 0.72fr) minmax(0, 1.6fr); gap: 16px; min-height: 0; overflow: hidden; }
.research-list-pane, .research-detail-pane { min-width: 0; padding: 16px; background: var(--panel); border: 1px solid var(--panel-line); border-radius: 18px; }
.research-list-pane { display: grid; align-content: start; gap: 13px; overflow: auto; }
.research-list-heading div { display: grid; gap: 3px; }
.research-list-heading span, .research-task-card > span, .research-draft header > span { color: var(--muted); font-size: .76rem; }
.research-status-filter { display: grid; gap: 5px; color: var(--muted); font-size: .74rem; }
.research-status-filter select { width: 100%; padding: 8px 9px; color: var(--text); background: #fff; border: 1px solid var(--panel-line); border-radius: 9px; }
.research-list-heading button, .research-task-actions button, .research-mobile-back, .research-missing-task button { padding: 7px 10px; color: var(--accent-strong); background: var(--accent-soft); border: 0; border-radius: 9px; }
.research-task-list { display: grid; gap: 9px; }
.research-task-card { display: grid; gap: 7px; width: 100%; padding: 12px; color: var(--text); text-align: left; background: var(--panel-muted); border: 1px solid transparent; border-radius: 13px; }
.research-task-card:hover, .research-task-selected { border-color: #8ab4f8; background: var(--accent-soft); }
.research-task-card-topline { align-items: flex-start; }
.research-task-card-topline strong { color: var(--heading); line-height: 1.4; }
.research-task-card-topline span, .research-detail-status { flex: 0 0 auto; padding: 3px 7px; border-radius: 999px; font-size: .7rem; font-weight: 700; }
.research-session-origin { margin: 5px 0 0; color: var(--muted); font-size: .82rem; }
.research-status-queued, .research-status-running { color: var(--warning); background: rgba(176, 96, 0, .1); }
.research-status-completed { color: var(--success); background: rgba(30, 142, 62, .1); }
.research-status-failed { color: var(--danger); background: rgba(217, 48, 37, .1); }
.research-status-cancelled { color: var(--muted); background: rgba(95, 99, 104, .1); }
.research-detail-pane { overflow: auto; }
.research-mobile-back { display: none; margin-bottom: 12px; }
.research-draft, .research-task-detail { display: grid; gap: 16px; }
.research-draft label { display: grid; gap: 6px; color: var(--heading); font-weight: 700; }
.research-draft textarea, .research-draft select { width: 100%; padding: 11px; color: var(--text); background: #fff; border: 1px solid var(--panel-line); border-radius: 11px; }
.research-draft textarea { resize: vertical; line-height: 1.55; }
.research-draft fieldset { display: flex; flex-wrap: wrap; gap: 9px 14px; padding: 12px; border: 1px solid var(--panel-line); border-radius: 11px; }
.research-kb-option { display: inline-flex !important; grid-auto-flow: column; align-items: center; font-weight: 500 !important; }
.research-mode-help, .research-capability-note { margin: 0; color: var(--muted); }
.research-capability-note { padding: 10px 12px; background: var(--panel-muted); border-radius: 10px; font-size: .82rem; }
.research-primary-action { justify-self: start; }
.research-progress-copy { color: var(--muted); font-size: .82rem; }
.research-progress { height: 8px; overflow: hidden; background: var(--panel-line); border-radius: 999px; }
.research-progress span { display: block; height: 100%; background: linear-gradient(90deg, #7baaf7, var(--accent-strong)); border-radius: inherit; }
.research-stage-track { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 7px; margin: 0; padding: 0; list-style: none; }
.research-stage-track li { display: grid; gap: 5px; color: var(--muted); font-size: .68rem; text-align: center; }
.research-stage-track li > span { height: 6px; background: var(--panel-line); border-radius: 999px; }
.research-stage-track .research-stage-done > span, .research-stage-track .research-stage-current > span { background: var(--accent-strong); }
.research-stage-track .research-stage-current strong { color: var(--accent-strong); }
.research-stage-track .research-stage-failed > span { background: var(--danger); }
.research-stage-track .research-stage-failed strong { color: var(--danger); }
.research-task-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 9px; margin: 0; }
.research-task-meta div { padding: 10px; background: var(--panel-muted); border-radius: 10px; }
.research-task-meta dt { color: var(--muted); font-size: .72rem; }
.research-task-meta dd { margin: 4px 0 0; overflow-wrap: anywhere; }
.research-run-timeline { display: grid; gap: 8px; padding: 13px; background: var(--panel-muted); border: 1px solid var(--panel-line); border-radius: 13px; }
.research-run-timeline header, .research-follow-up header, .research-follow-up-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.research-run-timeline h3, .research-follow-up h3 { margin: 2px 0 0; color: var(--heading); }
.research-run-timeline header > span, .research-follow-up header > span { color: var(--muted); font-size: .78rem; }
.research-run-timeline > button { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 9px; align-items: center; width: 100%; padding: 9px 10px; color: var(--text); text-align: left; background: #fff; border: 1px solid var(--panel-line); border-radius: 10px; }
.research-run-timeline > button:hover, .research-run-timeline > button.research-run-selected { border-color: #8ab4f8; background: var(--accent-soft); }
.research-run-timeline > button > span { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.research-run-timeline em { padding: 3px 6px; border-radius: 999px; font-size: .7rem; font-style: normal; font-weight: 700; }
.research-task-error { padding: 12px; border-radius: 11px; }
.research-task-error p { margin: 4px 0 0; }
.research-quality-alert { padding: 12px 14px; border: 1px solid transparent; border-radius: 11px; }
.research-quality-alert p { margin: 5px 0; }
.research-quality-alert ul { margin: 7px 0 0; padding-left: 20px; }
.research-quality-limited, .research-quality-pending { color: #7a4b00; background: #fef7e0; border-color: #f4d58d; }
.research-quality-insufficient { color: var(--danger); background: #fce8e6; border-color: rgba(217, 48, 37, .18); }
.research-task-actions { justify-content: flex-end; }
.research-task-actions .research-cancel-action { color: var(--danger); background: rgba(217, 48, 37, .08); }
.research-report, .research-citations { padding-top: 4px; border-top: 1px solid var(--panel-line); }
.research-report h3, .research-citations h3 { color: var(--heading); }
.research-report-body { line-height: 1.7; overflow-wrap: anywhere; }
.research-report-body :deep(img) { max-width: 100%; }
.research-citations ol { display: grid; gap: 10px; padding: 0; list-style: none; }
.research-citations li { display: grid; gap: 4px; padding: 11px; background: var(--panel-muted); border-radius: 10px; }
.research-citations a, .research-citations strong { color: var(--heading); font-weight: 700; }
.research-citations span { color: var(--muted); font-size: .75rem; }
.research-citations p { margin: 0; }
.research-follow-up { display: grid; gap: 10px; padding: 14px; background: var(--accent-soft); border: 1px solid #cfe0ff; border-radius: 13px; }
.research-follow-up textarea { width: 100%; padding: 10px 11px; color: var(--text); background: #fff; border: 1px solid var(--panel-line); border-radius: 10px; line-height: 1.5; resize: vertical; }
.research-follow-up-context, .research-follow-up-actions > span { margin: 0; color: var(--muted); font-size: .8rem; line-height: 1.5; }
.research-follow-up-actions button { padding: 9px 12px; color: #fff; background: var(--accent-strong); border: 0; border-radius: 10px; font-weight: 700; }
.research-follow-up-actions button:disabled { cursor: not-allowed; opacity: .55; }
.research-empty-list, .research-welcome, .research-missing-task { padding: 28px 14px; color: var(--muted); text-align: center; }
.research-welcome, .research-missing-task { display: grid; justify-items: center; gap: 12px; min-height: 320px; align-content: center; }
@media (max-width: 760px) {
  .research-workspace { padding-inline: 0; }
  .research-workspace-header { align-items: flex-start; flex-direction: column; }
  .research-workspace-header > button { align-self: stretch; }
  .research-workspace-grid { grid-template-columns: 1fr; }
  .research-detail-open .research-list-pane, .research-draft-open .research-list-pane { display: none; }
  .research-workspace-grid:not(.research-detail-open):not(.research-draft-open) .research-detail-pane { display: none; }
  .research-mobile-back { display: inline-flex; }
  .research-task-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .research-stage-track { grid-template-columns: 1fr; }
  .research-stage-track li { grid-template-columns: 16px 1fr; align-items: center; text-align: left; }
  .research-stage-track li > span { width: 8px; height: 8px; }
}
</style>
