// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryRecord } from '@/features/memory/types';
import { createChatStore } from './store';
import type {
  AgentPreset,
  AgentRun,
  BackendStreamEvent,
  ChatStreamRequest,
  ChatTransport
} from './types';

const generalPreset: AgentPreset = {
  id: 'general',
  name: '通用助手',
  description: '通用协作',
  systemPrompt: '',
  modelParameters: { temperature: 0.4 },
  toolWhitelist: [],
  defaultKnowledgeBaseIds: ['kb-default'],
  fewShot: []
};

const memoryCandidate: MemoryRecord = {
  id: 'memory-1',
  type: 'fact',
  title: '技术栈',
  content: '项目使用 Vue',
  details: {},
  confidence: 0.8,
  status: 'candidate',
  sourceConversationId: 'session-turn',
  sourceMessageIds: [],
  sourceExcerpt: '',
  createdAt: 1,
  updatedAt: 1
};

function transport(overrides: Partial<ChatTransport> = {}): ChatTransport {
  return {
    listPresets: vi.fn(async () => [generalPreset]),
    getRun: vi.fn(async () => ({ id: 'run-1', status: 'success' }) as AgentRun),
    stream: vi.fn((_request: ChatStreamRequest, _signal: AbortSignal) => (
      async function* emptyStream(): AsyncIterable<BackendStreamEvent> {}
    )()),
    ...overrides
  };
}

describe('Chat store', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.useRealTimers();
  });

  it('restores its session snapshot and initializes presets through the Chat interface', async () => {
    localStorage.setItem('yuan-agent-chat-sessions-v2', JSON.stringify([{
      id: 'session-existing',
      title: '已有会话',
      createdAt: 1,
      updatedAt: 2,
      knowledgeBaseIds: [],
      presetId: 'general',
      messages: [{
        id: 'assistant-existing',
        role: 'assistant',
        content: '已有回答',
        createdAt: 1,
        status: 'done'
      }]
    }]));
    localStorage.setItem('yuan-agent-active-session-id-v2', 'session-existing');

    const store = createChatStore(transport(), {
      storeId: 'chat-initialize',
      storage: localStorage,
      createId: (prefix) => `${prefix}-fixed`,
      now: () => 100
    })();

    expect(store.activeSessionId).toBe('session-existing');
    expect(store.messages.map((message) => message.content)).toEqual(['已有回答']);
    expect(store.selectedKnowledgeBaseIds).toEqual([]);
    expect(await store.initialize()).toBe(true);
    expect(store.presets).toEqual([generalPreset]);
    expect(store.errorMessage).toBe('');
  });

  it('repairs retired preset IDs without overwriting a restored session Knowledge scope', async () => {
    localStorage.setItem('yuan-agent-chat-sessions-v2', JSON.stringify([{
      id: 'session-retired-preset',
      title: '旧会话',
      createdAt: 1,
      updatedAt: 2,
      knowledgeBaseIds: ['kb-custom'],
      presetId: 'retired',
      messages: [{
        id: 'assistant-old',
        role: 'assistant',
        content: '旧回答',
        createdAt: 1,
        status: 'done'
      }]
    }]));
    const store = createChatStore(transport(), {
      storeId: 'chat-retired-preset',
      storage: localStorage,
      createId: (prefix) => `${prefix}-fallback`,
      now: () => 100
    })();

    expect(await store.initialize()).toBe(true);
    expect(store.activeSession.presetId).toBe('general');
    expect(store.selectedKnowledgeBaseIds).toEqual(['kb-custom']);
    expect(JSON.parse(localStorage.getItem('yuan-agent-chat-sessions-v2') || '[]')[0])
      .toMatchObject({ presetId: 'general', knowledgeBaseIds: ['kb-custom'] });
  });

  it('keeps the four safe fallback roles when preset loading is unavailable', async () => {
    const store = createChatStore(transport({
      listPresets: vi.fn(async () => {
        throw new Error('角色服务不可用');
      })
    }), {
      storeId: 'chat-preset-fallback',
      storage: localStorage,
      createId: (prefix) => `${prefix}-fallback-roles`,
      now: () => 100
    })();

    expect(await store.initialize()).toBe(false);
    expect(store.presets.map((preset) => preset.id)).toEqual([
      'general',
      'documents',
      'code',
      'research'
    ]);
    expect(store.errorMessage).toBe('角色服务不可用');
  });

  it('starts sessions and applies preset defaults only inside the valid Knowledge catalog', async () => {
    const codePreset: AgentPreset = {
      ...generalPreset,
      id: 'code',
      name: '代码助手',
      defaultKnowledgeBaseIds: ['kb-code', 'kb-missing']
    };
    let sequence = 0;
    const store = createChatStore(transport({
      listPresets: vi.fn(async () => [generalPreset, codePreset])
    }), {
      storeId: 'chat-session-preset',
      storage: localStorage,
      createId: (prefix) => `${prefix}-${++sequence}`,
      now: () => 100 + sequence
    })();
    await store.initialize();

    store.setPreset('code', ['kb-code']);
    expect(store.activeSession.presetId).toBe('code');
    expect(store.selectedKnowledgeBaseIds).toEqual(['kb-code']);

    const firstSessionId = store.activeSessionId;
    store.setDraft('未发送的旧草稿');
    expect(store.startSession(['kb-code'])).toBe(true);
    expect(store.activeSessionId).not.toBe(firstSessionId);
    expect(store.activeSession.presetId).toBe('code');
    expect(store.selectedKnowledgeBaseIds).toEqual(['kb-code']);
    expect(store.input).toBe('');
    expect(store.sessionList).toHaveLength(2);

    store.setPreset('general', []);
    expect(store.activeSession.presetId).toBe('general');
    expect(store.selectedKnowledgeBaseIds).toEqual([]);
    expect(store.noticeMessage).toContain('通用助手');
  });

  it('owns only session Knowledge IDs and reconciles them from the authoritative catalog', () => {
    const store = createChatStore(transport(), {
      storeId: 'chat-knowledge-scope',
      storage: localStorage,
      createId: (prefix) => `${prefix}-scope`,
      now: () => 100
    })();

    store.syncKnowledgeCatalog(['kb-project'], {
      includeInActiveSession: 'kb-project'
    });
    expect(store.selectedKnowledgeBaseIds).toEqual(['kb-project']);

    store.toggleKnowledgeBase('kb-project', false);
    expect(store.selectedKnowledgeBaseIds).toEqual([]);
    store.toggleKnowledgeBase('kb-project', true);
    store.toggleKnowledgeBase('kb-project', true);
    expect(store.selectedKnowledgeBaseIds).toEqual(['kb-project']);

    store.syncKnowledgeCatalog([]);
    expect(store.selectedKnowledgeBaseIds).toEqual([]);
  });

  it('streams one turn through the Chat interface and returns produced Memory candidates', async () => {
    let capturedRequest: ChatStreamRequest | undefined;
    const store = createChatStore(transport({
      stream: (request) => {
        capturedRequest = request;
        return (async function* streamTurn() {
          yield { type: 'token', token: '这是' } as BackendStreamEvent;
          yield { type: 'token', token: '答案' } as BackendStreamEvent;
          yield {
            type: 'memory_candidate',
            memoryCandidate
          } as BackendStreamEvent;
          yield { type: 'done' } as BackendStreamEvent;
        })();
      }
    }), {
      storeId: 'chat-stream-turn',
      storage: localStorage,
      createId: (prefix) => `${prefix}-turn`,
      now: () => 100,
      persistDelayMs: 0
    })();

    await expect(store.send('请记住项目使用 Vue')).resolves.toEqual({
      memoryCandidates: [memoryCandidate]
    });

    expect(store.messages.slice(-2).map((message) => ({
      role: message.role,
      content: message.content,
      status: message.status
    }))).toEqual([
      { role: 'user', content: '请记住项目使用 Vue', status: 'idle' },
      { role: 'assistant', content: '这是答案', status: 'done' }
    ]);
    expect(store.messages.slice(-1)[0]?.memoryCandidate).toEqual(memoryCandidate);
    expect(store.isResponding).toBe(false);
    expect(capturedRequest).toMatchObject({
      messages: [{ role: 'assistant', content: expect.any(String) }, {
        role: 'user',
        content: '请记住项目使用 Vue'
      }],
      knowledgeBaseIds: ['kb-default'],
      conversationId: 'session-turn',
      sourceMessageIds: ['user-turn', 'assistant-turn'],
      presetId: 'general'
    });
  });

  it('transports extended history with message IDs instead of selecting the last 12 messages', async () => {
    let capturedRequest: ChatStreamRequest | undefined;
    const store = createChatStore(transport({
      stream: (request) => {
        capturedRequest = request;
        return (async function* emptyTurn() {})();
      }
    }), {
      storeId: 'chat-context-transport',
      storage: localStorage,
      createId: (() => {
        let sequence = 0;
        return (prefix: string) => `${prefix}-${++sequence}`;
      })(),
      now: () => 100,
      persistDelayMs: 0
    })();

    store.activeSession.messages.push(
      ...Array.from({ length: 14 }, (_, index) => ({
        id: `history-${index + 1}`,
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `扩展历史 ${index + 1}`,
        createdAt: index + 1,
        status: 'done' as const
      }))
    );

    await store.send('当前问题');

    const sentMessages = capturedRequest?.messages || [];
    expect(sentMessages).toHaveLength(16);
    expect(sentMessages[0]).toMatchObject({
      id: expect.any(String),
      role: 'assistant'
    });
    expect(sentMessages[sentMessages.length - 1]).toMatchObject({
      id: expect.any(String),
      role: 'user',
      content: '当前问题'
    });
  });

  it('stops an active stream, preserves partial output, and reconciles the terminal run', async () => {
    const runningRun: AgentRun = {
      id: 'run-cancel',
      conversationId: 'session-cancel',
      status: 'running',
      model: 'qwen',
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      createdAt: 1,
      updatedAt: 1,
      spans: []
    };
    const cancelledRun: AgentRun = {
      ...runningRun,
      status: 'cancelled',
      updatedAt: 2,
      finishedAt: 2
    };
    const store = createChatStore(transport({
      getRun: vi.fn(async () => cancelledRun),
      stream: (_request, signal) => (async function* cancellableStream() {
        yield { type: 'run', run: runningRun } as BackendStreamEvent;
        yield { type: 'token', token: '部分回答' } as BackendStreamEvent;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'token', token: '不应出现的迟到内容' } as BackendStreamEvent;
      })()
    }), {
      storeId: 'chat-cancel',
      storage: localStorage,
      createId: (prefix) => `${prefix}-cancel`,
      now: () => 100,
      persistDelayMs: 0,
      sleep: async () => undefined
    })();

    const turn = store.send('开始回答');
    await vi.waitFor(() => {
      expect(store.messages.slice(-1)[0]?.content).toBe('部分回答');
    });

    expect(store.startSession(['kb-default'])).toBe(false);
    store.stop();
    await turn;

    expect(store.messages.slice(-1)[0]).toMatchObject({
      content: '部分回答',
      status: 'done',
      run: cancelledRun
    });
    expect(store.noticeMessage).toBe('已停止生成。');
    expect(store.isResponding).toBe(false);
  });

  it('reconciles a still-running run after a normal stream end', async () => {
    const runningRun: AgentRun = {
      id: 'run-normal',
      conversationId: 'session-normal',
      status: 'running',
      model: 'qwen',
      inputTokens: 1,
      outputTokens: 1,
      estimatedCost: 0,
      createdAt: 1,
      updatedAt: 1,
      spans: []
    };
    const successRun: AgentRun = {
      ...runningRun,
      status: 'success',
      updatedAt: 2,
      finishedAt: 2
    };
    const runs = [runningRun, successRun];
    const store = createChatStore(transport({
      getRun: vi.fn(async () => runs.shift() || successRun),
      stream: () => (async function* completedStream() {
        yield { type: 'run', run: runningRun } as BackendStreamEvent;
        yield { type: 'token', token: '完整回答' } as BackendStreamEvent;
        yield { type: 'done', run: runningRun } as BackendStreamEvent;
      })()
    }), {
      storeId: 'chat-normal-run-reconcile',
      storage: localStorage,
      createId: (prefix) => `${prefix}-normal`,
      now: () => 100,
      persistDelayMs: 0,
      sleep: async () => undefined
    })();

    await store.send('正常完成');

    expect(store.messages.slice(-1)[0]).toMatchObject({
      content: '完整回答',
      status: 'done',
      run: successRun
    });
  });

  it('reconciles Chat message projections from the authoritative Memory catalog', async () => {
    const store = createChatStore(transport({
      stream: () => (async function* memoryStream() {
        yield {
          type: 'memory_candidate',
          memoryCandidate
        } as BackendStreamEvent;
        yield { type: 'done' } as BackendStreamEvent;
      })()
    }), {
      storeId: 'chat-memory-projection',
      storage: localStorage,
      createId: (prefix) => `${prefix}-memory`,
      now: () => 100,
      persistDelayMs: 0
    })();
    await store.send('记住这件事');

    const confirmed = {
      ...memoryCandidate,
      status: 'confirmed' as const,
      updatedAt: 2
    };
    store.syncMemoryProjections([confirmed]);
    expect(store.messages.slice(-1)[0]).toMatchObject({
      memoryCandidate: confirmed,
      memoryStatus: 'confirmed'
    });

    store.syncMemoryProjections([]);
    expect(store.messages.slice(-1)[0]?.memoryCandidate).toBeUndefined();
    expect(store.messages.slice(-1)[0]?.memoryStatus).toBeUndefined();
  });

  it('selects and deletes sessions without ever losing the active session root', () => {
    let sequence = 0;
    const store = createChatStore(transport(), {
      storeId: 'chat-session-lifecycle',
      storage: localStorage,
      createId: (prefix) => `${prefix}-${++sequence}`,
      now: () => 100 + sequence
    })();
    const firstSessionId = store.activeSessionId;
    store.startSession(['kb-default']);
    const secondSessionId = store.activeSessionId;

    expect(store.selectSession(firstSessionId)).toBe(true);
    expect(store.activeSessionId).toBe(firstSessionId);
    expect(store.deleteSession(firstSessionId)).toBe(true);
    expect(store.activeSessionId).toBe(secondSessionId);
    expect(store.deleteSession(secondSessionId)).toBe(false);
    expect(store.sessionList).toHaveLength(1);
    expect(store.messageCount).toBe(1);
  });

  it('accepts an explicit draft and keeps the RAG preference in Chat state', async () => {
    const store = createChatStore(transport({
      stream: () => (async function* doneStream() {
        yield { type: 'done' } as BackendStreamEvent;
      })()
    }), {
      storeId: 'chat-draft-rag',
      storage: localStorage,
      createId: (prefix) => `${prefix}-draft`,
      now: () => 100,
      persistDelayMs: 0
    })();

    store.setDraft('语音识别文本');
    store.toggleRag();
    expect(store.input).toBe('语音识别文本');
    expect(store.ragEnabled).toBe(false);
    expect(store.noticeMessage).toBe('已关闭 RAG 检索。');

    await store.send();
    expect(store.input).toBe('');
    expect(store.messages.slice(-2)[0]?.content).toBe('语音识别文本');
  });

  it('disposes an active stream and flushes the final session projection', async () => {
    const store = createChatStore(transport({
      stream: (_request, signal) => (async function* openStream() {
        yield { type: 'token', token: '未完成内容' } as BackendStreamEvent;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      })()
    }), {
      storeId: 'chat-dispose',
      storage: localStorage,
      createId: (() => {
        let sequence = 0;
        return (prefix: string) => `${prefix}-dispose-${++sequence}`;
      })(),
      now: () => 100,
      persistDelayMs: 10_000
    })();

    const turn = store.send('开始长回答');
    await vi.waitFor(() => {
      expect(store.messages.slice(-1)[0]?.content).toBe('未完成内容');
    });
    store.dispose();
    await turn;

    expect(store.messages.slice(-1)[0]?.status).toBe('done');
    expect(localStorage.getItem('yuan-agent-chat-sessions-v2')).toContain('未完成内容');
  });
});
