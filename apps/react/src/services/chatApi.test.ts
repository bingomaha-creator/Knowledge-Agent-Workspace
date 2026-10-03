import { describe, expect, it, vi } from 'vitest';
import { createChatApi } from './chatApi';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('chatApi', () => {
  it('owns session URLs and cursor query serialization', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ sessions: [] }))
      .mockResolvedValueOnce(jsonResponse({ messages: [], nextCursor: 101 }))
      .mockResolvedValueOnce(jsonResponse({ session: { id: 'session-1' } }))
      .mockResolvedValueOnce(jsonResponse({ deleted: true }))
      .mockResolvedValueOnce(jsonResponse({ message: { id: 'assistant-1' } }));
    const api = createChatApi(fetcher);

    await api.listSessions();
    await api.listMessages('session/1', { before: 201, limit: 100 });
    await api.updateSession('session-1', { ragEnabled: false });
    await api.deleteSession('session-1');
    await api.updateMessageMemoryCandidate('assistant-1', { id: 'memory-1', status: 'confirmed' });

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/chat/sessions', expect.any(Object));
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      '/api/chat/sessions/session%2F1/messages?before=201&limit=100',
      expect.any(Object)
    );
    expect(fetcher).toHaveBeenNthCalledWith(3, '/api/chat/sessions/session-1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ ragEnabled: false })
    }));
    expect(fetcher).toHaveBeenNthCalledWith(4, '/api/chat/sessions/session-1', expect.objectContaining({
      method: 'DELETE'
    }));
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      '/api/chat/messages/assistant-1/memory-candidate',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ memoryCandidate: { id: 'memory-1', status: 'confirmed' } })
      })
    );
  });

  it('normalizes accepted, token, tool, error, and canonical done events', async () => {
    const encoder = new TextEncoder();
    const raw = [
      'event: accepted\ndata: {"session":{"id":"session-1"},"userMessage":{"id":"user-1"},"assistantMessage":{"id":"assistant-1"},"reused":false}\n\n',
      'event: token\ndata: {"token":"你好"}\n\n',
      'event: tool\ndata: {"id":"tool-1","name":"search","args":{},"status":"running"}\n\n',
      'event: done\ndata: {"message":{"id":"assistant-1","content":"你好","status":"done"},"citations":[],"tools":[],"run":null}\n\n'
    ].join('');
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      }
    }), { status: 200 }));
    const api = createChatApi(fetcher);

    const events = [];
    for await (const event of api.openReply({ requestId: 'request-1', content: '你好' })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['accepted', 'token', 'tool', 'done']);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'accepted',
      accepted: expect.objectContaining({ reused: false })
    }));
    expect(events[2]).toEqual(expect.objectContaining({
      type: 'tool',
      tool: expect.objectContaining({ id: 'tool-1' })
    }));
    expect(events[3]).toEqual(expect.objectContaining({
      type: 'done',
      message: expect.objectContaining({ id: 'assistant-1', status: 'done' })
    }));
    expect(fetcher).toHaveBeenCalledWith('/api/chat/messages/stream', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ requestId: 'request-1', content: '你好' })
    }));
  });
});
