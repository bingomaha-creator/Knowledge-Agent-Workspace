import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { chatApi as defaultChatApi, toChatProtocolError, type ChatApi } from '@/services/chatApi';
import {
  cacheAcceptedTurn,
  cacheCanonicalMessage,
  chatQueryKeys
} from './chatQueries';
import { useChatStreamStore } from './chatStreamStore';
import type { OpenChatReplyInput } from './chat.types';

type ChatSendOptions = Pick<
  OpenChatReplyInput,
  'presetId' | 'ragEnabled' | 'knowledgeBaseIds'
>;

type UseChatStreamOptions = {
  sessionId?: string;
  onSessionAccepted?: (sessionId: string) => void;
  api?: Pick<ChatApi, 'openReply'>;
  createRequestId?: () => string;
};

export function useChatStream({
  sessionId,
  onSessionAccepted,
  api = defaultChatApi,
  createRequestId = () => crypto.randomUUID()
}: UseChatStreamOptions = {}) {
  const queryClient = useQueryClient();
  const status = useChatStreamStore((state) => state.status);
  const stop = useChatStreamStore((state) => state.stop);

  const send = useCallback(async (
    content: string,
    options: ChatSendOptions = {}
  ) => {
    const requestId = createRequestId();
    const controller = new AbortController();
    const store = useChatStreamStore.getState();
    if (!store.start(requestId, () => controller.abort())) return false;

    let terminalEventReceived = false;
    try {
      for await (const event of api.openReply({
        requestId,
        content,
        ...(sessionId ? { sessionId } : {}),
        ...options
      }, controller.signal)) {
        useChatStreamStore.getState().apply(event);
        if (event.type === 'accepted') {
          cacheAcceptedTurn(queryClient, event.accepted);
          if (event.accepted.session.id !== sessionId) {
            onSessionAccepted?.(event.accepted.session.id);
          }
        }
        if (event.type === 'done') {
          terminalEventReceived = true;
          cacheCanonicalMessage(queryClient, event.message);
        }
        if (event.type === 'error') {
          terminalEventReceived = true;
          if (event.message) cacheCanonicalMessage(queryClient, event.message);
        }
      }

      if (!terminalEventReceived && useChatStreamStore.getState().status !== 'idle') {
        useChatStreamStore.getState().fail({
          code: controller.signal.aborted ? 'REQUEST_ABORTED' : 'CHAT_STREAM_INTERRUPTED',
          message: controller.signal.aborted ? '请求已取消' : '流式连接意外结束',
          details: ''
        });
      }
    } catch (error) {
      useChatStreamStore.getState().fail(controller.signal.aborted
        ? { code: 'REQUEST_ABORTED', message: '请求已取消', details: '' }
        : toChatProtocolError(error));
    } finally {
      const activeSessionId = useChatStreamStore.getState().sessionId || sessionId;
      await queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions() });
      if (activeSessionId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: chatQueryKeys.session(activeSessionId) }),
          queryClient.invalidateQueries({ queryKey: chatQueryKeys.messages(activeSessionId) })
        ]);
      }
    }
    return true;
  }, [api, createRequestId, onSessionAccepted, queryClient, sessionId]);

  return {
    send,
    stop,
    status,
    isActive: status !== 'idle'
  };
}
