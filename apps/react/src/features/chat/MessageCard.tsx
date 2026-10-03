import { useState, type SyntheticEvent } from 'react';
import styled from 'styled-components';
import type { MemoryStatus, MemoryType } from '@/services/memoryApi';
import { SafeMarkdown } from '@/ui/SafeMarkdown';
import { Select } from '@/ui/Select';
import type { ChatMessage } from './chat.types';
import { ChatExecutionDetails } from './ChatExecutionDetails';

type MemoryCorrection = {
  type: MemoryType;
  title: string;
  content: string;
  status: 'corrected';
};

type MessageCardProps = {
  message: ChatMessage;
  memoryBusy?: boolean;
  onStartResearch?: (seed: { question: string; sourceMessageId: string }) => void;
  onReviewMemory?: (
    messageId: string,
    memoryId: string,
    decision: Extract<MemoryStatus, 'confirmed' | 'rejected'>
  ) => void;
  onCorrectMemory?: (messageId: string, memoryId: string, patch: MemoryCorrection) => void;
  onReadingStart?: () => void;
  expandedDetails: ReadonlySet<string>;
  onDetailsChange: (key: string, open: boolean) => void;
};

const Article = styled.article`
  display: grid;
  width: min(100%, 52rem);
  min-width: 0;
  gap: var(--space-2);
  margin: 0 auto;
  padding: var(--space-3) var(--space-5);

  &[data-role='user'] { justify-items: end; }
`;

const MessageMeta = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-subtle);
  font-size: 0.75rem;
  font-weight: 650;
`;

const Bubble = styled.div`
  min-width: 0;
  max-width: min(100%, 46rem);
  padding: 0.9rem 1rem;
  overflow-wrap: anywhere;
  border: 1px solid var(--color-border);
  border-radius: 1.125rem;
  color: var(--color-text);
  background: var(--color-surface);
  line-height: 1.65;

  ${Article}[data-role='user'] & {
    border-color: var(--color-primary-border);
    border-bottom-right-radius: 0.35rem;
    background: var(--color-primary-surface);
  }

  ${Article}[data-role='assistant'] & { border-bottom-left-radius: 0.35rem; }
`;

const Markdown = styled(SafeMarkdown)`
  min-width: 0;
  overflow-wrap: anywhere;

  > :first-child { margin-top: 0; }
  > :last-child { margin-bottom: 0; }
  p, ul, ol, blockquote { margin: 0.65rem 0; }
  h1, h2, h3 { margin: 1rem 0 0.55rem; line-height: 1.3; }
  h1 { font-size: 1.35rem; }
  h2 { font-size: 1.2rem; }
  h3 { font-size: 1.05rem; }
  a { color: var(--color-primary); }
  blockquote {
    padding-left: var(--space-3);
    border-left: 3px solid var(--color-primary-border);
    color: var(--color-text-muted);
  }
  code {
    padding: 0.1em 0.35em;
    border-radius: 0.35rem;
    background: var(--color-surface-muted);
    font-size: 0.9em;
  }
  pre {
    max-width: 100%;
    padding: var(--space-4);
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: 0.8rem;
    background: var(--color-surface-muted);
    color: var(--color-text);
    white-space: pre;
  }
  pre code { padding: 0; background: transparent; color: inherit; }
`;

const StreamingDot = styled.span`
  display: inline-block;
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: var(--color-primary);
  animation: chat-pulse 1s ease-in-out infinite alternate;

  @keyframes chat-pulse {
    from { opacity: 0.35; transform: scale(0.85); }
    to { opacity: 1; transform: scale(1); }
  }
`;

const SecondaryActions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);

  button {
    min-height: 2rem;
    padding: 0.35rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: 0.65rem;
    color: var(--color-text-muted);
    background: var(--color-surface);
    font-size: 0.75rem;
  }
`;

const DetailPanel = styled.details`
  width: min(100%, 46rem);
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 0.9rem;
  background: var(--color-surface);

  > summary {
    display: flex;
    min-height: 2.6rem;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 0.65rem 0.8rem;
    cursor: pointer;
    color: var(--color-text-muted);
    font-size: 0.8125rem;
    list-style: none;
  }

  > summary::-webkit-details-marker { display: none; }
  > summary strong { color: var(--color-text); }
`;

const DetailBody = styled.div`
  display: grid;
  gap: var(--space-3);
  padding: 0 var(--space-3) var(--space-3);
`;

const DetailCard = styled.article`
  min-width: 0;
  padding: var(--space-3);
  overflow-wrap: anywhere;
  border-radius: 0.75rem;
  background: var(--color-background);
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  line-height: 1.55;

  strong { color: var(--color-text); }
  p { margin: 0.4rem 0; }
  small { display: block; color: var(--color-text-subtle); }
  pre {
    max-width: 100%;
    margin: var(--space-2) 0 0;
    overflow: auto;
    white-space: pre-wrap;
  }
`;

const Status = styled.span`
  color: var(--color-primary);
  font-size: 0.75rem;
`;

const MemoryPanel = styled.section`
  display: grid;
  width: min(100%, 46rem);
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-success-border);
  border-radius: 1rem;
  background: var(--color-success-surface);

  h3, p { margin: 0; }
  p { line-height: 1.55; }
`;

const MemoryActions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);

  button {
    min-height: 2.25rem;
    padding: 0.45rem 0.7rem;
    border: 1px solid var(--color-success-border);
    border-radius: 0.7rem;
    color: var(--color-success);
    background: var(--color-surface);
    font-size: 0.8125rem;
    font-weight: 700;
  }
`;

const MemoryForm = styled.form`
  display: grid;
  gap: var(--space-3);

  label { display: grid; gap: var(--space-1); color: var(--color-text-muted); font-size: 0.75rem; }
  input, textarea {
    width: 100%;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--color-success-border);
    border-radius: 0.65rem;
    background: var(--color-surface);
  }
`;

const ErrorText = styled.p`
  margin: 0;
  color: var(--color-danger);
  font-size: 0.75rem;
`;

function statusLabel(status: ChatMessage['status']) {
  if (status === 'streaming') return '正在生成';
  if (status === 'cancelled') return '已停止';
  if (status === 'interrupted') return '生成中断';
  if (status === 'error') return '生成失败';
  return '';
}

function memoryTypeLabel(type: MemoryType) {
  return { profile: '画像', preference: '偏好', fact: '事实', event: '事件', pitfall: '踩坑' }[type];
}

export function MessageCard({
  message,
  memoryBusy = false,
  onStartResearch,
  onReviewMemory,
  onCorrectMemory,
  onReadingStart,
  expandedDetails,
  onDetailsChange
}: MessageCardProps) {
  const [editingMemory, setEditingMemory] = useState(false);
  const candidate = message.memoryCandidate;
  const [memoryDraft, setMemoryDraft] = useState(() => ({
    type: candidate?.type || 'fact' as MemoryType,
    title: candidate?.title || '',
    content: candidate?.content || ''
  }));
  const label = statusLabel(message.status);
  const changeDetails = (key: string, open: boolean) => {
    if (open) onReadingStart?.();
    onDetailsChange(key, open);
  };
  const citationKey = `${message.id}:citations`;
  const detailsToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const open = event.currentTarget.open;
    if (open !== expandedDetails.has(citationKey)) changeDetails(citationKey, open);
  };

  return (
    <Article data-role={message.role} aria-label={message.role === 'user' ? '你的消息' : '助手消息'}>
      <MessageMeta>
        <span>{message.role === 'user' ? '你' : 'Workspace Agent'}</span>
        {message.status === 'streaming' ? <StreamingDot aria-hidden="true" /> : null}
        {label ? <span>{label}</span> : null}
      </MessageMeta>
      <Bubble>
        <Markdown
          content={message.content || (message.status === 'streaming' ? '正在思考…' : '暂无内容')}
        />
      </Bubble>

      {message.role === 'user' && message.content.trim() ? (
        <SecondaryActions>
          <button type="button" onClick={() => onStartResearch?.({
            question: message.content.trim(), sourceMessageId: message.id
          })}>转为深度研究</button>
        </SecondaryActions>
      ) : null}

      <ChatExecutionDetails
        message={message}
        expandedDetails={expandedDetails}
        onDetailsChange={changeDetails}
      />

      {message.citations.length ? (
        <DetailPanel open={expandedDetails.has(citationKey)} onToggle={detailsToggle}>
          <summary><strong>参考来源</strong><span>{message.citations.length} 条命中 · 点击展开</span></summary>
          <DetailBody>
            {message.citations.map((citation) => (
              <DetailCard key={citation.id}>
                <strong>{citation.title}</strong>
                <p>{citation.snippet}</p>
                <small>{citation.source}</small>
              </DetailCard>
            ))}
          </DetailBody>
        </DetailPanel>
      ) : null}

      {candidate ? (
        <MemoryPanel>
          <div>
            <h3>长期记忆候选</h3>
            <Status>{memoryTypeLabel(candidate.type)} · {candidate.status}</Status>
          </div>
          {editingMemory ? (
            <MemoryForm onSubmit={(event) => {
              event.preventDefault();
              if (!memoryDraft.title.trim() || !memoryDraft.content.trim()) return;
              onCorrectMemory?.(message.id, candidate.id, {
                type: memoryDraft.type,
                title: memoryDraft.title.trim(),
                content: memoryDraft.content.trim(),
                status: 'corrected'
              });
              setEditingMemory(false);
            }}>
              <label>类型
                <Select
                  aria-label="候选记忆类型"
                  value={memoryDraft.type}
                  onChange={(value) => setMemoryDraft((draft) => ({
                    ...draft, type: value as MemoryType
                  }))}
                  options={( ['profile', 'preference', 'fact', 'event', 'pitfall'] as MemoryType[])
                    .map((type) => ({ value: type, label: memoryTypeLabel(type) }))}
                />
              </label>
              <label>标题
                <input
                  aria-label="候选记忆标题"
                  value={memoryDraft.title}
                  onChange={(event) => setMemoryDraft((draft) => ({ ...draft, title: event.target.value }))}
                />
              </label>
              <label>内容
                <textarea
                  aria-label="候选记忆内容"
                  value={memoryDraft.content}
                  onChange={(event) => setMemoryDraft((draft) => ({ ...draft, content: event.target.value }))}
                />
              </label>
              <MemoryActions>
                <button type="submit" disabled={memoryBusy}>确认并保存</button>
                <button type="button" onClick={() => setEditingMemory(false)}>取消</button>
              </MemoryActions>
            </MemoryForm>
          ) : (
            <>
              <h3>{candidate.title}</h3>
              <p>{candidate.content}</p>
              <small>置信度 {Math.round(candidate.confidence * 100)}%</small>
              {candidate.status === 'candidate' ? (
                <MemoryActions>
                  <button type="button" disabled={memoryBusy} onClick={() => (
                    onReviewMemory?.(message.id, candidate.id, 'rejected')
                  )}>拒绝</button>
                  <button type="button" disabled={memoryBusy} onClick={() => {
                    setMemoryDraft({ type: candidate.type, title: candidate.title, content: candidate.content });
                    setEditingMemory(true);
                    onReadingStart?.();
                  }}>编辑后确认</button>
                  <button type="button" disabled={memoryBusy} onClick={() => (
                    onReviewMemory?.(message.id, candidate.id, 'confirmed')
                  )}>确认记忆</button>
                </MemoryActions>
              ) : null}
            </>
          )}
        </MemoryPanel>
      ) : null}

      {message.errorMessage ? <ErrorText>{message.errorMessage}</ErrorText> : null}
    </Article>
  );
}
