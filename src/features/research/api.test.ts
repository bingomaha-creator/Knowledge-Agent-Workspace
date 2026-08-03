import { afterEach, describe, expect, it, vi } from 'vitest';
import { researchApi } from './api';
import type { ResearchTask } from './types';

const task: ResearchTask = {
  id: 'research-1',
  question: '测试冻结合同',
  status: 'queued',
  stage: 'planning',
  progress: 0,
  citations: [],
  knowledgeBaseIds: ['kb-1'],
  searchMode: 'hybrid',
  webSearchStatus: 'pending',
  resultQuality: 'pending',
  limitations: [],
  attempt: 1,
  sessionId: 'research-1',
  parentTaskId: '',
  turnIndex: 1,
  createdAt: 1,
  updatedAt: 1
};

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

describe('Research HTTP adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the task list and a URL-encoded task detail', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ tasks: [task] }))
      .mockResolvedValueOnce(response({ task }));
    vi.stubGlobal('fetch', fetch);

    await expect(researchApi.listTasks()).resolves.toEqual([task]);
    await expect(researchApi.getTask('research/1')).resolves.toEqual(task);
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/research');
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/research/research%2F1');
  });

  it('discovers deployment capabilities before presenting creation modes', async () => {
    const capabilities = {
      localKnowledge: true,
      publicPrimarySearch: { available: false, role: 'supplemental' as const }
    };
    const fetch = vi.fn(async () => response({ capabilities }));
    vi.stubGlobal('fetch', fetch);

    await expect(researchApi.getCapabilities()).resolves.toEqual(capabilities);
    expect(fetch).toHaveBeenCalledWith('/api/research/capabilities');
  });

  it('creates with only the frozen backend DTO and preserves the server notice', async () => {
    const fetch = vi.fn(async () => response({ task, notice: '联网不可用，已降级' }));
    vi.stubGlobal('fetch', fetch);

    await expect(researchApi.createTask({
      question: task.question,
      searchMode: 'hybrid',
      knowledgeBaseIds: ['kb-1']
    })).resolves.toEqual({ task, notice: '联网不可用，已降级' });

    expect(fetch).toHaveBeenCalledWith('/api/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: task.question,
        searchMode: 'hybrid',
        knowledgeBaseIds: ['kb-1']
      })
    });
    const createInit = (fetch.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit])[1];
    expect(createInit.body).not.toContain('sourceSessionId');
  });

  it('maps cancel and retry to their existing action endpoints', async () => {
    const fetch = vi.fn(async () => response({ task }));
    vi.stubGlobal('fetch', fetch);

    await researchApi.cancelTask('research/1');
    await researchApi.retryTask('research/1');

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/research/research%2F1/cancel', { method: 'POST' });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/research/research%2F1/retry', { method: 'POST' });
  });

  it('loads a session and creates a follow-up using the narrow continuation DTO', async () => {
    const followUp = {
      ...task,
      id: 'research-2',
      parentTaskId: task.id,
      turnIndex: 2,
      question: '继续比较 Agent Loop'
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ runs: [task, followUp] }))
      .mockResolvedValueOnce(response({ task: followUp, notice: '已创建第 2 轮研究' }));
    vi.stubGlobal('fetch', fetch);

    await expect(researchApi.getSession(task.id)).resolves.toEqual([task, followUp]);
    await expect(researchApi.continueTask(task.id, { question: followUp.question }))
      .resolves.toEqual({ task: followUp, notice: '已创建第 2 轮研究' });
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/research/research-1/session');
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/research/research-1/follow-ups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: followUp.question })
    });
  });

  it('turns structured and invalid responses into readable errors', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ error: '任务不存在', details: 'research-404' }, { status: 404 }))
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
    vi.stubGlobal('fetch', fetch);

    await expect(researchApi.getTask('missing')).rejects.toThrow('任务不存在\nresearch-404');
    await expect(researchApi.listTasks()).rejects.toThrow('<html>bad gateway</html>');
  });
});
