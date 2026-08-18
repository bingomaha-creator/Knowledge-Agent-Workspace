import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatQueryKeys } from './chatQueries';
import { useChatStreamStore } from './chatStreamStore';
import type {
  ChatAccepted,
  ChatMessage,
  ChatMessagePage,
  ChatSession,
  ChatStreamEvent
} from './chat.types';
import { useChatStream } from './useChatStream';

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
const accepted: ChatAccepted = {
  reused: false, session, userMessage, assistantMessage
};
const doneMessage: ChatMessage = {
  ...assistantMessage, content: '你好，我在。', status: 'done', updatedAt: 2
};

function wrapper(queryClient: QueryClient) {
  return function TestProviders({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  useChatStreamStore.getState().reset();
});

describe('useChatStream', () => {
  it('patches accepted messages, then calibrates the cache with the canonical done message', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const events: ChatStreamEvent[] = [
      { type: 'accepted', accepted },
      { type: 'token', token: '临时内容' },
      { type: 'done', message: doneMessage, citations: [], tools: [], run: null }
    ];
    const api = {
      async *openReply() {
        for (const event of events) yield event;
      }
    };
    const onSessionAccepted = vi.fn();
    const { result } = renderHook(() => useChatStream({
      api,
      createRequestId: () => 'request-1',
      onSessionAccepted
    }), { wrapper: wrapper(queryClient) });

    await act(async () => {
      expect(await result.current.send('你好')).toBe(true);
    });

    expect(onSessionAccepted).toHaveBeenCalledWith('session-1');
    expect(queryClient.getQueryData(chatQueryKeys.sessions())).toEqual([session]);
    const cached = queryClient.getQueryData<InfiniteData<ChatMessagePage>>(
      chatQueryKeys.messages('session-1')
    );
    expect(cached?.pages[0].messages).toEqual([userMessage, doneMessage]);
    expect(useChatStreamStore.getState()).toEqual(expect.objectContaining({
      status: 'idle', content: '你好，我在。', sessionId: 'session-1'
    }));
  });

  it('continues the owned stream after the Chat component unmounts', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const api = {
      async *openReply() {
        yield { type: 'accepted', accepted } satisfies ChatStreamEvent;
        await blocked;
        yield { type: 'token', token: '后台继续' } satisfies ChatStreamEvent;
        yield {
          type: 'done',
          message: { ...doneMessage, content: '后台继续完成' },
          citations: [], tools: [], run: null
        } satisfies ChatStreamEvent;
      }
    };
    const { result, unmount } = renderHook(() => useChatStream({
      api,
      createRequestId: () => 'request-1'
    }), { wrapper: wrapper(queryClient) });

    let sending: Promise<boolean>;
    act(() => {
      sending = result.current.send('你好');
    });
    await waitFor(() => expect(useChatStreamStore.getState().status).toBe('streaming'));
    unmount();
    release?.();
    await sending!;

    expect(useChatStreamStore.getState()).toEqual(expect.objectContaining({
      status: 'idle', content: '后台继续完成'
    }));
    const cached = queryClient.getQueryData<InfiniteData<ChatMessagePage>>(
      chatQueryKeys.messages('session-1')
    );
    expect(cached?.pages[0].messages.at(-1)?.content).toBe('后台继续完成');
  });
});
