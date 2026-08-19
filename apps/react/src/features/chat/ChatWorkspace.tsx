import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import styled from 'styled-components';
import { chatApi } from '@/services/chatApi';
import { knowledgeCatalogApi } from '@/services/knowledgeCatalogApi';
import { memoryApi, type MemoryPatch } from '@/services/memoryApi';
import { ComposerPanel } from './ComposerPanel';
import { MessageList } from './MessageList';
import { useChatStreamStore } from './chatStreamStore';
import { cacheCanonicalMessage, chatQueryKeys } from './chatQueries';
import type { ChatMemoryCandidate, ChatMessage } from './chat.types';
import {
  useChatMessages,
  useChatPresets,
  useChatSession
} from './useChatSession';
import { useUpdateChatSession } from './useChatSessions';
import { useChatStream } from './useChatStream';

type ChatWorkspaceProps = {
  sessionId?: string;
  onSessionAccepted?: (sessionId: string) => void;
  onStartResearch?: (seed: {
    question: string;
    sourceSessionId?: string;
    sourceMessageId: string;
    knowledgeBaseIds: string[];
  }) => void;
  onStartBugInvestigation?: (seed: {
    content: string;
    sourceSessionId?: string;
    sourceMessageId: string;
  }) => void;
};

const Workspace = styled.section`
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: var(--color-surface);
  box-shadow: none;

  @media (max-width: 40rem) {
    min-height: calc(100dvh - 4.5rem);
  }
`;

const ChatHeader = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
`;

const HeaderCopy = styled.div`
  min-width: 0;

  h1 {
    margin: 0;
    overflow: hidden;
    font-size: 1.125rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  p {
    margin: 0.25rem 0 0;
    color: var(--color-text-muted);
    font-size: 0.75rem;
  }
`;

const HeaderStatus = styled.span`
  flex: 0 0 auto;
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-muted);
  background: var(--color-background);
  font-size: 0.75rem;
`;

const WorkspaceState = styled.div`
  display: grid;
  flex: 1;
  min-height: 20rem;
  padding: var(--space-8);
  place-content: center;
  color: var(--color-text-muted);
  text-align: center;

  strong {
    color: var(--color-text);
  }
`;

const InlineError = styled.p`
  margin: 0;
  padding: var(--space-2) var(--space-5);
  color: var(--color-danger);
  background: var(--color-danger-surface);
  font-size: 0.75rem;
`;

function streamStatusLabel(status: ReturnType<typeof useChatStreamStore.getState>['status']) {
  if (status === 'connecting') return '正在连接';
  if (status === 'stopping') return '正在停止';
  if (status === 'streaming') return '正在生成';
  return '';
}

export function ChatWorkspace({
  sessionId,
  onSessionAccepted,
  onStartResearch,
  onStartBugInvestigation
}: ChatWorkspaceProps) {
  const queryClient = useQueryClient();
  const sessionQuery = useChatSession(sessionId);
  const messagesQuery = useChatMessages(sessionId);
  const presetsQuery = useChatPresets();
  const knowledgeBasesQuery = useQuery({
    queryKey: chatQueryKeys.knowledgeBases(),
    queryFn: () => knowledgeCatalogApi.list(),
    staleTime: 60_000
  });
  const updateSession = useUpdateChatSession();
  const stream = useChatStream({ sessionId, onSessionAccepted });
  const streamSnapshot = useChatStreamStore(useShallow((state) => ({
    status: state.status,
    sessionId: state.sessionId,
    assistantMessageId: state.assistantMessageId,
    content: state.content,
    tools: state.tools,
    citations: state.citations,
    memoryCandidate: state.memoryCandidate,
    run: state.run,
    error: state.error
  })));
  const presets = presetsQuery.data || [];
  const [newPresetId, setNewPresetId] = useState('general');
  const [newRagEnabled, setNewRagEnabled] = useState(true);
  const [newKnowledgeBaseIds, setNewKnowledgeBaseIds] = useState<string[]>([]);
  const [memoryBusyIds, setMemoryBusyIds] = useState<Set<string>>(() => new Set());
  const [memoryError, setMemoryError] = useState('');
  const initializedNewScope = useRef(false);

  useEffect(() => {
    if (!presets.length || presets.some((preset) => preset.id === newPresetId)) return;
    setNewPresetId(presets[0].id);
  }, [newPresetId, presets]);

  useEffect(() => {
    if (initializedNewScope.current || !presets.length || !knowledgeBasesQuery.data) return;
    const availableIds = new Set(knowledgeBasesQuery.data.map((base) => base.id));
    setNewKnowledgeBaseIds(
      (presets.find((preset) => preset.id === newPresetId)?.defaultKnowledgeBaseIds || [])
        .filter((id) => availableIds.has(id))
    );
    initializedNewScope.current = true;
  }, [knowledgeBasesQuery.data, newPresetId, presets]);

  const session = sessionQuery.data;
  const presetId = session?.presetId || newPresetId;
  const ragEnabled = session?.ragEnabled ?? newRagEnabled;
  const knowledgeBaseIds = session?.knowledgeBaseIds || newKnowledgeBaseIds;
  const messages = useMemo(() => {
    if (
      streamSnapshot.status === 'idle'
      || streamSnapshot.sessionId !== sessionId
      || !streamSnapshot.assistantMessageId
    ) {
      return messagesQuery.messages;
    }
    return messagesQuery.messages.map((message): ChatMessage => (
      message.id === streamSnapshot.assistantMessageId
        ? {
            ...message,
            content: streamSnapshot.content,
            tools: streamSnapshot.tools,
            citations: streamSnapshot.citations,
            memoryCandidate: streamSnapshot.memoryCandidate,
            run: streamSnapshot.run,
            status: streamSnapshot.status === 'idle' ? message.status : 'streaming',
            errorCode: streamSnapshot.error?.code || message.errorCode,
            errorMessage: streamSnapshot.error?.message || message.errorMessage
          }
        : message
    ));
  }, [messagesQuery.messages, sessionId, streamSnapshot]);

  async function send(content: string) {
    return stream.send(content, sessionId ? {} : {
      presetId,
      ragEnabled,
      knowledgeBaseIds
    });
  }

  function changePreset(nextPresetId: string) {
    const preset = presets.find((item) => item.id === nextPresetId);
    if (!sessionId) {
      setNewPresetId(nextPresetId);
      setNewKnowledgeBaseIds(preset?.defaultKnowledgeBaseIds || []);
      return;
    }
    updateSession.mutate({
      sessionId,
      patch: {
        presetId: nextPresetId,
        knowledgeBaseIds: preset?.defaultKnowledgeBaseIds || []
      }
    });
  }

  function changeRag(enabled: boolean) {
    if (!sessionId) {
      setNewRagEnabled(enabled);
      return;
    }
    updateSession.mutate({ sessionId, patch: { ragEnabled: enabled } });
  }

  function changeKnowledgeBaseIds(nextIds: string[]) {
    if (!sessionId) {
      setNewKnowledgeBaseIds(nextIds);
      return;
    }
    updateSession.mutate({ sessionId, patch: { knowledgeBaseIds: nextIds } });
  }

  function findCandidate(messageId: string) {
    return messages.find((message) => message.id === messageId)?.memoryCandidate;
  }

  async function updateMemoryCandidate(
    messageId: string,
    memoryId: string,
    patch: MemoryPatch
  ) {
    setMemoryBusyIds((current) => new Set(current).add(messageId));
    setMemoryError('');
    try {
      const memory = await memoryApi.update(memoryId, patch);
      const projected = {
        ...findCandidate(messageId),
        ...memory
      } as ChatMemoryCandidate;
      const message = await chatApi.updateMessageMemoryCandidate(messageId, projected);
      cacheCanonicalMessage(queryClient, message);
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : '更新长期记忆失败');
    } finally {
      setMemoryBusyIds((current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    }
  }

  if (sessionId && (sessionQuery.isLoading || messagesQuery.isLoading)) {
    return <Workspace><WorkspaceState>正在恢复会话…</WorkspaceState></Workspace>;
  }
  if (sessionId && (sessionQuery.isError || messagesQuery.isError)) {
    return (
      <Workspace>
        <WorkspaceState>
          <strong>无法打开这个会话</strong>
          <span>会话可能已被删除，或服务暂时不可用。</span>
        </WorkspaceState>
      </Workspace>
    );
  }

  return (
    <Workspace>
      <ChatHeader>
        <HeaderCopy>
          <h1>{session?.title || '新对话'}</h1>
          <p>{session ? `${session.messageCount} 条消息` : '首次发送后保存到历史会话'}</p>
        </HeaderCopy>
        <HeaderStatus>{stream.isActive ? streamStatusLabel(stream.status) : '已就绪'}</HeaderStatus>
      </ChatHeader>
      <MessageList
        messages={messages}
        hasEarlierMessages={Boolean(messagesQuery.hasNextPage)}
        loadingEarlierMessages={messagesQuery.isFetchingNextPage}
        loadEarlierMessages={() => messagesQuery.fetchNextPage()}
        streamAssistantMessageId={streamSnapshot.assistantMessageId}
        memoryBusyIds={memoryBusyIds}
        onStartResearch={(seed) => onStartResearch?.({
          ...seed,
          sourceSessionId: sessionId,
          knowledgeBaseIds
        })}
        onStartBugInvestigation={(seed) => onStartBugInvestigation?.({
          ...seed,
          sourceSessionId: sessionId
        })}
        onReviewMemory={(messageId, memoryId, decision) => {
          void updateMemoryCandidate(messageId, memoryId, { status: decision });
        }}
        onCorrectMemory={(messageId, memoryId, patch) => {
          void updateMemoryCandidate(messageId, memoryId, patch);
        }}
      />
      {memoryError ? <InlineError role="alert">{memoryError}</InlineError> : null}
      <ComposerPanel
        isActive={stream.isActive}
        statusLabel={streamStatusLabel(stream.status)}
        presets={presets.length ? presets : [{
          id: 'general', name: '通用助手', description: '', defaultKnowledgeBaseIds: []
        }]}
        presetId={presetId}
        ragEnabled={ragEnabled}
        knowledgeBases={knowledgeBasesQuery.data || []}
        knowledgeBaseIds={knowledgeBaseIds}
        controlsDisabled={updateSession.isPending}
        onPresetChange={changePreset}
        onRagChange={changeRag}
        onKnowledgeBaseIdsChange={changeKnowledgeBaseIds}
        onSend={send}
        onStop={stream.stop}
      />
    </Workspace>
  );
}
