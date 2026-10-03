import { create } from 'zustand';
import { createStore, type StateCreator } from 'zustand/vanilla';
import type {
  AgentRun,
  ChatCitation,
  ChatMemoryCandidate,
  ChatProtocolError,
  ChatStreamEvent,
  ChatToolInvocation
} from './chat.types';

export type ChatStreamStatus = 'idle' | 'connecting' | 'streaming' | 'stopping';

export type ChatStreamState = {
  status: ChatStreamStatus;
  requestId: string | null;
  sessionId: string | null;
  assistantMessageId: string | null;
  content: string;
  tools: ChatToolInvocation[];
  citations: ChatCitation[];
  memoryCandidate: ChatMemoryCandidate | null;
  run: AgentRun | null;
  error: ChatProtocolError | null;
  start: (requestId: string, abort: () => void) => boolean;
  apply: (event: ChatStreamEvent) => void;
  stop: () => void;
  fail: (error: ChatProtocolError) => void;
  reset: () => void;
};

const initialSnapshot = {
  status: 'idle' as const,
  requestId: null,
  sessionId: null,
  assistantMessageId: null,
  content: '',
  tools: [],
  citations: [],
  memoryCandidate: null,
  run: null,
  error: null
};

function upsertTool(tools: ChatToolInvocation[], incoming: ChatToolInvocation) {
  const index = tools.findIndex((tool) => tool.id === incoming.id);
  if (index < 0) return [...tools, incoming];
  return tools.map((tool, toolIndex) => (
    toolIndex === index ? { ...tool, ...incoming } : tool
  ));
}

const createChatStreamState: StateCreator<ChatStreamState> = (set, get) => {
  let abortActiveRequest: (() => void) | null = null;

  return {
    ...initialSnapshot,

    start(requestId, abort) {
      if (get().status !== 'idle') return false;
      abortActiveRequest = abort;
      set({
        ...initialSnapshot,
        status: 'connecting',
        requestId
      });
      return true;
    },

    apply(event) {
      if (event.type === 'accepted') {
        set({
          status: 'streaming',
          sessionId: event.accepted.session.id,
          assistantMessageId: event.accepted.assistantMessage.id,
          content: event.accepted.assistantMessage.content,
          tools: event.accepted.assistantMessage.tools,
          citations: event.accepted.assistantMessage.citations,
          memoryCandidate: event.accepted.assistantMessage.memoryCandidate,
          error: null
        });
        return;
      }
      if (event.type === 'token') {
        set((state) => ({ content: state.content + event.token }));
        return;
      }
      if (event.type === 'tool') {
        set((state) => ({ tools: upsertTool(state.tools, event.tool) }));
        return;
      }
      if (event.type === 'citations') {
        set({ citations: event.citations });
        return;
      }
      if (event.type === 'memory_candidate') {
        set({ memoryCandidate: event.memoryCandidate });
        return;
      }
      if (event.type === 'run') {
        set({ run: event.run });
        return;
      }
      if (event.type === 'done') {
        abortActiveRequest = null;
        set({
          status: 'idle',
          content: event.message.content,
          tools: event.message.tools,
          citations: event.message.citations,
          memoryCandidate: event.message.memoryCandidate,
          run: event.run,
          error: null
        });
        return;
      }
      if (event.type === 'error') {
        abortActiveRequest = null;
        set({
          status: 'idle',
          content: event.message?.content ?? get().content,
          tools: event.message?.tools ?? get().tools,
          citations: event.message?.citations ?? get().citations,
          memoryCandidate: event.message?.memoryCandidate ?? get().memoryCandidate,
          error: event.error
        });
      }
    },

    stop() {
      if (!abortActiveRequest || get().status === 'idle') return;
      set({ status: 'stopping' });
      abortActiveRequest();
    },

    fail(error) {
      abortActiveRequest = null;
      set({ status: 'idle', error });
    },

    reset() {
      if (get().status !== 'idle') return;
      abortActiveRequest = null;
      set(initialSnapshot);
    }
  };
};

export function createChatStreamStore() {
  return createStore<ChatStreamState>(createChatStreamState);
}

export const useChatStreamStore = create<ChatStreamState>(createChatStreamState);
export const selectChatStreamActive = (state: ChatStreamState) => state.status !== 'idle';
