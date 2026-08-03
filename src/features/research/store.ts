import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { researchApi } from './api';
import type {
  ContinueResearchInput,
  ResearchApi,
  ResearchCapabilities,
  ResearchDraft,
  ResearchDraftSeed,
  ResearchTask
} from './types';

interface ResearchStoreOptions {
  storeId?: string;
  pollIntervalMs?: number;
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function isActive(task: ResearchTask) {
  return task.status === 'queued' || task.status === 'running';
}

function boundedQuestion(value: string) {
  return value.slice(0, 4_000);
}

/**
 * Research module owns drafts, authoritative task snapshots and synchronization.
 * Its factory exposes the transport as the only replaceable seam for tests.
 */
export function createResearchStore(
  api: ResearchApi = researchApi,
  options: ResearchStoreOptions = {}
) {
  const storeId = options.storeId || 'research';
  const pollIntervalMs = options.pollIntervalMs ?? 1250;

  return defineStore(storeId, () => {
    const capabilities = ref<ResearchCapabilities>({
      localKnowledge: true,
      publicPrimarySearch: { available: false, role: 'supplemental' }
    });
    const capabilitiesLoaded = ref(false);
    const tasks = ref<ResearchTask[]>([]);
    const draft = ref<ResearchDraft | null>(null);
    const loading = ref(false);
    const errorMessage = ref('');
    const noticeMessage = ref('');
    const busyTaskIds = ref<string[]>([]);

    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshPromise: Promise<boolean> | null = null;
    let stateRevision = 0;
    let listeningForVisibility = false;

    const activeTaskCount = computed(() => tasks.value.filter(isActive).length);
    const sortedTasks = computed(() => [...tasks.value].sort((left, right) => {
      const activityOrder = Number(isActive(right)) - Number(isActive(left));
      return activityOrder || right.updatedAt - left.updatedAt;
    }));

    function clearPollTimer() {
      if (!pollTimer) return;
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    function pageIsVisible() {
      return typeof document === 'undefined' || document.visibilityState !== 'hidden';
    }

    function schedulePolling() {
      clearPollTimer();
      if (!pageIsVisible() || !tasks.value.some(isActive)) return;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void refreshTasks();
      }, pollIntervalMs);
    }

    function replaceTask(next: ResearchTask) {
      const index = tasks.value.findIndex((item) => item.id === next.id);
      if (index >= 0) tasks.value.splice(index, 1, next);
      else tasks.value.unshift(next);
      stateRevision += 1;
      schedulePolling();
    }

    function replaceSession(runs: ResearchTask[]) {
      if (!runs.length) return;
      const sessionId = runs[0].sessionId;
      tasks.value = [
        ...tasks.value.filter((task) => task.sessionId !== sessionId),
        ...runs
      ];
      stateRevision += 1;
      schedulePolling();
    }

    function fail(error: unknown) {
      errorMessage.value = readableError(error);
      return false;
    }

    function handleVisibilityChange() {
      clearPollTimer();
      if (pageIsVisible()) void refreshTasks();
    }

    function listenForVisibility() {
      if (listeningForVisibility || typeof document === 'undefined') return;
      document.addEventListener('visibilitychange', handleVisibilityChange);
      listeningForVisibility = true;
    }

    async function refreshTasks() {
      if (refreshPromise) return refreshPromise;
      const revisionAtStart = stateRevision;
      const request = (async () => {
        try {
          const nextTasks = await api.listTasks();
          if (revisionAtStart === stateRevision) {
            tasks.value = nextTasks;
            stateRevision += 1;
          }
          return true;
        } catch (error) {
          return fail(error);
        } finally {
          refreshPromise = null;
          schedulePolling();
        }
      })();
      refreshPromise = request;
      return request;
    }

    async function initialize() {
      listenForVisibility();
      loading.value = true;
      errorMessage.value = '';
      try {
        const capabilityRequest = api.getCapabilities()
          .then((value) => {
            capabilities.value = value;
          })
          .catch(() => {
            // 能力发现失败采用最保守的本地模式，不污染 Research 任务列表的错误状态。
          })
          .finally(() => {
            capabilitiesLoaded.value = true;
          });
        const [tasksLoaded] = await Promise.all([refreshTasks(), capabilityRequest]);
        return tasksLoaded;
      } finally {
        loading.value = false;
      }
    }

    function startDraft(seed: ResearchDraftSeed = {}) {
      errorMessage.value = '';
      noticeMessage.value = '';
      draft.value = {
        question: boundedQuestion(seed.question || ''),
        searchMode: seed.searchMode || (
          capabilities.value.publicPrimarySearch.available ? 'hybrid' : 'local'
        ),
        knowledgeBaseIds: [...(seed.knowledgeBaseIds || [])],
        sourceSessionId: seed.sourceSessionId,
        sourceMessageId: seed.sourceMessageId,
        status: 'editing'
      };
    }

    function updateDraft(patch: Partial<Pick<ResearchDraft, 'question' | 'searchMode' | 'knowledgeBaseIds'>>) {
      if (!draft.value || draft.value.status === 'submitting') return;
      draft.value = {
        ...draft.value,
        ...patch,
        question: patch.question === undefined
          ? draft.value.question
          : boundedQuestion(patch.question),
        knowledgeBaseIds: patch.knowledgeBaseIds
          ? [...patch.knowledgeBaseIds]
          : [...draft.value.knowledgeBaseIds]
      };
    }

    function discardDraft() {
      if (draft.value?.status === 'submitting') return;
      draft.value = null;
    }

    async function submitDraft() {
      if (!draft.value || !draft.value.question.trim() || draft.value.status === 'submitting') {
        return null;
      }
      errorMessage.value = '';
      noticeMessage.value = '';
      draft.value.status = 'submitting';
      try {
        const result = await api.createTask({
          question: draft.value.question.trim(),
          searchMode: draft.value.searchMode,
          knowledgeBaseIds: [...draft.value.knowledgeBaseIds]
        });
        replaceTask(result.task);
        draft.value.status = 'submitted';
        noticeMessage.value = result.notice || '研究任务已创建';
        return result.task.id;
      } catch (error) {
        draft.value.status = 'editing';
        fail(error);
        return null;
      }
    }

    async function runTaskAction(id: string, action: 'cancel' | 'retry') {
      if (busyTaskIds.value.includes(id)) return false;
      busyTaskIds.value.push(id);
      errorMessage.value = '';
      noticeMessage.value = '';
      try {
        const next = action === 'cancel'
          ? await api.cancelTask(id)
          : await api.retryTask(id);
        replaceTask(next);
        noticeMessage.value = action === 'cancel' ? '研究任务已取消' : '研究任务已重新排队';
        return true;
      } catch (error) {
        return fail(error);
      } finally {
        busyTaskIds.value = busyTaskIds.value.filter((value) => value !== id);
      }
    }

    function cancelTask(id: string) {
      return runTaskAction(id, 'cancel');
    }

    function retryTask(id: string) {
      return runTaskAction(id, 'retry');
    }

    async function continueTask(id: string, input: ContinueResearchInput) {
      if (busyTaskIds.value.includes(id)) return null;
      busyTaskIds.value.push(id);
      errorMessage.value = '';
      noticeMessage.value = '';
      try {
        const result = await api.continueTask(id, input);
        replaceTask(result.task);
        noticeMessage.value = result.notice || '已创建后续研究';
        return result.task.id;
      } catch (error) {
        fail(error);
        return null;
      } finally {
        busyTaskIds.value = busyTaskIds.value.filter((value) => value !== id);
      }
    }

    async function ensureTask(id: string) {
      if (tasks.value.some((item) => item.id === id)) return true;
      errorMessage.value = '';
      try {
        replaceTask(await api.getTask(id));
        return true;
      } catch (error) {
        return fail(error);
      }
    }

    async function ensureSession(id: string) {
      errorMessage.value = '';
      try {
        replaceSession(await api.getSession(id));
        return true;
      } catch (error) {
        return fail(error);
      }
    }

    function dispose() {
      clearPollTimer();
      if (listeningForVisibility && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      listeningForVisibility = false;
    }

    return {
      tasks,
      capabilities,
      capabilitiesLoaded,
      draft,
      loading,
      errorMessage,
      noticeMessage,
      busyTaskIds,
      activeTaskCount,
      sortedTasks,
      initialize,
      refreshTasks,
      startDraft,
      updateDraft,
      discardDraft,
      submitDraft,
      cancelTask,
      retryTask,
      continueTask,
      ensureTask,
      ensureSession,
      dispose
    };
  });
}

export const useResearchStore = createResearchStore();
