// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryApi } from './api';
import type { MemoryRecord } from './types';

const memory = (id: string): MemoryRecord => ({
  id,
  type: 'fact',
  title: `记忆 ${id}`,
  content: '内容',
  details: {},
  confidence: 0.8,
  status: 'candidate',
  sourceConversationId: 'session-1',
  sourceMessageIds: [],
  sourceExcerpt: '',
  createdAt: 1,
  updatedAt: 1
});

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('Memory HTTP adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hides pagination while returning the complete Memory catalog', async () => {
    const first = Array.from({ length: 500 }, (_, index) => memory(`memory-${index}`));
    const last = memory('memory-500');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ memories: first, total: 501 }))
      .mockResolvedValueOnce(response({ memories: [last], total: 501 }));
    vi.stubGlobal('fetch', fetchMock);

    const records = await memoryApi.listAll();

    expect(records).toHaveLength(501);
    expect(records[500]).toEqual(last);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/memories?limit=500&offset=0');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/memories?limit=500&offset=500');
  });

  it('preserves the Memory update and delete contracts', async () => {
    const corrected = { ...memory('memory/1'), status: 'corrected' as const };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ memory: corrected }))
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await memoryApi.update('memory/1', {
      title: '已纠正',
      status: 'corrected'
    })).toEqual(corrected);
    await expect(memoryApi.remove('memory/1')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/memories/memory%2F1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '已纠正', status: 'corrected' })
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/memories/memory%2F1', {
      method: 'DELETE'
    });
  });

  it('creates an explicitly authored Memory through the canonical collection endpoint', async () => {
    const confirmed = {
      ...memory('memory-1'),
      type: 'preference' as const,
      title: '回答风格',
      content: '回答时先给结论，再解释原因。',
      confidence: 1,
      status: 'confirmed' as const
    };
    const fetchMock = vi.fn(async () => response({ memory: confirmed }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(memoryApi.create({
      type: 'preference',
      title: '回答风格',
      content: '回答时先给结论，再解释原因。'
    })).resolves.toEqual(confirmed);
    expect(fetchMock).toHaveBeenCalledWith('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'preference',
        title: '回答风格',
        content: '回答时先给结论，再解释原因。'
      })
    });
  });

  it('maps structured backend failures to readable errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      error: '记忆更新失败',
      details: '状态不合法'
    }, 409)));

    await expect(memoryApi.update('memory-1', { status: 'confirmed' }))
      .rejects.toThrow('记忆更新失败\n状态不合法');
  });
});
