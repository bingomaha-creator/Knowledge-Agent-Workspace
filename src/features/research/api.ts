import type {
  ContinueResearchInput,
  CreateResearchInput,
  ResearchApi,
  ResearchCapabilities,
  ResearchTask
} from './types';

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

async function taskResponse(response: Response, fallback: string) {
  const data = await readResponse<{ task?: ResearchTask }>(response, fallback);
  if (!data.task) throw new Error(fallback);
  return data.task;
}

export const researchApi: ResearchApi = {
  async getCapabilities() {
    const data = await readResponse<{ capabilities?: ResearchCapabilities }>(
      await fetch('/api/research/capabilities'),
      '加载研究能力失败'
    );
    if (!data.capabilities) throw new Error('加载研究能力失败');
    return data.capabilities;
  },

  async listTasks() {
    const data = await readResponse<{ tasks?: ResearchTask[] }>(
      await fetch('/api/research'),
      '加载研究任务失败'
    );
    return data.tasks || [];
  },

  async getTask(id: string) {
    return taskResponse(
      await fetch(`/api/research/${encodeURIComponent(id)}`),
      '加载研究任务失败'
    );
  },

  async getSession(id: string) {
    const data = await readResponse<{ runs?: ResearchTask[] }>(
      await fetch(`/api/research/${encodeURIComponent(id)}/session`),
      '加载研究会话失败'
    );
    if (!Array.isArray(data.runs) || !data.runs.length) throw new Error('加载研究会话失败');
    return data.runs;
  },

  async createTask(input: CreateResearchInput) {
    const data = await readResponse<{ task?: ResearchTask; notice?: string }>(
      await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      }),
      '创建研究任务失败'
    );
    if (!data.task) throw new Error('创建研究任务失败');
    return { task: data.task, notice: data.notice };
  },

  async continueTask(id: string, input: ContinueResearchInput) {
    const data = await readResponse<{ task?: ResearchTask; notice?: string }>(
      await fetch(`/api/research/${encodeURIComponent(id)}/follow-ups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      }),
      '创建后续研究失败'
    );
    if (!data.task) throw new Error('创建后续研究失败');
    return { task: data.task, notice: data.notice };
  },

  async cancelTask(id: string) {
    return taskResponse(
      await fetch(`/api/research/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
      '取消研究任务失败'
    );
  },

  async retryTask(id: string) {
    return taskResponse(
      await fetch(`/api/research/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
      '重试研究任务失败'
    );
  }
};
