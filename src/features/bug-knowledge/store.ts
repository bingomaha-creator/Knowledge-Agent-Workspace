import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { bugKnowledgeApi } from './api';
import type {
  BugCase,
  BugCaseDraft,
  BugCasePatch,
  BugKnowledgeApi,
  BugProject,
  BugReviewStatus,
  BugScope,
  BugSearchResult
} from './types';

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

/**
 * 工厂允许测试替换唯一的 HTTP 边界；生产只导出下方默认实例。
 * 它没有 import/useChatStore，Bug 工作区的请求过渡态和服务端快照不会扩大 chat store。
 */
export function createBugKnowledgeStore(
  api: BugKnowledgeApi = bugKnowledgeApi,
  storeId = 'bug-knowledge'
) {
  return defineStore(storeId, () => {
    const projects = ref<BugProject[]>([]);
    const cases = ref<BugCase[]>([]);
    const searchResults = ref<BugSearchResult[]>([]);
    const selectedProjectRef = ref('');
    const selectedCaseId = ref('');
    const scopeFilter = ref<'all' | BugScope>('all');
    const reviewStatusFilter = ref<'all' | BugReviewStatus>('all');
    const languageFilter = ref('');
    const frameworkFilter = ref('');
    const searchQuery = ref('');
    const includeCommon = ref(true);
    const additionalProjectRefs = ref<string[]>([]);
    const searchTrace = ref({
      degradedChannels: [] as string[],
      ambiguous: false,
      evidenceGap: false
    });
    const loading = ref(false);
    const searching = ref(false);
    const busyIds = ref<string[]>([]);
    const errorMessage = ref('');
    const noticeMessage = ref('');

    const selectedProject = computed(() =>
      projects.value.find((project) => project.projectRef === selectedProjectRef.value) || null
    );
    const selectedCase = computed(() =>
      cases.value.find((bugCase) => bugCase.id === selectedCaseId.value) || null
    );
    const visibleCases = computed(() => cases.value.filter((bugCase) => {
      if (scopeFilter.value === 'project') {
        if (
          bugCase.scope !== 'project'
          || bugCase.sourceProjectRef !== selectedProjectRef.value
        ) return false;
      }
      if (scopeFilter.value === 'common' && bugCase.scope !== 'common') return false;
      if (
        reviewStatusFilter.value !== 'all'
        && bugCase.reviewStatus !== reviewStatusFilter.value
      ) return false;
      if (languageFilter.value && bugCase.context.language !== languageFilter.value) return false;
      if (frameworkFilter.value && bugCase.context.framework !== frameworkFilter.value) return false;
      return true;
    }));
    const languages = computed(() => [...new Set(
      cases.value.map((bugCase) => bugCase.context.language).filter(Boolean)
    )].sort());
    const frameworks = computed(() => [...new Set(
      cases.value.map((bugCase) => bugCase.context.framework).filter(Boolean)
    )].sort());

    function beginMutation(id: string) {
      errorMessage.value = '';
      noticeMessage.value = '';
      if (!busyIds.value.includes(id)) busyIds.value.push(id);
    }

    function endMutation(id: string) {
      busyIds.value = busyIds.value.filter((value) => value !== id);
    }

    function fail(error: unknown) {
      errorMessage.value = readableError(error);
      return false;
    }

    function upsertCase(next: BugCase) {
      const index = cases.value.findIndex((item) => item.id === next.id);
      if (index >= 0) cases.value.splice(index, 1, next);
      else cases.value.unshift(next);
      selectedCaseId.value = next.id;
    }

    async function initialize() {
      loading.value = true;
      errorMessage.value = '';
      try {
        const [nextProjects, nextCases] = await Promise.all([
          api.fetchProjects(),
          api.fetchCases()
        ]);
        projects.value = nextProjects;
        cases.value = nextCases;
        if (!nextProjects.some((project) => project.projectRef === selectedProjectRef.value)) {
          selectedProjectRef.value = nextProjects[0]?.projectRef || '';
        }
        if (!nextCases.some((bugCase) => bugCase.id === selectedCaseId.value)) {
          selectedCaseId.value = nextCases[0]?.id || '';
        }
        return true;
      } catch (error) {
        return fail(error);
      } finally {
        loading.value = false;
      }
    }

    async function refreshCases() {
      try {
        cases.value = await api.fetchCases();
        return true;
      } catch (error) {
        return fail(error);
      }
    }

    async function createProject(input: { name: string; description?: string }) {
      beginMutation('project:create');
      try {
        const created = await api.createProject(input);
        projects.value.push(created);
        selectedProjectRef.value = created.projectRef;
        noticeMessage.value = 'Bug 项目已创建';
        return true;
      } catch (error) {
        return fail(error);
      } finally {
        endMutation('project:create');
      }
    }

    async function createCase(input: BugCaseDraft) {
      beginMutation('case:create');
      try {
        const created = await api.createCase(input);
        upsertCase(created);
        noticeMessage.value = '候选 BugCase 已创建，等待索引处理和人工审核';
        return true;
      } catch (error) {
        return fail(error);
      } finally {
        endMutation('case:create');
      }
    }

    async function updateCase(id: string, patch: BugCasePatch) {
      beginMutation(id);
      try {
        upsertCase(await api.updateCase(id, patch));
        noticeMessage.value = 'BugCase 已退回候选并重新建立索引';
        return true;
      } catch (error) {
        return fail(error);
      } finally {
        endMutation(id);
      }
    }

    async function reviewCase(
      id: string,
      reviewStatus: 'confirmed' | 'rejected',
      reviewReason: string
    ) {
      beginMutation(id);
      try {
        upsertCase(await api.reviewCase(id, { reviewStatus, reviewReason }));
        noticeMessage.value = reviewStatus === 'confirmed' ? 'BugCase 已确认' : 'BugCase 已拒绝';
        return true;
      } catch (error) {
        return fail(error);
      } finally {
        endMutation(id);
      }
    }

    async function deleteCase(id: string) {
      beginMutation(id);
      try {
        // 等服务端成功后才移除快照；失败时 UI 不会出现“看似删除成功”。
        await api.deleteCase(id);
        cases.value = cases.value.filter((bugCase) => bugCase.id !== id);
        if (selectedCaseId.value === id) selectedCaseId.value = cases.value[0]?.id || '';
        noticeMessage.value = 'BugCase 已删除';
        return true;
      } catch (error) {
        return fail(error);
      } finally {
        endMutation(id);
      }
    }

    async function promoteCase(id: string) {
      beginMutation(id);
      try {
        upsertCase(await api.promoteCase(id));
        noticeMessage.value = 'BugCase 已提升到公共库';
        return true;
      } catch (error) {
        return fail(error);
      } finally {
        endMutation(id);
      }
    }

    async function search() {
      if (!searchQuery.value.trim() || !selectedProjectRef.value) {
        errorMessage.value = '请选择当前项目并输入错误或症状';
        return false;
      }
      searching.value = true;
      errorMessage.value = '';
      try {
        const filters = {
          ...(languageFilter.value ? { language: languageFilter.value } : {}),
          ...(frameworkFilter.value ? { framework: frameworkFilter.value } : {})
        };
        const response = await api.searchCases({
          query: searchQuery.value.trim(),
          projectRef: selectedProjectRef.value,
          includeCommon: includeCommon.value,
          additionalProjectRefs: [...additionalProjectRefs.value],
          filters,
          topK: 5
        });
        // 服务端是正式资格的权威；前端再防御一次，避免错误响应把 candidate 误画成正式命中。
        searchResults.value = response.results.filter(
          (result) => result.bugCase.reviewStatus === 'confirmed'
        );
        searchTrace.value = response.trace;
        return true;
      } catch (error) {
        return fail(error);
      } finally {
        searching.value = false;
      }
    }

    return {
      projects,
      cases,
      searchResults,
      selectedProjectRef,
      selectedCaseId,
      scopeFilter,
      reviewStatusFilter,
      languageFilter,
      frameworkFilter,
      searchQuery,
      includeCommon,
      additionalProjectRefs,
      searchTrace,
      loading,
      searching,
      busyIds,
      errorMessage,
      noticeMessage,
      selectedProject,
      selectedCase,
      visibleCases,
      languages,
      frameworks,
      initialize,
      refreshCases,
      createProject,
      createCase,
      updateCase,
      reviewCase,
      deleteCase,
      promoteCase,
      search
    };
  });
}

export const useBugKnowledgeStore = createBugKnowledgeStore();
