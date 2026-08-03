// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createResearchStore } from './store';
import type { ResearchApi, ResearchTask } from './types';

function task(overrides: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: 'research-1',
    question: '如何拆分 Workspace？',
    status: 'completed',
    stage: 'completed',
    progress: 100,
    citations: [],
    knowledgeBaseIds: ['kb-1'],
    searchMode: 'hybrid',
    webSearchStatus: 'available',
    resultQuality: 'sufficient',
    limitations: [],
    attempt: 1,
    sessionId: 'research-1',
    parentTaskId: '',
    turnIndex: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function api(overrides: Partial<ResearchApi> = {}): ResearchApi {
  return {
    getCapabilities: vi.fn(async () => ({
      localKnowledge: true,
      publicPrimarySearch: { available: true, role: 'supplemental' as const }
    })),
    listTasks: vi.fn(async () => [task()]),
    getTask: vi.fn(async (id) => task({ id })),
    getSession: vi.fn(async (id) => [task({ id, sessionId: id })]),
    createTask: vi.fn(async (input) => ({
      task: task({
        id: 'research-created',
        ...input,
        status: 'queued',
        stage: 'planning',
        progress: 0,
        resultQuality: 'pending',
        limitations: []
      }),
      notice: '研究任务已创建'
    })),
    cancelTask: vi.fn(async (id) => task({ id, status: 'cancelled', stage: 'completed' })),
    retryTask: vi.fn(async (id) => task({ id, status: 'queued', stage: 'planning', progress: 0, attempt: 2 })),
    continueTask: vi.fn(async (id, input) => ({
      task: task({
        id: 'research-follow-up',
        question: input.question,
        sessionId: id,
        parentTaskId: id,
        turnIndex: 2,
        status: 'queued',
        stage: 'planning',
        progress: 0,
        resultQuality: 'pending',
        limitations: []
      }),
      notice: '已创建第 2 轮研究'
    })),
    ...overrides
  };
}

describe('Research store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useRealTimers();
  });

  it('loads authoritative tasks and keeps failures local to Research', async () => {
    const transport = api();
    const useStore = createResearchStore(transport, { storeId: 'research-load' });
    const store = useStore();

    expect(await store.initialize()).toBe(true);
    expect(store.tasks).toEqual([task()]);

    const failing = createResearchStore(api({
      listTasks: vi.fn(async () => { throw new Error('研究服务不可用'); })
    }), { storeId: 'research-load-failure' })();
    expect(await failing.initialize()).toBe(false);
    expect(failing.errorMessage).toBe('研究服务不可用');
  });

  it('defaults new drafts to local when public search is unavailable', async () => {
    const transport = api({
      getCapabilities: vi.fn(async () => ({
        localKnowledge: true,
        publicPrimarySearch: { available: false, role: 'supplemental' as const }
      }))
    });
    const store = createResearchStore(transport, { storeId: 'research-capabilities' })();

    await store.initialize();
    store.startDraft({ question: '只用项目资料' });

    expect(store.capabilitiesLoaded).toBe(true);
    expect(store.draft?.searchMode).toBe('local');
  });

  it('sorts active tasks first and reports the active count', async () => {
    const transport = api({
      listTasks: vi.fn(async () => [
        task({ id: 'old', updatedAt: 1 }),
        task({ id: 'new', updatedAt: 4 }),
        task({ id: 'running', status: 'running', stage: 'writing', progress: 60, updatedAt: 2 }),
        task({ id: 'queued', status: 'queued', stage: 'planning', progress: 0, updatedAt: 3 })
      ])
    });
    const store = createResearchStore(transport, { storeId: 'research-sort' })();

    await store.initialize();

    expect(store.activeTaskCount).toBe(2);
    expect(store.sortedTasks.map((item) => item.id)).toEqual(['queued', 'running', 'new', 'old']);
  });

  it('copies a Chat seed into an independently editable draft and submits only the frozen contract', async () => {
    const transport = api();
    const store = createResearchStore(transport, { storeId: 'research-draft' })();
    const seed = {
      question: '原始问题',
      searchMode: 'local' as const,
      knowledgeBaseIds: ['kb-chat'],
      sourceSessionId: 'session-1',
      sourceMessageId: 'message-1'
    };

    store.startDraft(seed);
    store.updateDraft({ question: '最终问题', searchMode: 'web', knowledgeBaseIds: ['kb-final'] });

    expect(seed).toEqual({
      question: '原始问题',
      searchMode: 'local',
      knowledgeBaseIds: ['kb-chat'],
      sourceSessionId: 'session-1',
      sourceMessageId: 'message-1'
    });
    expect(await store.submitDraft()).toBe('research-created');
    expect(transport.createTask).toHaveBeenCalledWith({
      question: '最终问题',
      searchMode: 'web',
      knowledgeBaseIds: ['kb-final']
    });
    expect(store.tasks[0].id).toBe('research-created');
    expect(store.draft?.status).toBe('submitted');
    expect(store.noticeMessage).toBe('研究任务已创建');
  });

  it('bounds Chat-seeded and edited questions to the 4,000 character contract', async () => {
    const transport = api();
    const store = createResearchStore(transport, { storeId: 'research-question-bound' })();
    store.startDraft({ question: '问'.repeat(4_100) });
    expect(store.draft?.question).toHaveLength(4_000);

    store.updateDraft({ question: '答'.repeat(4_050) });
    await store.submitDraft();
    expect(transport.createTask).toHaveBeenCalledWith(expect.objectContaining({
      question: '答'.repeat(4_000)
    }));
  });

  it('retains the draft and authoritative task snapshots when mutations fail', async () => {
    const transport = api({
      createTask: vi.fn(async () => { throw new Error('创建失败'); }),
      cancelTask: vi.fn(async () => { throw new Error('取消失败'); })
    });
    const store = createResearchStore(transport, { storeId: 'research-mutation-failure' })();
    store.startDraft({ question: '保留我', knowledgeBaseIds: ['kb-1'] });

    expect(await store.submitDraft()).toBeNull();
    expect(store.draft?.question).toBe('保留我');
    expect(store.draft?.status).toBe('editing');
    expect(store.errorMessage).toBe('创建失败');

    await store.initialize();
    const before = store.tasks[0];
    expect(await store.cancelTask(before.id)).toBe(false);
    expect(store.tasks[0]).toEqual(before);
    expect(store.errorMessage).toBe('取消失败');
  });

  it('polls while work is active, stops at terminal state, and refreshes immediately when visible again', async () => {
    vi.useFakeTimers();
    let request = 0;
    const transport = api({
      listTasks: vi.fn(async () => {
        request += 1;
        return request < 3
          ? [task({ status: 'running', stage: 'writing', progress: request * 20 })]
          : [task()];
      })
    });
    const store = createResearchStore(transport, { storeId: 'research-poll', pollIntervalMs: 100 })();

    await store.initialize();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.listTasks).toHaveBeenCalledTimes(3);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    store.startDraft({ question: '隐藏页面中的任务' });
    await store.submitDraft();
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.listTasks).toHaveBeenCalledTimes(3);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.listTasks).toHaveBeenCalledTimes(4);
    store.dispose();
  });

  it('does not let a late list response overwrite a newer action snapshot', async () => {
    let resolveList!: (tasks: ResearchTask[]) => void;
    const pendingList = new Promise<ResearchTask[]>((resolve) => { resolveList = resolve; });
    const transport = api({
      listTasks: vi.fn()
        .mockResolvedValueOnce([task({ id: 'research-1', status: 'running', stage: 'writing', progress: 80, updatedAt: 8 })])
        .mockImplementationOnce(() => pendingList)
    });
    const store = createResearchStore(transport, { storeId: 'research-stale' })();

    await store.initialize();
    const refresh = store.refreshTasks();
    await store.cancelTask('research-1');
    resolveList([task({ id: 'research-1', status: 'running', stage: 'writing', progress: 20, updatedAt: 2 })]);
    await refresh;

    expect(store.tasks[0].status).toBe('cancelled');
  });

  it('merges retry and detail responses as authoritative snapshots', async () => {
    const transport = api();
    const store = createResearchStore(transport, { storeId: 'research-actions' })();
    await store.initialize();

    expect(await store.retryTask('research-1')).toBe(true);
    expect(store.tasks[0].status).toBe('queued');
    expect(await store.ensureTask('research-unknown')).toBe(true);
    expect(store.tasks.some((item) => item.id === 'research-unknown')).toBe(true);
  });

  it('loads the whole session for a detail route and creates a distinct follow-up run', async () => {
    const root = task({ id: 'root', sessionId: 'session-1' });
    const second = task({
      id: 'second',
      question: '继续比较实现',
      sessionId: 'session-1',
      parentTaskId: 'root',
      turnIndex: 2
    });
    const transport = api({
      getSession: vi.fn(async () => [root, second]),
      continueTask: vi.fn(async (_id, input) => ({
        task: task({
          id: 'third',
          question: input.question,
          sessionId: 'session-1',
          parentTaskId: 'second',
          turnIndex: 3,
          status: 'queued',
          stage: 'planning',
          progress: 0,
          resultQuality: 'pending'
        }),
        notice: '已创建第 3 轮研究'
      }))
    });
    const store = createResearchStore(transport, { storeId: 'research-session' })();

    expect(await store.ensureSession('second')).toBe(true);
    expect(store.tasks.filter((item) => item.sessionId === 'session-1')).toHaveLength(2);
    expect(await store.continueTask('second', { question: '继续补充评测证据' })).toBe('third');
    expect(transport.continueTask).toHaveBeenCalledWith('second', { question: '继续补充评测证据' });
  });
});
