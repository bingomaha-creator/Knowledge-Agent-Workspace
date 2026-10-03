import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResearchNewApi } from './researchNewApi';

const run = {
  id: 'research-new-1', question: '研究 X', mode: 'web', knowledgeBaseIds: [],
  status: 'queued', stage: 'planning', progress: 0, error: '', resultQuality: 'pending',
  report: '', brief: {}, tracks: [], diagnostics: {}, budget: {}, attempt: 0,
  cancelRequested: false, createdAt: 1, updatedAt: 1, startedAt: null, finishedAt: null,
  sources: [], evidence: []
};

afterEach(() => vi.unstubAllGlobals());

describe('researchNewApi', () => {
  it('uses the independent Research New endpoints and exact create payload', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/cancel')) return Response.json({ run: { ...run, status: 'cancelled' } });
      if (url === '/api/research-new') return Response.json({ run, notice: '已入队' }, { status: 202 });
      return Response.json({ run });
    });
    const api = createResearchNewApi(fetchMock);

    const created = await api.createRun({ question: '研究 X', mode: 'web', knowledgeBaseIds: [] });
    await api.getRun('research-new-1');
    await api.cancelRun('research-new-1');

    expect(created.notice).toBe('已入队');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/research-new');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      question: '研究 X', mode: 'web', knowledgeBaseIds: []
    });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/research-new/research-new-1');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/research-new/research-new-1/cancel');
  });
});
