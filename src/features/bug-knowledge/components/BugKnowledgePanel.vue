<template>
  <section class="bug-workspace" aria-labelledby="bug-workspace-title">
    <header class="bug-workspace-header">
      <div>
        <p class="section-label">Bug Investigation & Knowledge</p>
        <h1 id="bug-workspace-title">Bug 调查与案例库</h1>
        <p>从原始错误开始调查，经过人工验证后沉淀为可复用案例。</p>
      </div>
      <button type="button" :disabled="store.loading" @click="store.initialize">
        {{ store.loading ? '同步中…' : '同步服务端状态' }}
      </button>
    </header>

    <div v-if="store.errorMessage" class="bug-alert bug-alert-error" role="alert">
      {{ store.errorMessage }}
    </div>
    <div v-if="store.noticeMessage" class="bug-alert bug-alert-notice">
      {{ store.noticeMessage }}
    </div>

    <nav class="bug-section-tabs" aria-label="Bug 工作区">
      <button
        v-for="section in sections"
        :key="section.id"
        type="button"
        :class="{ active: activeSection === section.id }"
        @click="switchSection(section.id)"
      >
        <strong>{{ section.label }}</strong>
        <span>{{ section.description }}</span>
      </button>
    </nav>

    <section class="bug-project-bar" aria-label="项目和筛选">
      <label>
        <span>当前项目</span>
        <select v-model="store.selectedProjectRef" class="workspace-filter-select">
          <option v-for="project in store.projects" :key="project.projectRef" :value="project.projectRef">
            {{ project.name }}
          </option>
        </select>
      </label>
      <form class="bug-project-create" @submit.prevent="createProject">
        <input v-model="projectName" maxlength="80" placeholder="新项目显示名" />
        <button type="submit" :disabled="!projectName.trim() || store.busyIds.includes('project:create')">
          添加项目
        </button>
      </form>
      <button
        v-if="activeSection === 'review'"
        type="button"
        :disabled="!store.selectedProjectRef"
        @click="store.selectedCaseId = ''"
      >
        新建 BugCase
      </button>
    </section>

    <BugInvestigationWorkspace
      v-if="activeSection === 'investigations'"
      :project-ref="store.selectedProjectRef"
      @converted="openCandidate"
    />

    <template v-else-if="activeSection === 'review'">
      <section class="bug-filter-bar">
        <label><span>范围</span><select v-model="store.scopeFilter" class="workspace-filter-select"><option value="all">全部</option><option value="project">当前项目</option><option value="common">公共库</option></select></label>
        <label><span>审核状态</span><select v-model="store.reviewStatusFilter" class="workspace-filter-select"><option value="all">全部</option><option value="candidate">待审核</option><option value="confirmed">已确认</option><option value="rejected">已拒绝</option></select></label>
        <label><span>语言</span><select v-model="store.languageFilter" class="workspace-filter-select"><option value="">全部</option><option v-for="language in store.languages" :key="language">{{ language }}</option></select></label>
        <label><span>框架</span><select v-model="store.frameworkFilter" class="workspace-filter-select"><option value="">全部</option><option v-for="framework in store.frameworks" :key="framework">{{ framework }}</option></select></label>
      </section>

      <div class="bug-main-grid">
        <BugCaseList
          :cases="store.visibleCases"
          :projects="store.projects"
          :selected-id="store.selectedCaseId"
          @select="store.selectedCaseId = $event"
        />
        <BugCaseEditor
          :bug-case="store.selectedCase"
          :project-ref="store.selectedProjectRef"
          :busy="Boolean(store.selectedCase && store.busyIds.includes(store.selectedCase.id)) || store.busyIds.includes('case:create')"
          :error-message="store.errorMessage"
          @create="store.createCase"
          @update="store.updateCase($event.id, $event.patch)"
          @review="handleReview($event.id, $event.status, $event.reason)"
          @delete="store.deleteCase"
          @promote="store.promoteCase"
        />
      </div>
    </template>

    <section v-else class="bug-search" aria-labelledby="bug-search-title">
      <header>
        <div>
          <p class="section-label">Hybrid Retrieval</p>
          <h2 id="bug-search-title">检索已确认案例</h2>
        </div>
        <label class="bug-common-toggle">
          <input v-model="store.includeCommon" type="checkbox" /> 包含公共库
        </label>
      </header>
      <section class="confirmed-case-overview" aria-labelledby="confirmed-case-overview-title">
        <header>
          <div>
            <p class="section-label">Confirmed knowledge</p>
            <h3 id="confirmed-case-overview-title">已确认案例</h3>
          </div>
          <span>{{ store.visibleCases.length }} 条</span>
        </header>
        <div data-testid="confirmed-case-list" class="confirmed-case-grid">
          <BugCaseList
            :cases="store.visibleCases"
            :projects="store.projects"
            :selected-id="store.selectedCaseId"
            @select="store.selectedCaseId = $event"
          />
          <article v-if="selectedConfirmedCase" data-testid="confirmed-case-detail" class="confirmed-case-detail">
            <p class="section-label">Confirmed BugCase</p>
            <h3>{{ selectedConfirmedCase.title }}</h3>
            <p>{{ selectedConfirmedCase.symptom }}</p>
            <dl>
              <div><dt>根因</dt><dd>{{ selectedConfirmedCase.rootCause || '根因未知' }}</dd></div>
              <div><dt>修复</dt><dd>{{ selectedConfirmedCase.fix }}</dd></div>
              <div><dt>验证</dt><dd>{{ selectedConfirmedCase.verification }}</dd></div>
            </dl>
          </article>
          <div v-else class="confirmed-case-empty">还没有已确认案例。</div>
        </div>
      </section>
      <form class="bug-search-form" @submit.prevent="store.search">
        <textarea
          v-model="store.searchQuery"
          data-testid="bug-search-input"
          rows="3"
          maxlength="8000"
          placeholder="粘贴异常、堆栈，或用中文描述症状"
        ></textarea>
        <button data-testid="bug-search-submit" type="submit" :disabled="store.searching || !store.searchQuery.trim()">
          {{ store.searching ? '检索中…' : '检索 BugCase' }}
        </button>
      </form>

      <details v-if="otherProjects.length" class="bug-extra-projects">
        <summary>显式加入其他项目私有案例</summary>
        <label v-for="project in otherProjects" :key="project.projectRef">
          <input v-model="store.additionalProjectRefs" type="checkbox" :value="project.projectRef" />
          {{ project.name }}
        </label>
      </details>

      <div v-if="store.searchTrace.ambiguous" class="bug-alert bug-alert-notice">
        同一错误签名存在多个上下文可能，结果保留为歧义候选，请核对框架与版本。
      </div>
      <div v-if="store.searchTrace.evidenceGap && !store.searchResults.length" class="bug-search-empty">
        当前允许范围内没有足够证据；未自动扩展到其他项目。
      </div>

      <div class="bug-search-results">
        <article v-for="result in store.searchResults" :key="result.bugCase.id" class="bug-search-result">
          <header>
            <div>
              <span class="bug-result-rank">#{{ result.rank }}</span>
              <h3>{{ result.bugCase.title }}</h3>
            </div>
            <span>{{ result.matchedChannels.join(' + ') }}</span>
          </header>
          <p>{{ result.bugCase.symptom }}</p>
          <dl>
            <div><dt>来源项目</dt><dd>{{ projectNameFor(result.bugCase.sourceProjectRef) }}</dd></div>
            <div><dt>版本</dt><dd>{{ result.bugCase.context.versions.join(', ') || '未记录' }}</dd></div>
            <div><dt>类型</dt><dd>{{ resolutionLabel(result.bugCase.resolutionType) }}</dd></div>
            <div><dt>根因</dt><dd>{{ result.bugCase.rootCause || '根因未知' }}</dd></div>
          </dl>
          <p><strong>修复：</strong>{{ result.bugCase.fix }}</p>
          <p v-if="result.bugCase.workaroundRisks.length"><strong>风险：</strong>{{ result.bugCase.workaroundRisks.join('；') }}</p>
          <p v-if="result.bugCase.applicability.length"><strong>适用：</strong>{{ result.bugCase.applicability.join('；') }}</p>
          <p v-if="result.bugCase.verification"><strong>验证：</strong>{{ result.bugCase.verification }}</p>
          <details v-if="result.citations.length" class="bug-result-citations">
            <summary>支持性引用（{{ result.citations.length }}）</summary>
            <div v-for="citation in result.citations" :key="citation.id" class="bug-citation-snippet" v-html="renderCitation(citation.snippet)"></div>
          </details>
        </article>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { renderMarkdown } from '@/services/markdown';
import { useBugKnowledgeStore } from '../store';
import type { BugResolutionType } from '../types';
import BugCaseEditor from './BugCaseEditor.vue';
import BugCaseList from './BugCaseList.vue';
import BugInvestigationWorkspace from './BugInvestigationWorkspace.vue';

const store = useBugKnowledgeStore();
const projectName = ref('');
type BugSection = 'investigations' | 'review' | 'library';
const activeSection = ref<BugSection>('investigations');
const sections: Array<{ id: BugSection; label: string; description: string }> = [
  { id: 'investigations', label: '调查中', description: '整理现场与验证假设' },
  { id: 'review', label: '待审核', description: '确认或拒绝 Candidate' },
  { id: 'library', label: '案例库', description: '只检索 Confirmed' }
];
const otherProjects = computed(() => store.projects.filter(
  (project) => project.projectRef !== store.selectedProjectRef
));
const selectedConfirmedCase = computed(() => {
  const selected = store.selectedCase;
  return selected?.reviewStatus === 'confirmed' ? selected : null;
});

onMounted(() => { void store.initialize(); });

function switchSection(section: BugSection) {
  activeSection.value = section;
  if (section === 'review') {
    store.reviewStatusFilter = 'candidate';
    store.selectedCaseId = store.visibleCases[0]?.id || '';
  }
  if (section === 'library') {
    store.reviewStatusFilter = 'confirmed';
    store.selectedCaseId = store.visibleCases[0]?.id || '';
  }
}

async function openCandidate(candidateId: string) {
  await store.refreshCases();
  activeSection.value = 'review';
  store.reviewStatusFilter = 'candidate';
  store.selectedCaseId = candidateId;
}

async function handleReview(
  id: string,
  status: 'confirmed' | 'rejected',
  reason: string
) {
  const reviewed = await store.reviewCase(id, status, reason);
  if (reviewed && status === 'confirmed') {
    activeSection.value = 'library';
    store.reviewStatusFilter = 'confirmed';
    store.selectedCaseId = id;
  }
}

async function createProject() {
  const name = projectName.value.trim();
  if (!name) return;
  if (await store.createProject({ name })) projectName.value = '';
}

function projectNameFor(projectRef: string) {
  return store.projects.find((project) => project.projectRef === projectRef)?.name || projectRef;
}

function resolutionLabel(type: BugResolutionType) {
  return type === 'verified_workaround' ? '已验证 workaround（根因未知）' : '根因修复';
}

// 与聊天/研究报告复用同一 MarkdownIt(html=false) + DOMPurify 边界；citation 永不直接 v-html 原文。
function renderCitation(content: string) {
  return renderMarkdown(content || '');
}
</script>

<style scoped>
.bug-workspace { display: grid; align-content: start; gap: 18px; min-height: 0; padding: 18px 6px 36px; overflow: auto; }
.bug-workspace-header, .bug-project-bar, .bug-filter-bar, .bug-search header, .bug-search-result header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.bug-workspace-header h1, .bug-search h2 { margin: 2px 0 4px; }
.bug-workspace-header p { margin: 0; color: var(--muted); }
.bug-workspace button, .bug-workspace select, .bug-workspace input, .bug-workspace textarea { font: inherit; }
.bug-workspace-header button, .bug-project-bar button { padding: 9px 12px; color: var(--text); background: var(--panel); border: 1px solid var(--panel-line); border-radius: 10px; }
.bug-section-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.bug-section-tabs button { display: grid; gap: 4px; padding: 12px 14px; text-align: left; color: var(--text); background: var(--panel); border: 1px solid var(--panel-line); border-radius: 13px; }
.bug-section-tabs button.active { border-color: var(--accent); background: var(--panel-muted); box-shadow: inset 0 0 0 1px var(--accent); }
.bug-section-tabs span { color: var(--muted); font-size: 0.72rem; }
.bug-project-bar, .bug-filter-bar { padding: 14px; background: var(--panel); border: 1px solid var(--panel-line); border-radius: 16px; }
.bug-project-bar label, .bug-filter-bar label { display: grid; gap: 5px; color: var(--muted); font-size: 0.78rem; }
.bug-project-bar select, .bug-project-create input { min-width: 150px; }
.bug-filter-bar { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.bug-filter-bar label { min-width: 0; }
.bug-filter-bar .workspace-filter-select { font-size: 0.9rem; }
.bug-project-create { display: flex; gap: 8px; margin-left: auto; }
.bug-main-grid { display: grid; grid-template-columns: minmax(260px, 0.8fr) minmax(420px, 1.4fr); gap: 14px; align-items: start; }
.bug-alert { padding: 10px 13px; border-radius: 11px; }
.bug-alert-error { color: var(--danger); background: #fce8e6; }
.bug-alert-notice { color: #7a4b00; background: #fef7e0; }
.bug-search { display: grid; gap: 13px; padding: 18px; background: var(--panel); border: 1px solid var(--panel-line); border-radius: 18px; }
.bug-search-form { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: stretch; }
.bug-search-form textarea { padding: 11px; border: 1px solid var(--panel-line); border-radius: 11px; resize: vertical; }
.bug-search-form button { padding: 0 18px; color: #fff; background: var(--accent-strong); border: 0; border-radius: 11px; }
.bug-common-toggle { color: var(--muted); font-size: 0.85rem; }
.bug-extra-projects { padding: 10px 12px; background: var(--panel-muted); border-radius: 10px; }
.bug-extra-projects label { display: inline-flex; gap: 5px; margin: 8px 14px 0 0; }
.bug-search-results { display: grid; gap: 12px; }
.bug-search-result { padding: 15px; border: 1px solid var(--panel-line); border-radius: 14px; }
.bug-search-result h3 { display: inline; margin: 0 0 0 7px; }
.bug-result-rank { color: var(--accent-strong); font-weight: 700; }
.bug-search-result dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.bug-search-result dl div { padding: 8px; background: var(--panel-muted); border-radius: 8px; }
.bug-search-result dt { color: var(--muted); font-size: 0.72rem; }
.bug-search-result dd { margin: 3px 0 0; }
.bug-result-citations { margin-top: 10px; }
.bug-citation-snippet { margin-top: 8px; padding: 10px; background: var(--panel-muted); border-radius: 8px; overflow-wrap: anywhere; }
.bug-search-empty { padding: 20px; text-align: center; color: var(--muted); border: 1px dashed var(--panel-line); border-radius: 12px; }
.confirmed-case-overview { display: grid; gap: 12px; padding: 14px; background: var(--panel); border: 1px solid var(--panel-line); border-radius: 16px; }
.confirmed-case-overview h3 { margin: 2px 0 0; }
.confirmed-case-overview > header > span { color: var(--muted); font-size: 0.85rem; }
.confirmed-case-grid { display: grid; grid-template-columns: minmax(220px, 0.75fr) minmax(0, 1.25fr); gap: 12px; }
.confirmed-case-detail, .confirmed-case-empty { padding: 14px; background: var(--panel-muted); border-radius: 12px; }
.confirmed-case-detail h3 { margin: 2px 0 8px; }
.confirmed-case-detail p { margin: 6px 0; }
.confirmed-case-detail dl { display: grid; gap: 8px; margin: 14px 0 0; }
.confirmed-case-detail dl div { display: grid; gap: 3px; }
.confirmed-case-detail dt { color: var(--muted); font-size: 0.78rem; }
.confirmed-case-detail dd { margin: 0; white-space: pre-wrap; }
.confirmed-case-empty { color: var(--muted); }
@media (max-width: 900px) { .bug-main-grid { grid-template-columns: 1fr; } .bug-project-bar { align-items: stretch; flex-wrap: wrap; } .bug-filter-bar { grid-template-columns: repeat(2, minmax(0, 1fr)); } .bug-project-create { margin-left: 0; } }
@media (max-width: 560px) { .bug-filter-bar, .bug-section-tabs, .confirmed-case-grid { grid-template-columns: 1fr; } }
</style>
