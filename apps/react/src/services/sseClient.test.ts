import { describe, expect, it, vi } from 'vitest';
import { ApiError, streamSse } from './sseClient';

function responseFromChunks(chunks: string[], init: ResponseInit = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  }), init);
}

describe('streamSse', () => {
  it('parses event blocks across arbitrary chunks and flushes the final block', async () => {
    const fetcher = vi.fn(async () => responseFromChunks([
      'event: token\ndata: {"token":"你',
      '好"}\n\nevent: done\ndata: {"message":',
      '{"id":"assistant-1"}}'
    ], { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));

    const events = [];
    for await (const event of streamSse('/stream', { method: 'POST' }, fetcher)) {
      events.push(event);
    }

    expect(events).toEqual([
      { event: 'token', data: { token: '你好' } },
      { event: 'done', data: { message: { id: 'assistant-1' } } }
    ]);
  });

  it('maps JSON protocol errors before attempting to read an SSE body', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: '消息内容不能为空',
      code: 'CHAT_EMPTY_MESSAGE',
      details: '请输入内容'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    }));

    const consume = async () => {
      for await (const _event of streamSse('/stream', {}, fetcher)) {
        // no-op
      }
    };

    await expect(consume()).rejects.toEqual(expect.objectContaining<ApiError>({
      name: 'ApiError',
      message: '消息内容不能为空',
      code: 'CHAT_EMPTY_MESSAGE',
      details: '请输入内容',
      status: 400
    }));
  });
});
