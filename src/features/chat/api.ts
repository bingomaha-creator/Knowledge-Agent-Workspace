import type {
  AgentPreset,
  AgentRun,
  ApiErrorPayload,
  BackendStreamEvent,
  ChatStreamRequest,
  ChatTransport
} from './types';

function formatApiError(payload: Partial<ApiErrorPayload>, fallback: string) {
  const message = payload.error || fallback;
  return payload.details ? `${message}\n${payload.details}` : message;
}

async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    if (!response.ok) throw new Error(text || fallback);
    throw new Error(fallback);
  }
}

function parseSseBlock(block: string) {
  const lines = block.split(/\r?\n/);
  const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n') || '{}';
  return { event, data };
}

function mapSseEvent(block: string): BackendStreamEvent | undefined {
  const { event, data } = parseSseBlock(block);
  const payload = JSON.parse(data);
  if (event === 'token') return { type: 'token', token: payload.token };
  if (event === 'tool') {
    return {
      type: 'tool',
      tool: {
        id: payload.id,
        name: payload.name,
        args: payload.args || {},
        status: payload.status,
        result: typeof payload.result === 'string'
          ? payload.result
          : payload.result
            ? JSON.stringify(payload.result, null, 2)
            : undefined
      }
    };
  }
  if (event === 'citations') {
    return { type: 'citations', citations: payload.citations || [] };
  }
  if (event === 'memory_candidate') {
    return { type: 'memory_candidate', memoryCandidate: payload.candidate };
  }
  if (event === 'run') return { type: 'run', run: payload.run };
  if (event === 'error') {
    return {
      type: 'error',
      message: payload.message || '请求失败',
      details: payload.details,
      code: payload.code
    };
  }
  if (event === 'done') {
    return {
      type: 'done',
      citations: payload.citations || [],
      tools: payload.tools || [],
      run: payload.run
    };
  }
  return undefined;
}

export const chatHttpTransport: ChatTransport = {
  async listPresets(): Promise<AgentPreset[]> {
    const response = await fetch('/api/presets');
    const data = await readJsonResponse<
      { presets?: AgentPreset[] } & Partial<ApiErrorPayload>
    >(response, '加载角色预设失败');
    if (!response.ok) throw new Error(formatApiError(data, '加载角色预设失败'));
    return data.presets || [];
  },

  async getRun(id: string): Promise<AgentRun> {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}`);
    const data = await readJsonResponse<
      { run?: AgentRun } & Partial<ApiErrorPayload>
    >(response, '加载 Agent run 失败');
    if (!response.ok || !data.run) {
      throw new Error(formatApiError(data, '加载 Agent run 失败'));
    }
    return data.run;
  },

  async *stream(
    request: ChatStreamRequest,
    signal: AbortSignal
  ): AsyncIterable<BackendStreamEvent> {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: request.messages,
        hasKnowledge: request.hasKnowledge ?? false,
        ragEnabled: request.ragEnabled ?? true,
        knowledgeBaseIds: request.knowledgeBaseIds ?? [],
        conversationId: request.conversationId ?? '',
        sourceMessageIds: request.sourceMessageIds ?? [],
        presetId: request.presetId ?? 'general'
      }),
      signal
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `请求失败：${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        break;
      }
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          const event = mapSseEvent(buffer);
          if (event) yield event;
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const event = mapSseEvent(block);
        if (event) yield event;
      }
    }
  }
};
