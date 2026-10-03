import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chatApi } from '@/services/chatApi';
import { chatQueryKeys } from './chatQueries';
import type { ChatSession, UpdateChatSessionInput } from './chat.types';

export function useChatSessions() {
  return useQuery({
    queryKey: chatQueryKeys.sessions(),
    queryFn: () => chatApi.listSessions()
  });
}

export function useUpdateChatSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, patch }: {
      sessionId: string;
      patch: UpdateChatSessionInput;
    }) => chatApi.updateSession(sessionId, patch),
    onSuccess(session) {
      queryClient.setQueryData(chatQueryKeys.session(session.id), session);
      queryClient.setQueryData<ChatSession[]>(chatQueryKeys.sessions(), (sessions) => (
        (sessions || []).map((item) => item.id === session.id ? session : item)
      ));
    }
  });
}

export function useDeleteChatSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => chatApi.deleteSession(sessionId),
    onSuccess(_deleted, sessionId) {
      queryClient.setQueryData<ChatSession[]>(chatQueryKeys.sessions(), (sessions) => (
        (sessions || []).filter((session) => session.id !== sessionId)
      ));
      queryClient.removeQueries({ queryKey: chatQueryKeys.session(sessionId) });
      queryClient.removeQueries({ queryKey: chatQueryKeys.messages(sessionId) });
    }
  });
}
