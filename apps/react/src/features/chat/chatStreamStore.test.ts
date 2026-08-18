import { describe, expect, it, vi } from 'vitest';
import { createChatStreamStore } from './chatStreamStore';
import type { ChatMessage, ChatSession } from './chat.types';

const session: ChatSession = {
  id: 'session-1', title: '你好', presetId: 'general', ragEnabled: true,
  knowledgeBaseIds: [], messageCount: 2, createdAt: 1, updatedAt: 1
};
const userMessage: ChatMessage = {
  id: 'user-1', sessionId: session.id, sequenceNo: 1, requestId: 'request-1',
  role: 'user', content: '你好', status: 'done', citations: [], tools: [],
  memoryCandidate: null, runId: null, errorCode: '', errorMessage: '', createdAt: 1, updatedAt: 1
};
const assistantMessage: ChatMessage = {
  ...userMessage, id: 'assistant-1', sequenceNo: 2, role: 'assistant', content: '', status: 'streaming'
};

describe('chatStreamStore', () => {
  it('owns only the active stream snapshot and converges to the canonical done message', () => {
    const store = createChatStreamStore();
    const abort = vi.fn();

    expect(store.getState().start('request-1', abort)).toBe(true);
    expect(store.getState().start('request-2', vi.fn())).toBe(false);
    store.getState().apply({
      type: 'accepted',
      accepted: { reused: false, session, userMessage, assistantMessage }
    });
    store.getState().apply({ type: 'token', token: '临时' });
    store.getState().apply({
      type: 'tool',
      tool: { id: 'tool-1', name: 'search', args: {}, status: 'running' }
    });
    store.getState().apply({
      type: 'tool',
      tool: { id: 'tool-1', name: 'search', args: {}, status: 'success', result: '完成' }
    });
    store.getState().apply({
      type: 'done',
      message: {
        ...assistantMessage,
        content: '规范结果',
        status: 'done',
        tools: [{ id: 'tool-1', name: 'search', args: {}, status: 'success', result: '完成' }]
      },
      citations: [], tools: [], run: null
    });

    expect(store.getState()).toEqual(expect.objectContaining({
      status: 'idle',
      requestId: 'request-1',
      sessionId: 'session-1',
      assistantMessageId: 'assistant-1',
      content: '规范结果',
      tools: [expect.objectContaining({ id: 'tool-1', status: 'success' })],
      error: null
    }));
    expect('sessions' in store.getState()).toBe(false);
  });

  it('keeps stop available until the request settles and records protocol errors', () => {
    const store = createChatStreamStore();
    const abort = vi.fn();
    store.getState().start('request-1', abort);

    store.getState().stop();
    expect(abort).toHaveBeenCalledOnce();
    expect(store.getState().status).toBe('stopping');

    store.getState().apply({
      type: 'error',
      error: { code: 'MODEL_FAILED', message: '模型失败', details: '上游不可用' },
      message: { ...assistantMessage, content: '部分输出', status: 'error' }
    });
    expect(store.getState()).toEqual(expect.objectContaining({
      status: 'idle',
      content: '部分输出',
      error: { code: 'MODEL_FAILED', message: '模型失败', details: '上游不可用' }
    }));
  });
});
