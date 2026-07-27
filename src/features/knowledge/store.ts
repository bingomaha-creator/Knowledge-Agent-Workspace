import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { knowledgeApi } from './api';
import type {
  KnowledgeApi,
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeDocumentPreview
} from './types';

const ACTIVE_KNOWLEDGE_BASE_KEY = 'matthews-workspace-active-knowledge-base-v1';
const LEGACY_ACTIVE_KNOWLEDGE_BASE_KEY = 'yuan-agent-active-knowledge-base-v1';
const DEFAULT_KNOWLEDGE_BASE_ID = 'kb-default';

interface KnowledgeStoreOptions {
  storeId?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function persistedActiveBaseId() {
  if (typeof window === 'undefined') return DEFAULT_KNOWLEDGE_BASE_ID;
  return localStorage.getItem(ACTIVE_KNOWLEDGE_BASE_KEY)
    || localStorage.getItem(LEGACY_ACTIVE_KNOWLEDGE_BASE_KEY)
    || DEFAULT_KNOWLEDGE_BASE_ID;
}

export function createKnowledgeStore(api: KnowledgeApi, options: KnowledgeStoreOptions = {}) {
  const storeId = options.storeId || 'knowledge';
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  const maxPollAttempts = options.maxPollAttempts ?? 40;

  return defineStore(storeId, () => {
    const knowledgeBases = ref<KnowledgeBase[]>([]);
    const documents = ref<KnowledgeDocument[]>([]);
    const activeKnowledgeBaseId = ref(persistedActiveBaseId());
    const loading = ref(false);
    const initialized = ref(false);
    const errorMessage = ref('');
    const noticeMessage = ref('');
    const selectedPreview = ref<KnowledgeDocumentPreview | null>(null);
    const busyDocumentIds = ref<string[]>([]);

    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let pollingBaseId = '';
    let pollAttempts = 0;
    let disposed = false;
    let documentRequestRevision = 0;

    const activeBase = computed(() =>
      knowledgeBases.value.find((base) => base.id === activeKnowledgeBaseId.value) || null
    );

    function setDocumentBusy(id: string, busy: boolean) {
      busyDocumentIds.value = busy
        ? [...new Set([...busyDocumentIds.value, id])]
        : busyDocumentIds.value.filter((item) => item !== id);
    }

    function replaceDocument(updated: KnowledgeDocument) {
      documents.value = documents.value.map((document) =>
        document.id === updated.id ? updated : document
      );
      if (selectedPreview.value?.document.id === updated.id) {
        selectedPreview.value = { ...selectedPreview.value, document: updated };
      }
    }

    function persistActiveBaseId() {
      if (typeof window === 'undefined') return;
      try {
        localStorage.setItem(ACTIVE_KNOWLEDGE_BASE_KEY, activeKnowledgeBaseId.value);
        localStorage.removeItem(LEGACY_ACTIVE_KNOWLEDGE_BASE_KEY);
      } catch (error) {
        console.warn('[knowledge] 当前知识库 ID 持久化失败', error);
      }
    }

    function resolveActiveBaseId(nextBases: KnowledgeBase[]) {
      if (nextBases.some((base) => base.id === activeKnowledgeBaseId.value)) {
        return activeKnowledgeBaseId.value;
      }
      return nextBases.find((base) => base.isDefault)?.id
        || nextBases[0]?.id
        || DEFAULT_KNOWLEDGE_BASE_ID;
    }

    function hasPendingDocuments(items: KnowledgeDocument[]) {
      return items.some((document) =>
        document.status === 'queued' || document.status === 'processing'
      );
    }

    function stopPolling() {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      pollingBaseId = '';
      pollAttempts = 0;
    }

    function schedulePolling(knowledgeBaseId: string, reset = false) {
      if (disposed || activeKnowledgeBaseId.value !== knowledgeBaseId) return;
      if (reset || pollingBaseId !== knowledgeBaseId) {
        stopPolling();
        pollingBaseId = knowledgeBaseId;
      }
      if (pollTimer || pollAttempts >= maxPollAttempts) return;
      pollTimer = setTimeout(async () => {
        pollTimer = null;
        if (disposed || activeKnowledgeBaseId.value !== knowledgeBaseId) {
          stopPolling();
          return;
        }
        pollAttempts += 1;
        try {
          const nextDocuments = await api.listDocuments(knowledgeBaseId);
          if (disposed || activeKnowledgeBaseId.value !== knowledgeBaseId) return;
          documents.value = nextDocuments;
          if (selectedPreview.value) {
            const updated = nextDocuments.find(
              (document) => document.id === selectedPreview.value?.document.id
            );
            if (updated) replaceDocument(updated);
          }
          if (hasPendingDocuments(nextDocuments)) {
            schedulePolling(knowledgeBaseId);
            return;
          }
          await refreshCatalog();
          stopPolling();
        } catch {
          schedulePolling(knowledgeBaseId);
        }
      }, pollIntervalMs);
    }

    async function initialize() {
      loading.value = true;
      errorMessage.value = '';
      try {
        const nextBases = await api.listBases();
        const nextActiveId = resolveActiveBaseId(nextBases);
        const nextDocuments = nextBases.some((base) => base.id === nextActiveId)
          ? await api.listDocuments(nextActiveId)
          : [];
        knowledgeBases.value = nextBases;
        activeKnowledgeBaseId.value = nextActiveId;
        documents.value = nextDocuments;
        selectedPreview.value = null;
        persistActiveBaseId();
        if (hasPendingDocuments(nextDocuments)) schedulePolling(nextActiveId, true);
        return true;
      } catch (error) {
        errorMessage.value = readableError(error);
        return false;
      } finally {
        initialized.value = true;
        loading.value = false;
      }
    }

    async function createBase(name: string) {
      const normalizedName = name.trim();
      if (!normalizedName) return null;
      errorMessage.value = '';
      noticeMessage.value = '';
      try {
        const created = await api.createBase({ name: normalizedName });
        knowledgeBases.value = [...knowledgeBases.value, created];
        stopPolling();
        activeKnowledgeBaseId.value = created.id;
        documents.value = [];
        selectedPreview.value = null;
        persistActiveBaseId();
        noticeMessage.value = `已创建资料库“${created.name}”。`;
        return created;
      } catch (error) {
        errorMessage.value = readableError(error);
        return null;
      }
    }

    async function selectBase(id: string) {
      if (!knowledgeBases.value.some((base) => base.id === id)) return false;
      if (id === activeKnowledgeBaseId.value) return true;
      stopPolling();
      activeKnowledgeBaseId.value = id;
      const requestRevision = ++documentRequestRevision;
      documents.value = [];
      selectedPreview.value = null;
      persistActiveBaseId();
      errorMessage.value = '';
      try {
        const nextDocuments = await api.listDocuments(id);
        if (
          disposed
          || activeKnowledgeBaseId.value !== id
          || requestRevision !== documentRequestRevision
        ) return false;
        documents.value = nextDocuments;
        if (hasPendingDocuments(documents.value)) schedulePolling(id, true);
        return true;
      } catch (error) {
        errorMessage.value = readableError(error);
        return false;
      }
    }

    async function deleteBase(id: string) {
      const target = knowledgeBases.value.find((base) => base.id === id);
      if (!target || target.isDefault) return false;
      errorMessage.value = '';
      noticeMessage.value = '';
      try {
        await api.deleteBase(id, true);
      } catch (error) {
        errorMessage.value = readableError(error);
        return false;
      }

      knowledgeBases.value = knowledgeBases.value.filter((base) => base.id !== id);
      if (activeKnowledgeBaseId.value === id) {
        stopPolling();
        documentRequestRevision += 1;
        activeKnowledgeBaseId.value = resolveActiveBaseId(knowledgeBases.value);
        documents.value = [];
        selectedPreview.value = null;
        persistActiveBaseId();
        if (knowledgeBases.value.some((base) => base.id === activeKnowledgeBaseId.value)) {
          try {
            documents.value = await api.listDocuments(activeKnowledgeBaseId.value);
          } catch (error) {
            errorMessage.value = readableError(error);
          }
        }
      }
      noticeMessage.value = '资料库已删除。';
      return true;
    }

    async function refreshCatalog() {
      knowledgeBases.value = await api.listBases();
    }

    async function removeDocument(
      id: string,
      knowledgeBaseId = activeKnowledgeBaseId.value
    ) {
      errorMessage.value = '';
      noticeMessage.value = '';
      try {
        await api.deleteDocument(id, knowledgeBaseId);
      } catch (error) {
        errorMessage.value = readableError(error);
        return false;
      }
      if (activeKnowledgeBaseId.value === knowledgeBaseId) {
        documents.value = documents.value.filter((document) => document.id !== id);
        if (selectedPreview.value?.document.id === id) selectedPreview.value = null;
      }
      try {
        await refreshCatalog();
      } catch (error) {
        errorMessage.value = readableError(error);
      }
      noticeMessage.value = '知识文件已移除。';
      return true;
    }

    async function clearDocuments(knowledgeBaseId = activeKnowledgeBaseId.value) {
      errorMessage.value = '';
      noticeMessage.value = '';
      try {
        await api.clearDocuments(knowledgeBaseId);
      } catch (error) {
        errorMessage.value = readableError(error);
        return false;
      }
      if (activeKnowledgeBaseId.value === knowledgeBaseId) {
        stopPolling();
        documents.value = [];
        selectedPreview.value = null;
      }
      try {
        await refreshCatalog();
      } catch (error) {
        errorMessage.value = readableError(error);
      }
      noticeMessage.value = '资料库已清空。';
      return true;
    }

    async function previewDocument(
      id: string,
      knowledgeBaseId = activeKnowledgeBaseId.value
    ) {
      errorMessage.value = '';
      setDocumentBusy(id, true);
      try {
        selectedPreview.value = await api.getDocumentPreview(id, knowledgeBaseId);
        return true;
      } catch (error) {
        errorMessage.value = readableError(error);
        return false;
      } finally {
        setDocumentBusy(id, false);
      }
    }

    function closePreview() {
      selectedPreview.value = null;
    }

    async function changePublication(
      action: 'publish' | 'withdraw',
      id: string,
      knowledgeBaseId = activeKnowledgeBaseId.value
    ) {
      errorMessage.value = '';
      noticeMessage.value = '';
      setDocumentBusy(id, true);
      try {
        const updated = action === 'publish'
          ? await api.publishDocument(id, knowledgeBaseId)
          : await api.withdrawDocument(id, knowledgeBaseId);
        replaceDocument(updated);
        await refreshCatalog();
        noticeMessage.value = action === 'publish'
          ? '知识已发布，现在可供 AI 检索。'
          : '知识已撤回，预索引已保留。';
        return true;
      } catch (error) {
        errorMessage.value = readableError(error);
        return false;
      } finally {
        setDocumentBusy(id, false);
      }
    }

    function publishDocument(id: string, knowledgeBaseId?: string) {
      return changePublication('publish', id, knowledgeBaseId);
    }

    function withdrawDocument(id: string, knowledgeBaseId?: string) {
      return changePublication('withdraw', id, knowledgeBaseId);
    }

    async function uploadDocuments(
      files: FileList | File[],
      knowledgeBaseId = activeKnowledgeBaseId.value
    ) {
      errorMessage.value = '';
      noticeMessage.value = '';
      let uploaded: KnowledgeDocument[];
      try {
        uploaded = await api.uploadDocuments(files, knowledgeBaseId);
      } catch (error) {
        errorMessage.value = readableError(error);
        return false;
      }

      if (activeKnowledgeBaseId.value === knowledgeBaseId) {
        documents.value = [...documents.value, ...uploaded];
      }
      noticeMessage.value = uploaded.length
        ? `已接收 ${uploaded.length} 份知识草稿，正在后台处理。`
        : '';
      if (
        activeKnowledgeBaseId.value === knowledgeBaseId
        && hasPendingDocuments(uploaded)
      ) {
        schedulePolling(knowledgeBaseId, true);
      }
      try {
        await refreshCatalog();
      } catch (error) {
        errorMessage.value = readableError(error);
      }
      return true;
    }

    function dispose() {
      disposed = true;
      documentRequestRevision += 1;
      stopPolling();
      selectedPreview.value = null;
      busyDocumentIds.value = [];
    }

    return {
      knowledgeBases,
      documents,
      activeKnowledgeBaseId,
      activeBase,
      loading,
      initialized,
      errorMessage,
      noticeMessage,
      selectedPreview,
      busyDocumentIds,
      initialize,
      createBase,
      selectBase,
      deleteBase,
      removeDocument,
      clearDocuments,
      uploadDocuments,
      previewDocument,
      closePreview,
      publishDocument,
      withdrawDocument,
      dispose
    };
  });
}

export const useKnowledgeStore = createKnowledgeStore(knowledgeApi);
