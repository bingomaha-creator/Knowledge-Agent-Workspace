import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type {
  ChatAccepted,
  ChatMessage,
  ChatMessagePage,
  ChatSession
} from './chat.types';

export const chatQueryKeys = {
  all: ['chat'] as const,
  sessions: () => ['chat', 'sessions'] as const,
  session: (sessionId: string) => ['chat', 'session', sessionId] as const,
  messages: (sessionId: string) => ['chat', 'messages', sessionId] as const,
  presets: () => ['chat', 'presets'] as const,
  run: (runId: string) => ['chat', 'run', runId] as const
};

export function messagesFromPages(
  data?: InfiniteData<ChatMessagePage, unknown>
): ChatMessage[] {
  if (!data) return [];
  const byId = new Map<string, ChatMessage>();
  for (const page of [...data.pages].reverse()) {
    for (const message of page.messages) byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => left.sequenceNo - right.sequenceNo);
}

function upsertSession(sessions: ChatSession[] | undefined, session: ChatSession) {
  return [session, ...(sessions || []).filter((item) => item.id !== session.id)]
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
}

function upsertMessages(messages: ChatMessage[], incoming: ChatMessage[]) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.sequenceNo - right.sequenceNo);
}

export function cacheAcceptedTurn(queryClient: QueryClient, accepted: ChatAccepted) {
  queryClient.setQueryData<ChatSession[]>(
    chatQueryKeys.sessions(),
    (sessions) => upsertSession(sessions, accepted.session)
  );
  queryClient.setQueryData(chatQueryKeys.session(accepted.session.id), accepted.session);
  queryClient.setQueryData<InfiniteData<ChatMessagePage, number | null>>(
    chatQueryKeys.messages(accepted.session.id),
    (current) => {
      if (!current) {
        return {
          pages: [{
            messages: [accepted.userMessage, accepted.assistantMessage],
            nextCursor: null
          }],
          pageParams: [null]
        };
      }
      return {
        ...current,
        pages: current.pages.map((page, index) => index === 0
          ? {
              ...page,
              messages: upsertMessages(page.messages, [
                accepted.userMessage,
                accepted.assistantMessage
              ])
            }
          : page)
      };
    }
  );
}

export function cacheCanonicalMessage(queryClient: QueryClient, message: ChatMessage) {
  queryClient.setQueryData<InfiniteData<ChatMessagePage, number | null>>(
    chatQueryKeys.messages(message.sessionId),
    (current) => {
      if (!current) {
        return {
          pages: [{ messages: [message], nextCursor: null }],
          pageParams: [null]
        };
      }
      return {
        ...current,
        pages: current.pages.map((page) => ({
          ...page,
          messages: page.messages.some((item) => item.id === message.id)
            ? page.messages.map((item) => item.id === message.id ? message : item)
            : page.messages
        }))
      };
    }
  );
}
