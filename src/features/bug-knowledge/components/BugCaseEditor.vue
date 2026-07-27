<template>
  <section class="bug-editor" aria-labelledby="bug-editor-title">
    <header class="bug-editor-header">
      <div>
        <p class="section-label">{{ bugCase ? 'Edit BugCase' : 'New BugCase' }}</p>
        <h2 id="bug-editor-title">{{ bugCase ? bugCase.title : '创建人工候选' }}</h2>
      </div>
      <span v-if="bugCase" class="bug-editor-state">
        {{ bugCase.reviewStatus }} · {{ bugCase.status }}
      </span>
    </header>

    <form class="bug-editor-form" @submit.prevent="submit">
      <label>
        <span>标题</span>
        <input v-model="form.title" required maxlength="160" />
      </label>
      <label>
        <span>症状</span>
        <textarea v-model="form.symptom" required rows="3"></textarea>
      </label>
      <label>
        <span>错误签名（每行一条）</span>
        <textarea v-model="form.errorSignatures" rows="3"></textarea>
      </label>
      <label>
        <span>复现步骤（每行一步）</span>
        <textarea v-model="form.reproductionSteps" rows="3"></textarea>
      </label>

      <div class="bug-editor-grid">
        <label><span>语言</span><input v-model="form.language" /></label>
        <label><span>框架</span><input v-model="form.framework" /></label>
        <label><span>版本（逗号分隔）</span><input v-model="form.versions" /></label>
        <label><span>模块</span><input v-model="form.module" /></label>
      </div>
      <label><span>环境</span><input v-model="form.environment" /></label>

      <label>
        <span>解决类型</span>
        <select v-model="form.resolutionType">
          <option value="root_cause_fix">已知根因与修复</option>
          <option value="verified_workaround">根因未知但已验证的 workaround</option>
        </select>
      </label>
      <label v-if="form.resolutionType === 'root_cause_fix'">
        <span>根因</span>
        <textarea v-model="form.rootCause" rows="3"></textarea>
      </label>
      <div v-else class="root-cause-unknown">根因未知：确认时不会把 workaround 伪装成根因修复。</div>
      <label>
        <span>修复 / Workaround</span>
        <textarea v-model="form.fix" required rows="3"></textarea>
      </label>
      <label v-if="form.resolutionType === 'verified_workaround'">
        <span>Workaround 风险（每行一项）</span>
        <textarea v-model="form.workaroundRisks" rows="2"></textarea>
      </label>
      <label>
        <span>适用范围（每行一项）</span>
        <textarea v-model="form.applicability" rows="2"></textarea>
      </label>
      <label>
        <span>验证过程</span>
        <textarea v-model="form.verification" data-testid="bug-verification" rows="3"></textarea>
      </label>
      <div class="bug-editor-grid">
        <label><span>标签（逗号分隔）</span><input v-model="form.tags" /></label>
        <label><span>来源（每行一条）</span><textarea v-model="form.sourceRefs" rows="2"></textarea></label>
      </div>

      <button class="bug-primary-button" type="submit" :disabled="busy || !projectRef">
        {{ bugCase ? '保存并重新建索引' : '创建候选' }}
      </button>
    </form>

    <section v-if="bugCase" class="bug-review-box">
      <label>
        <span>审核原因</span>
        <textarea v-model="reviewReason" rows="2" placeholder="记录为什么确认或拒绝"></textarea>
      </label>
      <p
        v-if="confirmationBlocker"
        data-testid="bug-confirmation-blocker"
        class="bug-review-blocker"
        role="status"
      >{{ confirmationBlocker }}</p>
      <p v-if="errorMessage" class="bug-review-error" role="alert">{{ errorMessage }}</p>
      <div class="bug-editor-actions">
        <button
          v-if="bugCase.reviewStatus === 'candidate'"
          data-testid="bug-confirm"
          type="button"
          :disabled="busy || Boolean(confirmationBlocker)"
          @click="review('confirmed')"
        >确认</button>
        <button
          v-if="bugCase.reviewStatus !== 'rejected'"
          type="button"
          :disabled="busy || Boolean(reviewBlocker)"
          @click="review('rejected')"
        >拒绝 / 撤销确认</button>
        <button
          v-if="bugCase.reviewStatus === 'confirmed' && bugCase.scope === 'project'"
          type="button"
          :disabled="busy || bugCase.status !== 'ready'"
          @click="emit('promote', bugCase.id)"
        >提升到公共库</button>
        <button class="bug-danger-button" type="button" :disabled="busy" @click="emit('delete', bugCase.id)">
          删除
        </button>
      </div>
      <p v-if="bugCase.reviewReason" class="bug-review-audit">
        最近审核：{{ bugCase.reviewedBy || '服务端用户' }} · {{ bugCase.reviewReason }}
      </p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type {
  BugCase,
  BugCaseDraft,
  BugCasePatch,
  BugResolutionType
} from '../types';

const props = defineProps<{
  bugCase: BugCase | null;
  projectRef: string;
  busy: boolean;
  errorMessage?: string;
}>();

const emit = defineEmits<{
  create: [draft: BugCaseDraft];
  update: [payload: { id: string; patch: BugCasePatch }];
  review: [payload: { id: string; status: 'confirmed' | 'rejected'; reason: string }];
  delete: [id: string];
  promote: [id: string];
}>();

interface EditorForm {
  title: string;
  symptom: string;
  errorSignatures: string;
  reproductionSteps: string;
  language: string;
  framework: string;
  versions: string;
  module: string;
  environment: string;
  resolutionType: BugResolutionType;
  rootCause: string;
  fix: string;
  workaroundRisks: string;
  applicability: string;
  verification: string;
  tags: string;
  sourceRefs: string;
}

function blankForm(): EditorForm {
  return {
    title: '', symptom: '', errorSignatures: '', reproductionSteps: '',
    language: '', framework: '', versions: '', module: '', environment: '',
    resolutionType: 'root_cause_fix', rootCause: '', fix: '', workaroundRisks: '',
    applicability: '', verification: '', tags: '', sourceRefs: ''
  };
}

const form = reactive<EditorForm>(blankForm());
const reviewReason = ref('');

function lines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function commaList(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

watch(
  () => props.bugCase,
  (bugCase) => {
    reviewReason.value = '';
    if (!bugCase) {
      Object.assign(form, blankForm());
      return;
    }
    Object.assign(form, {
      title: bugCase.title,
      symptom: bugCase.symptom,
      errorSignatures: bugCase.errorSignatures.join('\n'),
      reproductionSteps: bugCase.reproductionSteps.join('\n'),
      language: bugCase.context.language,
      framework: bugCase.context.framework,
      versions: bugCase.context.versions.join(', '),
      module: bugCase.context.module,
      environment: bugCase.context.environment,
      resolutionType: bugCase.resolutionType,
      rootCause: bugCase.rootCause || '',
      fix: bugCase.fix,
      workaroundRisks: bugCase.workaroundRisks.join('\n'),
      applicability: bugCase.applicability.join('\n'),
      verification: bugCase.verification,
      tags: bugCase.tags.join(', '),
      sourceRefs: bugCase.sourceRefs.join('\n')
    });
  },
  { immediate: true }
);

function draft(): BugCaseDraft {
  return {
    sourceProjectRef: props.projectRef,
    title: form.title.trim(),
    symptom: form.symptom.trim(),
    errorSignatures: lines(form.errorSignatures),
    reproductionSteps: lines(form.reproductionSteps),
    context: {
      language: form.language.trim(),
      framework: form.framework.trim(),
      versions: commaList(form.versions),
      module: form.module.trim(),
      environment: form.environment.trim()
    },
    resolutionType: form.resolutionType,
    rootCause: form.resolutionType === 'verified_workaround' ? null : form.rootCause.trim() || null,
    fix: form.fix.trim(),
    workaroundRisks: lines(form.workaroundRisks),
    applicability: lines(form.applicability),
    verification: form.verification.trim(),
    tags: commaList(form.tags),
    sourceRefs: lines(form.sourceRefs)
  };
}

function savedDraft(bugCase: BugCase): BugCaseDraft {
  return {
    sourceProjectRef: bugCase.sourceProjectRef,
    title: bugCase.title,
    symptom: bugCase.symptom,
    errorSignatures: bugCase.errorSignatures,
    reproductionSteps: bugCase.reproductionSteps,
    context: bugCase.context,
    resolutionType: bugCase.resolutionType,
    rootCause: bugCase.rootCause,
    fix: bugCase.fix,
    workaroundRisks: bugCase.workaroundRisks,
    applicability: bugCase.applicability,
    verification: bugCase.verification,
    tags: bugCase.tags,
    sourceRefs: bugCase.sourceRefs
  };
}

const hasUnsavedChanges = computed(() => {
  if (!props.bugCase) return false;
  return JSON.stringify(draft()) !== JSON.stringify(savedDraft(props.bugCase));
});

function savedConfirmationRequirement(bugCase: BugCase) {
  if (!bugCase.fix) return '缺少已保存的修复 / Workaround。';
  const context = bugCase.context;
  if (!context.language && !context.framework && !context.versions.length && !context.module && !context.environment) {
    return '缺少已保存的技术上下文。';
  }
  if (!bugCase.errorSignatures.length && !bugCase.reproductionSteps.length) {
    return '缺少已保存的错误签名或复现步骤。';
  }
  if (!bugCase.verification) return '缺少已保存的验证过程。请填写后先保存并重新建索引。';
  if (!bugCase.sourceRefs.length) return '缺少已保存的来源记录。';
  if (bugCase.resolutionType === 'root_cause_fix' && !bugCase.rootCause) {
    return '缺少已保存的根因。';
  }
  if (bugCase.resolutionType === 'verified_workaround') {
    if (!bugCase.workaroundRisks.length) return '缺少已保存的 Workaround 风险。';
    if (!bugCase.applicability.length) return '缺少已保存的适用范围。';
  }
  return '';
}

const reviewBlocker = computed(() => {
  if (!props.bugCase) return '请先创建 Candidate。';
  if (props.bugCase.status !== 'ready') return '等待索引完成后才能审核。';
  if (hasUnsavedChanges.value) return '当前修改尚未保存。请先保存并重新建索引，待状态恢复为 ready 后再审核。';
  if (!reviewReason.value.trim()) return '请填写审核原因。';
  return '';
});

const confirmationBlocker = computed(() => {
  const reviewReasonBlocker = reviewBlocker.value;
  if (reviewReasonBlocker) return reviewReasonBlocker;
  return props.bugCase ? savedConfirmationRequirement(props.bugCase) : '';
});

function submit() {
  const value = draft();
  if (!props.bugCase) {
    emit('create', value);
    return;
  }
  const { sourceProjectRef: _identity, ...patch } = value;
  emit('update', { id: props.bugCase.id, patch });
}

function review(status: 'confirmed' | 'rejected') {
  if (!props.bugCase || !reviewReason.value.trim()) return;
  emit('review', {
    id: props.bugCase.id,
    status,
    reason: reviewReason.value.trim()
  });
}
</script>

<style scoped>
.bug-editor { padding: 18px; background: var(--panel); border: 1px solid var(--panel-line); border-radius: 18px; }
.bug-editor-header, .bug-editor-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.bug-editor-header h2 { margin: 2px 0 0; font-size: 1.05rem; }
.bug-editor-state { color: var(--muted); font-size: 0.78rem; }
.bug-editor-form, .bug-review-box { display: grid; gap: 12px; margin-top: 16px; }
.bug-editor-form label, .bug-review-box label { display: grid; gap: 6px; color: var(--muted); font-size: 0.8rem; }
.bug-editor input, .bug-editor textarea, .bug-editor select { width: 100%; padding: 9px 10px; color: var(--text); background: #fff; border: 1px solid var(--panel-line); border-radius: 10px; resize: vertical; }
.bug-editor-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.bug-primary-button { padding: 10px 14px; color: #fff; background: var(--accent-strong); border: 0; border-radius: 10px; }
.bug-review-box { padding-top: 15px; border-top: 1px solid var(--panel-line); }
.bug-editor-actions { justify-content: flex-start; flex-wrap: wrap; }
.bug-editor-actions button { padding: 8px 11px; color: var(--text); background: var(--panel-muted); border: 1px solid var(--panel-line); border-radius: 9px; }
.bug-editor-actions .bug-danger-button { color: var(--danger); }
.bug-review-blocker { margin: 0; color: #7a4b00; font-size: 0.85rem; }
.bug-review-error { margin: 0; color: var(--danger); font-size: 0.85rem; }
.root-cause-unknown { padding: 10px; color: var(--warning); background: #fef7e0; border-radius: 10px; }
.bug-review-audit { margin: 0; color: var(--muted); font-size: 0.78rem; }
@media (max-width: 760px) { .bug-editor-grid { grid-template-columns: 1fr; } }
</style>
