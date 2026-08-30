import { ApiError } from '@/services/sseClient';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResearchApi, isResearchNotFound } from './researchApi';

const api = createResearchApi((input, init) => fetch(input, init));

const taskPayload = {
  id: 'research-1',
  question: '对比 X 与 Y',
  status: 'completed',
  stage: 'completed',
  progress: 100,
  error: '',
  report: '# 报告',
  citations: [],
  searchMode: 'local',
  webSearchStatus: 'not_requested',
  resultQuality: 'sufficient',
  limitations: [],
  failedStage: '',
  attempt: 1,
  cancelRequested: false,
  sessionId: 'research-1',
  parentTaskId: '',
  turnIndex: 1,
  continuationContext: null,
  knowledgeBaseIds: ['kb-1'],
  artifacts: {},
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1,
  finishedAt: 2
};

afterEach(() => vi.unstubAllGlobals());

describe('researchApi', () => {
  it('reads capabilities and treats missing payload as unavailable external search', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } }
    })));
    await expect(api.getCapabilities()).resolves.toEqual({
      localKnowledge: true,
      publicPrimarySearch: { available: true, role: 'supplemental' }
    });

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ capabilities: null })));
    await expect(api.getCapabilities()).resolves.toEqual({
      localKnowledge: false,
      publicPrimarySearch: { available: false, role: 'supplemental' }
    });
  });

  it('treats missing or non-array task payloads as protocol errors, keeps legal empty lists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
    const missing = await api.listTasks().catch((caught) => caught);
    expect(missing).toBeInstanceOf(ApiError);
    expect((missing as ApiError).code).toBe('INVALID_RESEARCH_PAYLOAD');

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tasks: 'not-an-array' })));
    const invalid = await api.listTasks().catch((caught) => caught);
    expect(invalid).toBeInstanceOf(ApiError);

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tasks: [] })));
    await expect(api.listTasks()).resolves.toEqual([]);
  });

  it('treats missing or non-array session runs as protocol errors, keeps legal empty lists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sessionId: 's-1' })));
    const missing = await api.getSession('research-1').catch((caught) => caught);
    expect(missing).toBeInstanceOf(ApiError);
    expect((missing as ApiError).code).toBe('INVALID_RESEARCH_PAYLOAD');

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sessionId: 's-1', runs: [] })));
    await expect(api.getSession('research-1')).resolves.toEqual({ sessionId: 's-1', runs: [] });
  });

  it('fetches a task and distinguishes 404 from other failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ task: taskPayload })));
    await expect(api.getTask('research-1')).resolves.toEqual(taskPayload);

    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: '研究任务不存在', code: 'RESEARCH_NOT_FOUND' }, { status: 404 }
    )));
    const error = await api.getTask('missing').catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(isResearchNotFound(error)).toBe(true);
  });

  it('fetches the session timeline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sessionId: 's-1', runs: [taskPayload] })));
    await expect(api.getSession('research-1')).resolves.toEqual({ sessionId: 's-1', runs: [taskPayload] });
  });

  it('creates a task with only allowed fields and no chat source ids', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ task: taskPayload, notice: '已创建' }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.createTask({ question: '对比 X 与 Y', searchMode: 'hybrid', knowledgeBaseIds: ['kb-1'] });

    expect(result).toEqual({ task: taskPayload, notice: '已创建' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/research');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ question: '对比 X 与 Y', searchMode: 'hybrid', knowledgeBaseIds: ['kb-1'] });
    expect(Object.keys(body)).toEqual(['question', 'searchMode', 'knowledgeBaseIds']);
  });

  it('continues a session through the follow-ups endpoint', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ task: { ...taskPayload, id: 'research-2', turnIndex: 2 } }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.continueTask('research-1', { question: '补充对比维度' });

    expect(result.task.id).toBe('research-2');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/research/research-1/follow-ups');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ question: '补充对比维度' });
  });

  it('retries and cancel through their dedicated endpoints', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ task: { ...taskPayload, status: 'queued' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.retryTask('research-1');
    await api.cancelTask('research-1');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/research/research-1/retry');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/research/research-1/cancel');
  });

  it('converts domain error payloads into stable errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: '只能基于已完成的研究继续追问', code: 'RESEARCH_FOLLOW_UP_REQUIRES_COMPLETED' },
      { status: 409 }
    )));
    const error = await api.continueTask('research-1', { question: 'x' }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('只能基于已完成的研究继续追问');
    expect((error as ApiError).code).toBe('RESEARCH_FOLLOW_UP_REQUIRES_COMPLETED');
  });
});
