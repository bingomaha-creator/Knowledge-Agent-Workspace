import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { bugInvestigationApi } from './investigation-api';
import type {
  BugEvidenceInput,
  BugInvestigation,
  BugInvestigationApi,
  BugInvestigationDraftSeed
} from './investigation-types';

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

export function createBugInvestigationStore(
  api: BugInvestigationApi = bugInvestigationApi,
  storeId = 'bug-investigations'
) {
  return defineStore(storeId, () => {
    const investigations = ref<BugInvestigation[]>([]);
    const selectedId = ref('');
    const loading = ref(false);
    const busyIds = ref<string[]>([]);
    const errorMessage = ref('');
    const noticeMessage = ref('');
    const currentProjectRef = ref('');
    const draftSeed = ref<BugInvestigationDraftSeed | null>(null);

    const selected = computed(() =>
      investigations.value.find((item) => item.id === selectedId.value) || null
    );
    const activeInvestigations = computed(() =>
      investigations.value.filter((item) => item.status !== 'closed')
    );

    function fail(error: unknown) {
      errorMessage.value = readableError(error);
      return false;
    }

    function upsert(next: BugInvestigation) {
      const index = investigations.value.findIndex((item) => item.id === next.id);
      if (index >= 0) investigations.value.splice(index, 1, next);
      else investigations.value.unshift(next);
      selectedId.value = next.id;
    }

    function begin(id: string) {
      errorMessage.value = '';
      noticeMessage.value = '';
      if (!busyIds.value.includes(id)) busyIds.value.push(id);
    }

    function end(id: string) {
      busyIds.value = busyIds.value.filter((value) => value !== id);
    }

    async function initialize(projectRef: string) {
      currentProjectRef.value = projectRef;
      if (!projectRef) {
        investigations.value = [];
        selectedId.value = '';
        return false;
      }
      loading.value = true;
      errorMessage.value = '';
      try {
        const next = await api.fetchInvestigations(projectRef);
        if (currentProjectRef.value !== projectRef) return false;
        investigations.value = next;
        if (!next.some((item) => item.id === selectedId.value && item.status !== 'closed')) {
          selectedId.value = next.find((item) => item.status !== 'closed')?.id || '';
        }
        return true;
      } catch (error) {
        return fail(error);
      } finally {
        loading.value = false;
      }
    }

    async function createAndAnalyze(input: {
      projectRef: string;
      title?: string;
      evidence: BugEvidenceInput;
    }) {
      begin('create');
      try {
        const created = await api.createInvestigation(input);
        upsert(created);
        const analyzed = await api.analyzeInvestigation(created.id);
        upsert(analyzed);
        noticeMessage.value = analyzed.analysis.status === 'insufficient'
          ? '调查已创建，请按证据缺口继续补充'
          : '调查已创建并完成首轮分析';
        return analyzed.id;
      } catch (error) {
        fail(error);
        return null;
      } finally {
        end('create');
      }
    }

    async function appendAndAnalyze(id: string, evidence: BugEvidenceInput) {
      begin(id);
      let evidenceWasSaved = selected.value?.id === id
        && selected.value.analysis.status === 'stale';
      try {
        if (!evidenceWasSaved) {
          upsert(await api.appendEvidence(id, evidence));
          evidenceWasSaved = true;
        }
        upsert(await api.analyzeInvestigation(id));
        noticeMessage.value = '证据已加入，调查结果已更新';
        return true;
      } catch (error) {
        if (evidenceWasSaved) {
          errorMessage.value = `证据已保存，但重新分析失败：${readableError(error)}`;
          return false;
        }
        return fail(error);
      } finally {
        end(id);
      }
    }

    async function reanalyze(id: string) {
      begin(id);
      try {
        upsert(await api.analyzeInvestigation(id));
        noticeMessage.value = '调查结果已重新生成';
        return true;
      } catch (error) {
        return fail(error);
      } finally {
        end(id);
      }
    }

    async function convertToCandidate(id: string) {
      begin(id);
      try {
        upsert(await api.convertToCandidate(id));
        noticeMessage.value = '已转为 Candidate，等待人工审核';
        return true;
      } catch (error) {
        return fail(error);
      } finally {
        end(id);
      }
    }

    async function closeInvestigation(id: string) {
      begin(id);
      try {
        upsert(await api.closeInvestigation(id));
        selectedId.value = investigations.value.find((item) => item.status === 'draft')?.id || '';
        noticeMessage.value = '调查已关闭';
        return true;
      } catch (error) {
        return fail(error);
      } finally {
        end(id);
      }
    }

    function startDraft(seed: BugInvestigationDraftSeed) {
      draftSeed.value = {
        ...seed,
        evidence: {
          ...seed.evidence,
          metadata: { ...seed.evidence.metadata }
        }
      };
      noticeMessage.value = '已从对话带入错误现场，请确认后开始调查';
    }

    function clearDraft() {
      draftSeed.value = null;
    }

    return {
      investigations,
      selectedId,
      loading,
      busyIds,
      errorMessage,
      noticeMessage,
      currentProjectRef,
      draftSeed,
      selected,
      activeInvestigations,
      initialize,
      createAndAnalyze,
      appendAndAnalyze,
      reanalyze,
      convertToCandidate,
      closeInvestigation,
      startDraft,
      clearDraft
    };
  });
}

export const useBugInvestigationStore = createBugInvestigationStore();
