import { defineStore } from 'pinia';
import { ref } from 'vue';
import { memoryApi } from './api';
import type {
  MemoryApi,
  MemoryCorrection,
  MemoryCreateInput,
  MemoryRecord
} from './types';

interface MemoryStoreOptions {
  storeId?: string;
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

export function createMemoryStore(api: MemoryApi, options: MemoryStoreOptions = {}) {
  return defineStore(options.storeId || 'memory', () => {
    const memories = ref<MemoryRecord[]>([]);
    const loading = ref(false);
    const creating = ref(false);
    const initialized = ref(false);
    const errorMessage = ref('');
    const noticeMessage = ref('');
    const busyIds = ref<string[]>([]);
    const failedIds = ref<string[]>([]);
    let catalogRevision = 0;

    async function initialize() {
      const requestRevision = catalogRevision;
      loading.value = true;
      errorMessage.value = '';
      try {
        const records = await api.listAll();
        if (requestRevision !== catalogRevision) return false;
        memories.value = records;
        return true;
      } catch (error) {
        errorMessage.value = readableError(error);
        return false;
      } finally {
        loading.value = false;
        initialized.value = true;
      }
    }

    function acquire(id: string) {
      if (busyIds.value.includes(id)) return false;
      busyIds.value = [...busyIds.value, id];
      failedIds.value = failedIds.value.filter((failedId) => failedId !== id);
      return true;
    }

    function release(id: string) {
      busyIds.value = busyIds.value.filter((busyId) => busyId !== id);
    }

    function upsert(record: MemoryRecord) {
      const index = memories.value.findIndex((memory) => memory.id === record.id);
      if (index < 0) memories.value = [record, ...memories.value];
      else memories.value[index] = record;
    }

    function ingest(records: MemoryRecord[]) {
      let changed = false;
      for (const record of records) {
        const current = memories.value.find((memory) => memory.id === record.id);
        if (current?.status !== 'candidate' && record.status === 'candidate') continue;
        if (current && current.updatedAt > record.updatedAt) continue;
        upsert(record);
        changed = true;
      }
      if (changed) catalogRevision += 1;
    }

    async function refresh() {
      const requestRevision = catalogRevision;
      errorMessage.value = '';
      try {
        const records = await api.listAll();
        if (requestRevision !== catalogRevision) return false;
        memories.value = records;
        return true;
      } catch (error) {
        errorMessage.value = readableError(error);
        return false;
      }
    }

    async function review(id: string, decision: 'confirmed' | 'rejected') {
      if (!acquire(id)) return null;
      errorMessage.value = '';
      noticeMessage.value = '';
      try {
        const updated = await api.update(id, { status: decision });
        upsert(updated);
        catalogRevision += 1;
        noticeMessage.value = decision === 'confirmed'
          ? '记忆已确认。'
          : '记忆候选已拒绝。';
        return updated;
      } catch (error) {
        errorMessage.value = readableError(error);
        failedIds.value = [...failedIds.value, id];
        return null;
      } finally {
        release(id);
      }
    }

    async function create(input: MemoryCreateInput) {
      if (creating.value) return null;
      creating.value = true;
      errorMessage.value = '';
      noticeMessage.value = '';
      try {
        const created = await api.create(input);
        upsert(created);
        catalogRevision += 1;
        noticeMessage.value = '记忆已创建并确认。';
        return created;
      } catch (error) {
        errorMessage.value = readableError(error);
        return null;
      } finally {
        creating.value = false;
      }
    }

    async function correct(id: string, correction: MemoryCorrection) {
      if (!acquire(id)) return null;
      errorMessage.value = '';
      noticeMessage.value = '';
      try {
        const updated = await api.update(id, {
          ...correction,
          status: 'corrected'
        });
        upsert(updated);
        catalogRevision += 1;
        noticeMessage.value = '记忆已纠正。';
        return updated;
      } catch (error) {
        errorMessage.value = readableError(error);
        failedIds.value = [...failedIds.value, id];
        return null;
      } finally {
        release(id);
      }
    }

    async function remove(id: string) {
      if (!acquire(id)) return false;
      errorMessage.value = '';
      noticeMessage.value = '';
      try {
        await api.remove(id);
        memories.value = memories.value.filter((memory) => memory.id !== id);
        catalogRevision += 1;
        noticeMessage.value = '记忆已删除。';
        return true;
      } catch (error) {
        errorMessage.value = readableError(error);
        failedIds.value = [...failedIds.value, id];
        return false;
      } finally {
        release(id);
      }
    }

    return {
      memories,
      busyIds,
      failedIds,
      loading,
      creating,
      initialized,
      errorMessage,
      noticeMessage,
      initialize,
      refresh,
      ingest,
      create,
      review,
      correct,
      remove
    };
  });
}

export const useMemoryStore = createMemoryStore(memoryApi);
