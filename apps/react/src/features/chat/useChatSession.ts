import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { chatApi } from '@/services/chatApi';
import { chatQueryKeys, messagesFromPages } from './chatQueries';

const MESSAGE_PAGE_SIZE = 100;

export function useChatSession(sessionId?: string) {
  return useQuery({
    queryKey: chatQueryKeys.session(sessionId || ''),
    queryFn: () => chatApi.getSession(sessionId as string),
    enabled: Boolean(sessionId)
  });
}

export function useChatMessages(sessionId?: string) {
  const query = useInfiniteQuery({
    queryKey: chatQueryKeys.messages(sessionId || ''),
    queryFn: ({ pageParam }) => chatApi.listMessages(sessionId as string, {
      before: pageParam ?? undefined,
      limit: MESSAGE_PAGE_SIZE
    }),
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(sessionId)
  });

  return {
    ...query,
    messages: messagesFromPages(query.data)
  };
}
