import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import styled from 'styled-components';
import type { MemoryStatus, MemoryType } from '@/services/memoryApi';
import type { ChatMessage } from './chat.types';
import { MessageCard } from './MessageCard';

type MessageListProps = {
  messages: ChatMessage[];
  hasEarlierMessages: boolean;
  loadingEarlierMessages: boolean;
  loadEarlierMessages: () => Promise<unknown>;
  streamAssistantMessageId?: string | null;
  memoryBusyIds?: Set<string>;
  onStartResearch?: (seed: { question: string; sourceMessageId: string }) => void;
  onReviewMemory?: (
    messageId: string,
    memoryId: string,
    decision: Extract<MemoryStatus, 'confirmed' | 'rejected'>
  ) => void;
  onCorrectMemory?: (
    messageId: string,
    memoryId: string,
    patch: { type: MemoryType; title: string; content: string; status: 'corrected' }
  ) => void;
};

const ListRegion = styled.section`
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--color-surface);
`;

const EmptyConversation = styled.div`
  display: grid;
  height: 100%;
  min-height: 16rem;
  padding: var(--space-8);
  place-content: center;
  justify-items: center;
  text-align: center;

  strong {
    font-size: clamp(1.35rem, 3vw, 2rem);
  }

  p {
    max-width: 34rem;
    margin: var(--space-3) 0 0;
    color: var(--color-text-muted);
    line-height: 1.6;
  }
`;

const TopStatus = styled.div`
  padding: var(--space-3);
  color: var(--color-text-subtle);
  font-size: 0.75rem;
  text-align: center;
`;

const ReturnToBottom = styled.button`
  position: absolute;
  z-index: 2;
  right: var(--space-5);
  bottom: var(--space-4);
  min-height: 2.5rem;
  padding: 0.55rem 0.85rem;
  border: 1px solid var(--color-primary-border);
  border-radius: 999px;
  color: var(--color-primary);
  background: var(--color-surface);
  box-shadow: var(--shadow-soft);
  font-size: 0.8125rem;
  font-weight: 700;
`;

const FIRST_ITEM_BASE = 1_000_000;

export function MessageList({
  messages,
  hasEarlierMessages,
  loadingEarlierMessages,
  loadEarlierMessages,
  streamAssistantMessageId,
  memoryBusyIds = new Set(),
  onStartResearch,
  onReviewMemory,
  onCorrectMemory
}: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [readingPaused, setReadingPaused] = useState(false);
  // 留在列表而非虚拟 item：卸载再进入视口仍恢复选择；会话退出时随列表释放。
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(() => new Set());
  const firstItemIndex = FIRST_ITEM_BASE + (messages[0]?.sequenceNo || 0);
  const streamMessage = useMemo(() => (
    messages.find((message) => message.id === streamAssistantMessageId)
  ), [messages, streamAssistantMessageId]);

  useEffect(() => {
    if (readingPaused || !isAtBottom || !streamMessage) return;
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
  }, [
    isAtBottom,
    readingPaused,
    streamMessage?.citations.length,
    streamMessage?.content.length,
    streamMessage?.status,
    streamMessage?.tools.length,
    streamMessage
  ]);

  if (!messages.length) {
    return (
      <ListRegion>
        <EmptyConversation>
          <strong>开始一段新对话</strong>
          <p>选择角色和资料范围后直接提问。会话会在首次发送时保存，并出现在左侧历史中。</p>
        </EmptyConversation>
      </ListRegion>
    );
  }

  return (
    <ListRegion aria-label="对话消息">
      <Virtuoso<ChatMessage>
        ref={virtuosoRef}
        style={{ height: '100%' }}
        data={messages}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={{ index: messages.length - 1, align: 'end' }}
        computeItemKey={(_index, message) => message.id}
        itemContent={(_index, message) => (
          <MessageCard
            message={message}
            memoryBusy={memoryBusyIds.has(message.id)}
            onStartResearch={onStartResearch}
            onReviewMemory={onReviewMemory}
            onCorrectMemory={onCorrectMemory}
            onReadingStart={() => setReadingPaused(true)}
            expandedDetails={expandedDetails}
            onDetailsChange={(key, open) => setExpandedDetails((current) => {
              const next = new Set(current);
              if (open) next.add(key); else next.delete(key);
              return next;
            })}
          />
        )}
        increaseViewportBy={{ top: 240, bottom: 240 }}
        followOutput={(atBottom) => !readingPaused && atBottom ? 'auto' : false}
        atBottomStateChange={setIsAtBottom}
        startReached={() => {
          if (hasEarlierMessages && !loadingEarlierMessages) void loadEarlierMessages();
        }}
        components={{
          Header: () => loadingEarlierMessages
            ? <TopStatus>正在加载更早的消息…</TopStatus>
            : hasEarlierMessages
              ? <TopStatus>向上滚动加载更早消息</TopStatus>
              : <TopStatus>已经到达会话开头</TopStatus>
        }}
      />
      {readingPaused || !isAtBottom ? (
        <ReturnToBottom
          type="button"
          onClick={() => {
            setReadingPaused(false);
            setIsAtBottom(true);
            virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
          }}
        >
          回到底部
        </ReturnToBottom>
      ) : null}
    </ListRegion>
  );
}
