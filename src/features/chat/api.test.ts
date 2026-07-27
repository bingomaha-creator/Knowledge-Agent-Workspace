import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatHttpTransport } from './api';
import type { AgentPreset, AgentRun } from './types';

const preset: AgentPreset = {
  id: 'general',
  name: '通用助手',
  description: '通用对话',
  systemPrompt: '你是助手',
  modelParameters: { temperature: 0.7 },
  toolWhitelist: ['search_knowledge'],
  defaultKnowledgeBaseIds: ['kb-default'],
  fewShot: []
};

const run: AgentRun = {
  id: 'run/1',
  conversationId: 'session-1',
  status: 'success',
  model: 'qwen-plus',
  inputTokens: 12,
  outputTokens: 8,
  estimatedCost: 0.01,
  createdAt: 1,
  updatedAt: 2,
  finishedAt: 2,
  spans: []
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

function streamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return byteStreamResponse(chunks.map((chunk) => encoder.encode(chunk)));
}

function byteStreamResponse(chunks: Uint8Array[]) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function collect<T>(events: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('Chat HTTP/SSE adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads presets through the frozen HTTP contract', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ presets: [preset] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(chatHttpTransport.listPresets()).resolves.toEqual([preset]);
    expect(fetchMock).toHaveBeenCalledWith('/api/presets');
  });

  it('loads a URL-encoded run detail through the frozen HTTP contract', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ run }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(chatHttpTransport.getRun('run/1')).resolves.toEqual(run);
    expect(fetchMock).toHaveBeenCalledWith('/api/runs/run%2F1');
  });

  it('posts the frozen chat DTO and yields an SSE event split across network chunks', async () => {
    const fetchMock = vi.fn(async () => streamResponse([
      'event: token\ndata: {"tok',
      'en":"你好"}\n\n'
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;

    await expect(collect(chatHttpTransport.stream({
      messages: [{ role: 'user', content: '你好' }]
    }, signal))).resolves.toEqual([{ type: 'token', token: '你好' }]);

    expect(fetchMock).toHaveBeenCalledWith('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '你好' }],
        hasKnowledge: false,
        ragEnabled: true,
        knowledgeBaseIds: [],
        conversationId: '',
        sourceMessageIds: [],
        presetId: 'general'
      }),
      signal
    });
  });

  it('maps the current SSE vocabulary and ignores the retired Pitfall event', async () => {
    const citation = {
      id: 'citation-1',
      title: '文档',
      snippet: '证据',
      source: 'guide.md'
    };
    const memoryCandidate = {
      id: 'memory-1',
      type: 'fact',
      title: '项目事实',
      content: '使用 Vue',
      details: {},
      confidence: 0.8,
      status: 'candidate',
      sourceConversationId: 'session-1',
      sourceMessageIds: [],
      sourceExcerpt: '使用 Vue',
      createdAt: 1,
      updatedAt: 1
    };
    const finalRun = { ...run, id: 'run-1' };
    const raw = [
      sse('tool', {
        id: 'tool-1',
        name: 'search',
        args: { query: 'Vue' },
        status: 'success',
        result: { matches: 1 }
      }),
      sse('citations', { citations: [citation] }),
      sse('pitfall_candidate', {
        candidate: { title: '旧候选', symptom: '旧现象', solution: '旧方案', tags: [] }
      }),
      sse('memory_candidate', { candidate: memoryCandidate }),
      sse('run', { run: finalRun }),
      sse('error', { message: '请求失败', details: '上游中断', code: 'UPSTREAM' }),
      sse('done', {
        citations: [citation],
        tools: [{ id: 'tool-1', name: 'search', args: {}, status: 'success' }],
        run: finalRun
      })
    ].join('');
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([raw])));

    const events = await collect(chatHttpTransport.stream(
      { messages: [] },
      new AbortController().signal
    ));

    expect(events).toEqual([
      {
        type: 'tool',
        tool: {
          id: 'tool-1',
          name: 'search',
          args: { query: 'Vue' },
          status: 'success',
          result: '{\n  "matches": 1\n}'
        }
      },
      { type: 'citations', citations: [citation] },
      { type: 'memory_candidate', memoryCandidate },
      { type: 'run', run: finalRun },
      { type: 'error', message: '请求失败', details: '上游中断', code: 'UPSTREAM' },
      {
        type: 'done',
        citations: [citation],
        tools: [{ id: 'tool-1', name: 'search', args: {}, status: 'success' }],
        run: finalRun
      }
    ]);
  });

  it('flushes a multibyte event split across byte chunks when the stream ends without a delimiter', async () => {
    const bytes = new TextEncoder().encode('event: token\ndata: {"token":"你"}');
    const characterStart = bytes.indexOf(0xe4);
    vi.stubGlobal('fetch', vi.fn(async () => byteStreamResponse([
      bytes.slice(0, characterStart + 1),
      bytes.slice(characterStart + 1)
    ])));

    await expect(collect(chatHttpTransport.stream(
      { messages: [] },
      new AbortController().signal
    ))).resolves.toEqual([{ type: 'token', token: '你' }]);
  });
});
