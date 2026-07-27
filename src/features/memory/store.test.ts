// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from './store';
import type { MemoryApi, MemoryRecord } from './types';

const candidate: MemoryRecord = {
  id: 'memory-1',
  type: 'fact',
  title: '项目事实',
  content: '使用 Vue',
  details: {},
  confidence: 0.8,
  status: 'candidate',
  sourceConversationId: 'session-1',
  sourceMessageIds: ['user-1', 'assistant-1'],
  sourceExcerpt: '使用 Vue',
  createdAt: 1,
  updatedAt: 1
};

function api(overrides: Partial<MemoryApi> = {}): MemoryApi {
  return {
    listAll: vi.fn(async () => [candidate]),
    create: vi.fn(async () => candidate),
    update: vi.fn(async () => candidate),
    remove: vi.fn(async () => undefined),
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Memory store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('initializes an authoritative Memory catalog and keeps failures local', async () => {
    const store = createMemoryStore(api(), { storeId: 'memory-initialize' })();

    expect(await store.initialize()).toBe(true);
    expect(store.memories).toEqual([candidate]);
    expect(store.initialized).toBe(true);
    expect(store.loading).toBe(false);
    expect(store.errorMessage).toBe('');

    const failed = createMemoryStore(api({
      listAll: vi.fn(async () => { throw new Error('记忆不可用'); })
    }), { storeId: 'memory-initialize-failure' })();

    expect(await failed.initialize()).toBe(false);
    expect(failed.memories).toEqual([]);
    expect(failed.initialized).toBe(true);
    expect(failed.errorMessage).toBe('记忆不可用');
  });

  it('reviews a candidate through a domain decision and returns the authoritative record', async () => {
    const confirmed = { ...candidate, status: 'confirmed' as const, updatedAt: 2 };
    const transport = api({ update: vi.fn(async () => confirmed) });
    const store = createMemoryStore(transport, { storeId: 'memory-review' })();
    await store.initialize();

    expect(await store.review('memory-1', 'confirmed')).toEqual(confirmed);
    expect(store.memories).toEqual([confirmed]);
    expect(store.noticeMessage).toBe('记忆已确认。');
    expect(store.busyIds).toEqual([]);
    expect(store.failedIds).toEqual([]);
  });

  it('creates an explicitly authored Memory as an authoritative confirmed record', async () => {
    const confirmed = {
      ...candidate,
      id: 'memory-created',
      type: 'preference' as const,
      title: '回答风格',
      content: '回答时先给结论，再解释原因。',
      confidence: 1,
      status: 'confirmed' as const,
      updatedAt: 2
    };
    const create = vi.fn(async () => confirmed);
    const store = createMemoryStore(api({ create }), { storeId: 'memory-create' })();
    await store.initialize();

    await expect(store.create({
      type: 'preference',
      title: '回答风格',
      content: '回答时先给结论，再解释原因。'
    })).resolves.toEqual(confirmed);
    expect(create).toHaveBeenCalledWith({
      type: 'preference',
      title: '回答风格',
      content: '回答时先给结论，再解释原因。'
    });
    expect(store.memories[0]).toEqual(confirmed);
    expect(store.creating).toBe(false);
    expect(store.noticeMessage).toBe('记忆已创建并确认。');
  });

  it('turns every human correction into the corrected status', async () => {
    const corrected = {
      ...candidate,
      title: '已纠正事实',
      status: 'corrected' as const,
      updatedAt: 3
    };
    const update = vi.fn(async () => corrected);
    const store = createMemoryStore(api({ update }), { storeId: 'memory-correct' })();
    await store.initialize();

    expect(await store.correct('memory-1', { title: '已纠正事实' })).toEqual(corrected);
    expect(store.memories).toEqual([corrected]);
    expect(store.noticeMessage).toBe('记忆已纠正。');
    expect(update).toHaveBeenCalledWith('memory-1', {
      title: '已纠正事实',
      status: 'corrected'
    });
  });

  it('removes a record only after the remote mutation succeeds', async () => {
    const store = createMemoryStore(api(), { storeId: 'memory-remove' })();
    await store.initialize();

    expect(await store.remove('memory-1')).toBe(true);
    expect(store.memories).toEqual([]);
    expect(store.noticeMessage).toBe('记忆已删除。');

    const failed = createMemoryStore(api({
      remove: vi.fn(async () => { throw new Error('删除失败'); })
    }), { storeId: 'memory-remove-failure' })();
    await failed.initialize();

    expect(await failed.remove('memory-1')).toBe(false);
    expect(failed.memories).toEqual([candidate]);
    expect(failed.failedIds).toEqual(['memory-1']);
    expect(failed.errorMessage).toBe('删除失败');
  });

  it('ingests authoritative Chat candidates without letting an older refresh overwrite them', async () => {
    const late = deferred<MemoryRecord[]>();
    const transport = api({
      listAll: vi.fn()
        .mockResolvedValueOnce([candidate])
        .mockReturnValueOnce(late.promise)
    });
    const store = createMemoryStore(transport, { storeId: 'memory-refresh-race' })();
    await store.initialize();
    const refreshing = store.refresh();
    const confirmed = { ...candidate, status: 'confirmed' as const, updatedAt: 4 };

    store.ingest([confirmed, confirmed]);
    late.resolve([candidate]);

    expect(await refreshing).toBe(false);
    expect(store.memories).toEqual([confirmed]);
  });

  it('does not let a late initialization overwrite a newer ingested candidate', async () => {
    const late = deferred<MemoryRecord[]>();
    const store = createMemoryStore(api({
      listAll: vi.fn(() => late.promise)
    }), { storeId: 'memory-initialize-race' })();
    const initializing = store.initialize();
    const confirmed = { ...candidate, status: 'confirmed' as const, updatedAt: 5 };

    store.ingest([confirmed]);
    late.resolve([candidate]);

    expect(await initializing).toBe(false);
    expect(store.memories).toEqual([confirmed]);
    expect(store.initialized).toBe(true);
  });

  it('never downgrades a reviewed record when Chat repeats a candidate DTO', async () => {
    const confirmed = { ...candidate, status: 'confirmed' as const, updatedAt: 5 };
    const store = createMemoryStore(api({
      listAll: vi.fn(async () => [confirmed])
    }), { storeId: 'memory-ingest-no-downgrade' })();
    await store.initialize();

    store.ingest([{ ...candidate, updatedAt: 6 }]);

    expect(store.memories).toEqual([confirmed]);
  });

  it('allows only one mutation per Memory ID at a time', async () => {
    const pending = deferred<MemoryRecord>();
    const update = vi.fn(() => pending.promise);
    const store = createMemoryStore(api({ update }), { storeId: 'memory-id-lock' })();
    await store.initialize();

    const first = store.review('memory-1', 'confirmed');
    expect(store.busyIds).toEqual(['memory-1']);
    await expect(store.review('memory-1', 'rejected')).resolves.toBeNull();
    expect(update).toHaveBeenCalledOnce();

    const confirmed = { ...candidate, status: 'confirmed' as const, updatedAt: 7 };
    pending.resolve(confirmed);
    await expect(first).resolves.toEqual(confirmed);
    expect(store.busyIds).toEqual([]);
  });
});
