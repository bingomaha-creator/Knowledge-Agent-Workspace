<template>
  <section class="investigation-workspace" aria-labelledby="investigation-title">
    <header class="investigation-header">
      <div>
        <p class="section-label">Bug Intake Agent</p>
        <h2 id="investigation-title">把错误现场整理成可验证调查</h2>
        <p>事实由解析器提取，根因保持为假设；只有你确认后才会进入候选案例。</p>
      </div>
      <button
        type="button"
        class="investigation-primary"
        :disabled="!projectRef || store.busyIds.includes('create')"
        @click="startNew"
      >
        新建调查
      </button>
    </header>

    <div v-if="store.errorMessage" class="investigation-alert investigation-alert-error" role="alert">
      {{ store.errorMessage }}
    </div>
    <div v-if="store.noticeMessage" class="investigation-alert investigation-alert-notice">
      {{ store.noticeMessage }}
    </div>

    <div class="investigation-grid">
      <aside class="investigation-list" aria-label="调查列表">
        <button
          v-for="item in store.activeInvestigations"
          :key="item.id"
          type="button"
          class="investigation-list-item"
          :class="{ active: !creating && item.id === store.selectedId }"
          @click="selectInvestigation(item.id)"
        >
          <span class="investigation-list-topline">
            <strong>{{ item.title }}</strong>
            <span :class="`investigation-status investigation-status-${item.status}`">
              {{ statusLabel(item.status) }}
            </span>
          </span>
          <span>{{ item.evidence.length }} 项证据 · {{ qualityLabel(item.analysis.evidenceQuality) }}</span>
          <small>{{ formatTime(item.updatedAt) }}</small>
        </button>
        <div v-if="!store.loading && !store.activeInvestigations.length" class="investigation-empty">
          还没有调查。粘贴一段真实错误开始。
        </div>
      </aside>

      <section v-if="creating || !store.selected" class="investigation-intake">
        <header>
          <p class="section-label">New Investigation</p>
          <h3>添加第一份现场证据</h3>
        </header>
        <form class="investigation-form" @submit.prevent="createInvestigation">
          <label>
            <span>标题（可选）</span>
            <input v-model="newTitle" maxlength="160" placeholder="留空时从错误中自动提取" />
          </label>
          <EvidenceFields v-model="newEvidence" />
          <div class="investigation-form-footer">
            <span>提交前会自动遮盖 Token、Cookie 和常见密钥。</span>
            <button
              data-testid="create-investigation"
              type="submit"
              class="investigation-primary"
              :disabled="!newEvidence.content.trim() || !projectRef || store.busyIds.includes('create')"
            >
              {{ store.busyIds.includes('create') ? '调查中…' : '开始调查' }}
            </button>
          </div>
        </form>
      </section>

      <article v-else class="investigation-detail">
        <header class="investigation-detail-header">
          <div>
            <span :class="`investigation-status investigation-status-${store.selected.status}`">
              {{ statusLabel(store.selected.status) }}
            </span>
            <h3>{{ store.selected.title }}</h3>
            <p>
              {{ store.selected.evidence.length }} 项证据 ·
              {{ store.selected.runs.length }} 次分析 ·
              {{ qualityLabel(store.selected.analysis.evidenceQuality) }}
            </p>
          </div>
          <div v-if="store.selected.status === 'draft'" class="investigation-actions">
            <button
              v-if="!isAnalysisStale"
              type="button"
              :disabled="isSelectedBusy"
              @click="store.reanalyze(store.selected.id)"
            >
              重新分析
            </button>
            <button
              v-if="store.selected.candidateReadiness.ready"
              data-testid="convert-candidate"
              type="button"
              :disabled="isSelectedBusy"
              @click="convertSelected"
            >
              转为 Candidate
            </button>
            <button
              type="button"
              class="investigation-quiet-danger"
              :disabled="isSelectedBusy"
              @click="store.closeInvestigation(store.selected.id)"
            >
              关闭
            </button>
          </div>
        </header>

        <section data-testid="investigation-next-action" class="investigation-guidance-card">
          <header>
            <div>
              <span class="investigation-kicker">当前判断</span>
              <h4>{{ investigationStateTitle }}</h4>
            </div>
            <span :class="`quality-badge quality-${store.selected.analysis.evidenceQuality}`">
              {{ qualityLabel(store.selected.analysis.evidenceQuality) }}
            </span>
          </header>
          <p>{{ currentSummary }}</p>
          <p v-if="usesLegacyAnalysis" class="investigation-policy-notice">
            分析策略已更新；旧假设已隐藏。补充证据或重新分析后会生成新版结果。
          </p>
          <div v-if="nextAction" class="investigation-next-step">
            <span>下一步</span>
            <div>
              <strong>{{ nextAction.title }}</strong>
              <p>{{ nextAction.description }}</p>
            </div>
          </div>
          <p v-if="store.selected.analysis.reasonCode" class="investigation-diagnostic">
            降级原因：{{ reasonLabel(store.selected.analysis.reasonCode) }}
          </p>
        </section>

        <form
          v-if="store.selected.status === 'draft'"
          class="investigation-form append-evidence"
          @submit.prevent="appendEvidence"
        >
          <header>
            <div>
              <span class="investigation-kicker">补充现场</span>
              <h4>{{ nextAction?.title || '追加一份证据' }}</h4>
            </div>
            <span>提交后会基于全部证据重新分析</span>
          </header>
          <EvidenceFields
            v-if="!isAnalysisStale"
            v-model="appendDraft"
            :guidance="nextAction?.description"
          />
          <div v-else class="investigation-retry-analysis">
            <strong>证据已经保存</strong>
            <p>上一轮重新分析没有完成。再次提交只会重试分析，不会重复追加代码或日志。</p>
          </div>
          <div class="investigation-form-footer">
            <span v-if="isAnalysisStale">恢复成功后才能继续补充下一份证据。</span>
            <span v-else>仍可手动切换证据类型；系统只保存脱敏版本。</span>
            <button
              data-testid="append-evidence"
              type="submit"
              class="investigation-primary"
              :disabled="(!isAnalysisStale && !appendDraft.content.trim()) || isSelectedBusy"
            >
              {{ isSelectedBusy ? '分析中…' : isAnalysisStale ? '重新分析已保存证据' : '追加并重新分析' }}
            </button>
          </div>
        </form>

        <section class="investigation-section">
          <header>
            <h4>已确认事实</h4>
            <span>只来自当前现场，不包含根因推断</span>
          </header>
          <div class="fact-grid">
            <div>
              <span>错误标识</span>
              <strong>{{ joined([...store.selected.facts.errorTypes, ...(store.selected.facts.errorCodes || [])]) }}</strong>
            </div>
            <div>
              <span>文件位置</span>
              <strong>{{ joined(store.selected.facts.locations) }}</strong>
            </div>
            <div>
              <span>技术上下文</span>
              <strong>{{ joined([...(store.selected.facts.languages || []), ...store.selected.facts.frameworks, ...store.selected.facts.environments]) }}</strong>
            </div>
            <div>
              <span>复现步骤</span>
              <strong>{{ joined(store.selected.facts.reproductionSteps) }}</strong>
            </div>
          </div>
          <details v-if="store.selected.facts.errorSignatures.length">
            <summary>查看 Error Signature</summary>
            <code v-for="signature in store.selected.facts.errorSignatures" :key="signature">
              {{ signature }}
            </code>
          </details>
        </section>

        <InvestigationHypotheses :hypotheses="visibleHypotheses" />
        <InvestigationVerificationPlan :steps="visibleVerificationSteps" />
        <InvestigationTechnicalDetails :investigation="store.selected" />
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Ref } from 'vue';
import { useBugInvestigationStore } from '../investigation-store';
import type {
  BugEvidenceInput,
  BugEvidenceType,
  BugInvestigationStatus,
  EvidenceQuality
} from '../investigation-types';
import EvidenceFields from './EvidenceFields.vue';
import InvestigationHypotheses from './InvestigationHypotheses.vue';
import InvestigationVerificationPlan from './InvestigationVerificationPlan.vue';
import InvestigationTechnicalDetails from './InvestigationTechnicalDetails.vue';

const props = defineProps<{ projectRef: string }>();
const emit = defineEmits<{ converted: [candidateId: string] }>();
const store = useBugInvestigationStore();
const creating = ref(false);
const newTitle = ref('');

function emptyEvidence(type: BugEvidenceType = 'error'): BugEvidenceInput {
  return {
    type,
    content: '',
    metadata: { fileName: '', language: '', lineStart: null }
  };
}

const newEvidence = ref<BugEvidenceInput>(emptyEvidence());
const appendDraft = ref<BugEvidenceInput>(emptyEvidence('reproduction'));

const isSelectedBusy = computed(() =>
  Boolean(store.selected && store.busyIds.includes(store.selected.id))
);
const isAnalysisStale = computed(() => store.selected?.analysis.status === 'stale');
const usesLegacyAnalysis = computed(() => {
  const analysis = store.selected?.analysis;
  return Boolean(
    analysis
    && analysis.hypotheses.length
    && analysis.policyVersion !== 'bug-investigation-grounding-v4'
  );
});
const visibleHypotheses = computed(() =>
  usesLegacyAnalysis.value ? [] : store.selected?.analysis.hypotheses || []
);
const visibleVerificationSteps = computed(() =>
  usesLegacyAnalysis.value ? [] : store.selected?.analysis.verificationSteps || []
);
const currentSummary = computed(() => {
  if (usesLegacyAnalysis.value) {
    return '当前仅保留错误类型、文件位置等已确认事实；旧策略生成的推断不再作为调查依据。';
  }
  return store.selected?.analysis.summary || '尚未运行分析。';
});

function inferEvidenceType(description: string): BugEvidenceType {
  if (/源码|代码|函数|调用点|文件片段/u.test(description)) return 'code';
  if (/网络|请求|响应|response|header|状态码|请求体|响应体/iu.test(description)) return 'network';
  if (/复现|操作步骤|触发步骤/u.test(description)) return 'reproduction';
  if (/环境|版本|浏览器|运行时/u.test(description)) return 'environment';
  if (/验证|观察结果|日志/u.test(description)) return 'verification';
  if (/error|stack|异常|报错|失败输出/iu.test(description)) return 'error';
  return 'note';
}

const nextAction = computed(() => {
  const selected = store.selected;
  if (!selected) return null;
  if (selected.analysis.nextAction) return selected.analysis.nextAction;
  const description = selected.analysis.missingEvidence[0]
    || selected.analysis.verificationSteps[0]?.instruction
    || '';
  if (!description) return null;
  return {
    title: selected.analysis.missingEvidence.length ? '补充关键证据' : '执行一次定向验证',
    description,
    evidenceType: selected.analysis.missingEvidence.length
      ? inferEvidenceType(description)
      : 'verification' as const
  };
});
const investigationStateTitle = computed(() => {
  const selected = store.selected;
  if (
    selected?.analysis.hypotheses.length
    && selected.facts.verificationNotes.length
  ) {
    return '已记录验证结果，可整理 Candidate';
  }
  if (selected?.analysis.hypotheses.length) return '已生成调查方向，待验证';
  const quality = store.selected?.analysis.evidenceQuality;
  if (quality === 'insufficient') return '目前还不能形成根因假设';
  if (quality === 'limited') return '目前只能形成有限假设';
  if (quality === 'sufficient') return '已有可验证的调查方向';
  return '等待首次分析';
});

watch(
  () => props.projectRef,
  (projectRef) => {
    creating.value = false;
    void store.initialize(projectRef);
  },
  { immediate: true }
);

watch(
  () => [store.selected?.id, nextAction.value?.evidenceType] as const,
  ([, evidenceType]) => {
    if (!evidenceType || appendDraft.value.content.trim()) return;
    appendDraft.value = {
      ...appendDraft.value,
      type: evidenceType,
      metadata: { ...appendDraft.value.metadata }
    };
  },
  { immediate: true }
);

watch(
  () => store.draftSeed,
  (seed) => {
    if (!seed) return;
    creating.value = true;
    newTitle.value = seed.title || '';
    newEvidence.value = {
      ...seed.evidence,
      metadata: { ...seed.evidence.metadata }
    };
  },
  { immediate: true }
);

function resetEvidence(target: Ref<BugEvidenceInput>, type: BugEvidenceType) {
  target.value = emptyEvidence(type);
}

function startNew() {
  creating.value = true;
  newTitle.value = '';
  resetEvidence(newEvidence, 'error');
}

function selectInvestigation(id: string) {
  creating.value = false;
  store.selectedId = id;
}

async function createInvestigation() {
  const id = await store.createAndAnalyze({
    projectRef: props.projectRef,
    title: newTitle.value.trim() || undefined,
    evidence: {
      ...newEvidence.value,
      metadata: { ...newEvidence.value.metadata }
    }
  });
  if (!id) return;
  creating.value = false;
  newTitle.value = '';
  resetEvidence(newEvidence, 'error');
  store.clearDraft();
}

async function appendEvidence() {
  if (!store.selected) return;
  const succeeded = await store.appendAndAnalyze(store.selected.id, {
    ...appendDraft.value,
    metadata: { ...appendDraft.value.metadata }
  });
  if (succeeded) resetEvidence(appendDraft, 'reproduction');
}

async function convertSelected() {
  if (!store.selected) return;
  const converted = await store.convertToCandidate(store.selected.id);
  if (converted && store.selected?.candidateBugCaseId) {
    emit('converted', store.selected.candidateBugCaseId);
  }
}

function joined(values: string[]) {
  return values.length ? values.join(' · ') : '尚未观察到';
}

function formatTime(timestamp: number) {
  if (!timestamp) return '刚刚';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(timestamp);
}

function statusLabel(status: BugInvestigationStatus) {
  return {
    draft: '调查中',
    converted: '已转候选',
    closed: '已关闭'
  }[status];
}

function qualityLabel(quality: EvidenceQuality) {
  return {
    pending: '待分析',
    sufficient: '证据充分',
    limited: '证据有限',
    insufficient: '证据不足'
  }[quality];
}

function reasonLabel(reason: string) {
  return {
    model_unavailable: '模型暂不可用',
    invalid_model_output: '模型输出不符合结构',
    evidence_insufficient: '现场证据不足'
  }[reason] || reason;
}
</script>

<style scoped>
.investigation-workspace { display: grid; gap: 16px; }
.investigation-header, .investigation-detail-header, .investigation-guidance-card header, .investigation-section > header, .investigation-form > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.investigation-header h2, .investigation-detail-header h3, .investigation-intake h3 { margin: 3px 0 5px; }
.investigation-header p, .investigation-detail-header p { margin: 0; color: var(--muted); }
.investigation-primary { padding: 10px 15px; color: #fff; background: var(--accent-strong); border: 0; border-radius: 11px; font-weight: 700; }
.investigation-primary:disabled { opacity: 0.5; }
.investigation-alert { padding: 11px 14px; border-radius: 12px; white-space: pre-line; }
.investigation-alert-error { color: var(--danger); background: #fce8e6; }
.investigation-alert-notice { color: #286b3a; background: #eaf7ed; }
.investigation-grid { display: grid; grid-template-columns: minmax(230px, 0.5fr) minmax(0, 1.5fr); gap: 14px; align-items: start; }
.investigation-list, .investigation-detail, .investigation-intake { min-width: 0; }
.investigation-list { display: grid; gap: 8px; }
.investigation-list-item { display: grid; gap: 7px; width: 100%; min-width: 0; padding: 13px; text-align: left; color: var(--text); background: var(--panel); border: 1px solid var(--panel-line); border-radius: 13px; }
.investigation-list-item:hover, .investigation-list-item.active { border-color: var(--accent); background: var(--panel-muted); }
.investigation-list-topline { display: flex; min-width: 0; justify-content: space-between; gap: 8px; }
.investigation-list-topline strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.investigation-list-item > span:not(.investigation-list-topline), .investigation-list-item small { color: var(--muted); font-size: 0.76rem; }
.investigation-status, .quality-badge { display: inline-flex; width: fit-content; padding: 4px 8px; border-radius: 999px; font-size: 0.72rem; white-space: nowrap; }
.investigation-status-draft, .quality-limited { color: #7a4b00; background: #fef3df; }
.investigation-status-converted, .quality-sufficient { color: #1e7a38; background: #e6f4ea; }
.investigation-status-closed, .quality-pending { color: var(--muted); background: var(--panel-muted); }
.quality-insufficient { color: var(--danger); background: #fce8e6; }
.investigation-intake, .investigation-detail { display: grid; gap: 14px; padding: 18px; background: var(--panel); border: 1px solid var(--panel-line); border-radius: 18px; }
.investigation-form { display: grid; gap: 13px; }
.investigation-form label { display: grid; gap: 6px; color: var(--muted); font-size: 0.8rem; }
.investigation-form input { padding: 10px 11px; border: 1px solid var(--panel-line); border-radius: 10px; }
.investigation-form-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 0.78rem; }
.investigation-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.investigation-actions button { padding: 8px 10px; color: var(--text); background: var(--panel); border: 1px solid var(--panel-line); border-radius: 9px; }
.investigation-actions .investigation-primary { color: #fff; background: var(--accent-strong); border-color: transparent; }
.investigation-actions .investigation-quiet-danger { color: var(--danger); }
.investigation-guidance-card, .investigation-section { padding: 15px; background: var(--panel-muted); border: 1px solid var(--panel-line); border-radius: 14px; }
.investigation-guidance-card { border-color: color-mix(in srgb, var(--accent) 45%, var(--panel-line)); }
.investigation-guidance-card h4, .investigation-section h4, .investigation-form h4 { margin: 2px 0; }
.investigation-guidance-card > p { margin: 10px 0 0; line-height: 1.65; }
.investigation-kicker { color: var(--accent-strong); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; }
.investigation-diagnostic { color: var(--muted); font-size: 0.8rem; }
.investigation-policy-notice { padding: 9px 11px; color: #7a4b00; background: #fef3df; border-radius: 9px; font-size: 0.8rem; }
.investigation-next-step { display: grid; grid-template-columns: auto 1fr; gap: 10px; margin-top: 14px; padding: 12px; background: var(--panel); border-radius: 11px; }
.investigation-next-step > span { height: fit-content; padding: 4px 7px; color: var(--accent-strong); background: var(--panel-muted); border-radius: 7px; font-size: 0.7rem; font-weight: 700; }
.investigation-next-step p { margin: 4px 0 0; color: var(--muted); font-size: 0.84rem; }
.investigation-section { display: grid; gap: 12px; }
.investigation-section > header span, .investigation-form > header span { color: var(--muted); font-size: 0.76rem; }
.fact-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.fact-grid div { display: grid; gap: 5px; padding: 10px; background: var(--panel); border-radius: 10px; }
.fact-grid span { color: var(--muted); font-size: 0.7rem; }
.fact-grid strong { font-size: 0.84rem; overflow-wrap: anywhere; }
.investigation-section details code { display: block; margin-top: 7px; padding: 7px 9px; background: var(--panel); border-radius: 8px; overflow-wrap: anywhere; white-space: pre-wrap; }
.append-evidence { padding: 15px; background: var(--panel-muted); border: 1px solid var(--panel-line); border-radius: 14px; }
.investigation-retry-analysis { padding: 13px 14px; color: var(--muted); background: var(--panel); border: 1px solid var(--panel-line); border-radius: 12px; }
.investigation-retry-analysis strong { color: var(--text); }
.investigation-retry-analysis p { margin: 5px 0 0; }
.investigation-empty { padding: 28px 14px; text-align: center; color: var(--muted); border: 1px dashed var(--panel-line); border-radius: 13px; }
@media (max-width: 1000px) { .investigation-grid { grid-template-columns: 1fr; } .investigation-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 680px) { .investigation-header, .investigation-detail-header, .investigation-form-footer { align-items: stretch; flex-direction: column; } .fact-grid, .investigation-list { grid-template-columns: 1fr; } }
</style>
