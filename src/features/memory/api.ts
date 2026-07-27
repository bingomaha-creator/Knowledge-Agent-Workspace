import type { MemoryApi, MemoryCreateInput, MemoryPatch, MemoryRecord } from './types';

interface ErrorPayload {
  error?: string;
  details?: string;
}

async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  let payload: (T & ErrorPayload) | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as T & ErrorPayload;
    } catch {
      throw new Error(response.ok ? fallback : text);
    }
  }
  if (!response.ok) {
    const message = payload?.error || fallback;
    throw new Error(payload?.details ? `${message}\n${payload.details}` : message);
  }
  return (payload || {}) as T;
}

export const memoryApi: MemoryApi = {
  async listAll() {
    const pageSize = 500;
    const memories: MemoryRecord[] = [];
    let total = Number.POSITIVE_INFINITY;
    while (memories.length < total) {
      const data = await readResponse<{
        memories?: MemoryRecord[];
        total?: number;
      }>(
        await fetch(`/api/memories?limit=${pageSize}&offset=${memories.length}`),
        '加载长期记忆失败'
      );
      const page = data.memories || [];
      total = Number.isFinite(Number(data.total)) ? Number(data.total) : page.length;
      memories.push(...page);
      if (!page.length) break;
    }
    return memories;
  },

  async create(input: MemoryCreateInput) {
    const data = await readResponse<{ memory?: MemoryRecord }>(
      await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      }),
      '创建长期记忆失败'
    );
    if (!data.memory) throw new Error('创建长期记忆失败');
    return data.memory;
  },

  async update(id: string, patch: MemoryPatch) {
    const data = await readResponse<{ memory?: MemoryRecord }>(
      await fetch(`/api/memories/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      }),
      '更新长期记忆失败'
    );
    if (!data.memory) throw new Error('更新长期记忆失败');
    return data.memory;
  },

  async remove(id: string) {
    await readResponse(
      await fetch(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      '删除长期记忆失败'
    );
  }
};
