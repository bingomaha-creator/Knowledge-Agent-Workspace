import { describe, expect, it, vi } from 'vitest';
import { createMemoryApi } from './memoryApi';

function response(body: unknown, status = 200) {
  return Response.json(body, { status });
}

describe('memoryApi', () => {
  it('serializes list filters and owns the complete Memory contract', async () => {
    const memory = { id: 'memory/1', title: '回答风格' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ memories: [memory], total: 1 }))
      .mockResolvedValueOnce(response({ memory }))
      .mockResolvedValueOnce(response({ memory }, 201))
      .mockResolvedValueOnce(response({ memory }))
      .mockResolvedValueOnce(response({ ok: true }));
    const api = createMemoryApi(fetcher);

    await api.list({ status: 'candidate', type: 'fact', query: ' 中文 ', limit: 50, offset: 100 });
    await api.get('memory/1');
    await api.create({ type: 'preference', title: '回答风格', content: '先给结论。' });
    await api.update('memory/1', { status: 'confirmed' });
    await api.remove('memory/1');

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      '/api/memories?status=candidate&type=fact&query=%E4%B8%AD%E6%96%87&limit=50&offset=100',
      expect.any(Object)
    );
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/memories/memory%2F1', expect.any(Object));
    expect(fetcher).toHaveBeenNthCalledWith(3, '/api/memories', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ type: 'preference', title: '回答风格', content: '先给结论。' })
    }));
    expect(fetcher).toHaveBeenNthCalledWith(4, '/api/memories/memory%2F1', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ status: 'confirmed' })
    }));
    expect(fetcher).toHaveBeenNthCalledWith(5, '/api/memories/memory%2F1', expect.objectContaining({ method: 'DELETE' }));
  });
});
