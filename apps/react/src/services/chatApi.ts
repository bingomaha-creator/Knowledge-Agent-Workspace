import type {
  AgentPreset,
  AgentRun,
  ChatAccepted,
  ChatCitation,
  ChatMemoryCandidate,
  ChatMessage,
  ChatMessagePage,
  ChatProtocolError,
  ChatSession,
  ChatStreamEvent,
  ChatToolInvocation,
  OpenChatReplyInput,
  UpdateChatSessionInput
} from '@/features/chat/chat.types';
import { ApiError, readJson, streamSse, type Fetcher } from './sseClient';

type UnknownPayload = Record<string, unknown>;

function record(value: unknown): UnknownPayload {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownPayload
    : {};
}

function mapStreamEvent(event: string, rawData: unknown): ChatStreamEvent | null {
  const data = record(rawData);
  if (event === 'accepted') {
    return { type: 'accepted', accepted: data as ChatAccepted };
  }
  if (event === 'token') {
    return { type: 'token', token: typeof data.token === 'string' ? data.token : '' };
  }
  if (event === 'tool') {
    return { type: 'tool', tool: data as ChatToolInvocation };
  }
  if (event === 'citations') {
    return {
      type: 'citations',
      citations: Array.isArray(data.citations) ? data.citations as ChatCitation[] : []
    };
  }
  if (event === 'memory_candidate') {
    return {
      type: 'memory_candidate',
      memoryCandidate: record(data.candidate) as ChatMemoryCandidate
    };
  }
  if (event === 'run') {
    return { type: 'run', run: record(data.run) as AgentRun };
  }
  if (event === 'error') {
    return {
      type: 'error',
      error: {
        code: typeof data.code === 'string' ? data.code : 'CHAT_REPLY_FAILED',
        message: typeof data.message === 'string' ? data.message : '回答生成失败',
        details: typeof data.details === 'string' ? data.details : ''
      },
      message: data.message && typeof data.message === 'object'
        ? data.message as ChatMessage
        : undefined
    };
  }
  if (event === 'done') {
    const message = record(data.message) as ChatMessage;
    if (!message.id) {
      throw new ApiError('完成事件缺少规范消息', {
        code: 'INVALID_CHAT_DONE_EVENT',
        status: 502
      });
    }
    return {
      type: 'done',
      message,
      citations: Array.isArray(data.citations) ? data.citations as ChatCitation[] : [],
      tools: Array.isArray(data.tools) ? data.tools as ChatToolInvocation[] : [],
      run: data.run && typeof data.run === 'object' ? data.run as AgentRun : null
    };
  }
  return null;
}

function jsonInit(method = 'GET', body?: unknown): RequestInit {
  return {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  };
}

export function createChatApi(fetcher: Fetcher = fetch) {
  return {
    async listSessions() {
      const data = await readJson<{ sessions?: ChatSession[] }>(
        '/api/chat/sessions',
        jsonInit(),
        fetcher
      );
      return data.sessions || [];
    },

    async getSession(sessionId: string) {
      const data = await readJson<{ session: ChatSession }>(
        `/api/chat/sessions/${encodeURIComponent(sessionId)}`,
        jsonInit(),
        fetcher
      );
      return data.session;
    },

    async listMessages(
      sessionId: string,
      options: { before?: number; limit?: number } = {}
    ) {
      const query = new URLSearchParams();
      if (options.before !== undefined) query.set('before', String(options.before));
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      const suffix = query.size ? `?${query.toString()}` : '';
      return readJson<ChatMessagePage>(
        `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`,
        jsonInit(),
        fetcher
      );
    },

    async getMessage(messageId: string) {
      const data = await readJson<{ message: ChatMessage }>(
        `/api/chat/messages/${encodeURIComponent(messageId)}`,
        jsonInit(),
        fetcher
      );
      return data.message;
    },

    async updateSession(sessionId: string, patch: UpdateChatSessionInput) {
      const data = await readJson<{ session: ChatSession }>(
        `/api/chat/sessions/${encodeURIComponent(sessionId)}`,
        jsonInit('PATCH', patch),
        fetcher
      );
      return data.session;
    },

    async deleteSession(sessionId: string) {
      const data = await readJson<{ deleted: boolean }>(
        `/api/chat/sessions/${encodeURIComponent(sessionId)}`,
        jsonInit('DELETE'),
        fetcher
      );
      return data.deleted;
    },

    async listPresets() {
      const data = await readJson<{ presets?: AgentPreset[] }>(
        '/api/presets',
        jsonInit(),
        fetcher
      );
      return data.presets || [];
    },

    async getRun(runId: string) {
      const data = await readJson<{ run: AgentRun }>(
        `/api/runs/${encodeURIComponent(runId)}`,
        jsonInit(),
        fetcher
      );
      return data.run;
    },

    async *openReply(
      input: OpenChatReplyInput,
      signal?: AbortSignal
    ): AsyncGenerator<ChatStreamEvent> {
      for await (const event of streamSse(
        '/api/chat/messages/stream',
        { ...jsonInit('POST', input), signal },
        fetcher
      )) {
        const mapped = mapStreamEvent(event.event, event.data);
        if (mapped) yield mapped;
      }
    }
  };
}

export type ChatApi = ReturnType<typeof createChatApi>;
// Resolve the browser fetch at call time so tests, service workers, and runtime wrappers can replace it.
export const chatApi = createChatApi((input, init) => fetch(input, init));

export function toChatProtocolError(error: unknown): ChatProtocolError {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { code: 'CHAT_REQUEST_FAILED', message: error.message, details: '' };
  }
  return { code: 'CHAT_REQUEST_FAILED', message: '请求失败', details: '' };
}
