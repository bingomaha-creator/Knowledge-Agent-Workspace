export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type SseEvent = {
  event: string;
  data: unknown;
};

type ApiErrorPayload = {
  error?: string;
  code?: string;
  details?: string;
};

export class ApiError extends Error {
  readonly code: string;
  readonly details: string;
  readonly status: number;

  constructor(message: string, options: {
    code?: string;
    details?: string;
    status?: number;
  } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = options.code || 'UNKNOWN_ERROR';
    this.details = options.details || '';
    this.status = options.status || 500;
  }
}

async function errorFromResponse(response: Response) {
  const text = await response.text().catch(() => '');
  let payload: ApiErrorPayload = {};
  try {
    payload = text ? JSON.parse(text) as ApiErrorPayload : {};
  } catch {
    // Non-JSON upstream failures retain their bounded status text only.
  }
  return new ApiError(payload.error || text || `请求失败：${response.status}`, {
    code: payload.code,
    details: payload.details,
    status: response.status
  });
}

function parseBlock(block: string): SseEvent | null {
  const lines = block.split(/\r?\n/);
  const event = lines.find((line) => line.startsWith('event:'))
    ?.slice(6).trim() || 'message';
  const dataText = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!dataText) return null;
  try {
    return { event, data: JSON.parse(dataText) as unknown };
  } catch {
    throw new ApiError('流式响应格式无效', {
      code: 'INVALID_SSE_DATA',
      details: `事件 ${event} 包含无效 JSON。`,
      status: 502
    });
  }
}

export async function* streamSse(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetcher: Fetcher = fetch
): AsyncGenerator<SseEvent> {
  const response = await fetcher(input, init);
  if (!response.ok) throw await errorFromResponse(response);
  if (!response.body) {
    throw new ApiError('流式响应不可读取', {
      code: 'SSE_BODY_UNAVAILABLE',
      status: 502
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        const parsed = parseBlock(block);
        if (parsed) yield parsed;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const parsed = parseBlock(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function readJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetcher: Fetcher = fetch
): Promise<T> {
  const response = await fetcher(input, init);
  if (!response.ok) throw await errorFromResponse(response);
  try {
    return await response.json() as T;
  } catch {
    throw new ApiError('服务器返回了无效数据', {
      code: 'INVALID_JSON_RESPONSE',
      status: 502
    });
  }
}
