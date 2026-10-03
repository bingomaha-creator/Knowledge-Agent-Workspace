import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { VirtuosoMockContext } from 'react-virtuoso';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChatStreamStore } from './chatStreamStore';
import { ChatWorkspace } from './ChatWorkspace';

function renderWorkspace(onSessionAccepted = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 120 }}>
        {children}
      </VirtuosoMockContext.Provider>
    </QueryClientProvider>
  );
  return {
    ...render(<ChatWorkspace onSessionAccepted={onSessionAccepted} />, { wrapper: Wrapper }),
    onSessionAccepted
  };
}

function sseResponse() {
  const messageBase = {
    sessionId: 'session-1', requestId: 'request-1', citations: [], tools: [],
    memoryCandidate: null, runId: null, errorCode: '', errorMessage: '', createdAt: 1, updatedAt: 1
  };
  const events = [
    ['accepted', {
      reused: false,
      session: {
        id: 'session-1', title: '你好', presetId: 'general', ragEnabled: true,
        knowledgeBaseIds: [], messageCount: 2, createdAt: 1, updatedAt: 1
      },
      userMessage: {
        ...messageBase, id: 'user-1', sequenceNo: 1, role: 'user', content: '你好', status: 'done'
      },
      assistantMessage: {
        ...messageBase, id: 'assistant-1', sequenceNo: 2, role: 'assistant', content: '', status: 'streaming'
      }
    }],
    ['token', { token: '你好，我在。' }],
    ['done', {
      citations: [], tools: [], run: null,
      message: {
        ...messageBase, id: 'assistant-1', sequenceNo: 2, role: 'assistant',
        content: '你好，我在。', status: 'done', updatedAt: 2
      }
    }]
  ];
  return new Response(events.map(([event, data]) => (
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  )).join(''), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  useChatStreamStore.getState().reset();
});

describe('ChatWorkspace', () => {
  it('keeps a new chat unpersisted until the first message is sent', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/presets') {
        return new Response(JSON.stringify({ presets: [{
          id: 'general', name: '通用助手', description: '日常协作', defaultKnowledgeBaseIds: []
        }] }), { status: 200 });
      }
      if (url === '/api/knowledge-bases') {
        return new Response(JSON.stringify({ knowledgeBases: [] }), { status: 200 });
      }
      if (url === '/api/chat/messages/stream' && init?.method === 'POST') return sseResponse();
      if (url === '/api/chat/sessions') {
        return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
      }
      if (url.includes('/api/chat/sessions/session-1/messages')) {
        return new Response(JSON.stringify({ messages: [], nextCursor: null }), { status: 200 });
      }
      if (url === '/api/chat/sessions/session-1') {
        return new Response(JSON.stringify({ session: {
          id: 'session-1', title: '你好', presetId: 'general', ragEnabled: true,
          knowledgeBaseIds: [], messageCount: 2, createdAt: 1, updatedAt: 2
        } }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const onSessionAccepted = vi.fn();
    renderWorkspace(onSessionAccepted);

    expect(screen.getByText('开始一段新对话')).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalledWith('/api/chat/messages/stream', expect.anything());

    await userEvent.type(screen.getByRole('textbox', { name: '输入消息' }), '你好');
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    await waitFor(() => expect(onSessionAccepted).toHaveBeenCalledWith('session-1'));
    expect(fetcher).toHaveBeenCalledWith('/api/chat/messages/stream', expect.objectContaining({
      method: 'POST'
    }));
  });

  it('stops the active reply from the composer without removing the partial snapshot', async () => {
    let rejectStream: ((reason: Error) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/presets') {
        return new Response(JSON.stringify({ presets: [] }), { status: 200 });
      }
      if (url === '/api/knowledge-bases') {
        return new Response(JSON.stringify({ knowledgeBases: [] }), { status: 200 });
      }
      if (url === '/api/chat/messages/stream') {
        return new Promise<Response>((_resolve, reject) => {
          rejectStream = reject;
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      if (url === '/api/chat/sessions') {
        return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ messages: [], nextCursor: null }), { status: 200 });
    }));
    renderWorkspace();
    await userEvent.type(screen.getByRole('textbox', { name: '输入消息' }), '持续生成');
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '停止生成' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: '停止生成' }));
    await waitFor(() => expect(useChatStreamStore.getState().status).toBe('idle'));
    expect(useChatStreamStore.getState().error?.code).toBe('REQUEST_ABORTED');
    rejectStream?.(new Error('cleanup'));
  });
});
