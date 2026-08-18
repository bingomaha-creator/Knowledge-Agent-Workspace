import { useLocation, useNavigate } from 'react-router';
import styled from 'styled-components';
import { selectChatStreamActive, useChatStreamStore } from './chatStreamStore';
import { useChatSessions, useDeleteChatSession } from './useChatSessions';

type ChatSidebarSectionProps = {
  onNavigate?: () => void;
};

const NewConversationButton = styled.button`
  width: 100%;
  min-height: 2.875rem;
  padding: 0.6875rem 0.875rem;
  border: 1px solid var(--color-primary-border);
  border-radius: var(--radius-control);
  color: var(--color-primary);
  background: var(--color-primary-surface);
  font-weight: 750;

  &:disabled { opacity: 0.55; }
`;

const Section = styled.section`
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: var(--space-3);
`;

const SectionHeader = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);

  h2 {
    margin: 0;
    color: var(--color-text);
    font-size: 0.9375rem;
  }

  span {
    color: var(--color-text-subtle);
    font-size: 0.6875rem;
  }
`;

const SessionList = styled.div`
  display: grid;
  gap: var(--space-2);
`;

const SessionRow = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-1);
  border: 1px solid transparent;
  border-radius: 0.9rem;

  &[data-current='true'] {
    border-color: var(--color-primary-border);
    background: var(--color-surface);
  }
`;

const SessionButton = styled.button`
  min-width: 0;
  padding: 0.65rem 0.3rem 0.65rem 0.75rem;
  overflow: hidden;
  border: 0;
  color: var(--color-text-muted);
  background: transparent;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;

  ${SessionRow}[data-current='true'] & {
    color: var(--color-primary);
    font-weight: 700;
  }
`;

const DeleteButton = styled.button`
  align-self: center;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: 0;
  border-radius: 0.7rem;
  color: var(--color-text-subtle);
  background: transparent;

  &:hover:not(:disabled) {
    color: var(--color-danger);
    background: var(--color-danger-surface);
  }
`;

const EmptyHistory = styled.p`
  margin: 0;
  padding: var(--space-4);
  border: 1px dashed var(--color-border);
  border-radius: 1rem;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  line-height: 1.5;
`;

function sessionIdFromPath(pathname: string) {
  const match = pathname.match(/^\/chat\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function ChatSidebarSection({ onNavigate }: ChatSidebarSectionProps) {
  const sessionsQuery = useChatSessions();
  const deleteSession = useDeleteChatSession();
  const isStreamActive = useChatStreamStore(selectChatStreamActive);
  const navigate = useNavigate();
  const currentSessionId = sessionIdFromPath(useLocation().pathname);

  function openSession(sessionId: string) {
    if (isStreamActive && sessionId !== currentSessionId) return;
    navigate(`/chat/${encodeURIComponent(sessionId)}`);
    onNavigate?.();
  }

  async function removeSession(sessionId: string, title: string) {
    if (isStreamActive) return;
    if (!window.confirm(`永久删除会话“${title}”？此操作无法撤销。`)) return;
    await deleteSession.mutateAsync(sessionId);
    if (sessionId === currentSessionId) navigate('/chat');
  }

  return (
    <>
      <NewConversationButton
        type="button"
        disabled={isStreamActive}
        onClick={() => {
          navigate('/chat');
          onNavigate?.();
        }}
      >
        ＋ 发起新对话
      </NewConversationButton>

      <Section aria-labelledby="recent-conversations-title">
        <SectionHeader>
          <h2 id="recent-conversations-title">最近对话</h2>
          <span>{sessionsQuery.data?.length || 0} 个</span>
        </SectionHeader>
        {sessionsQuery.isError ? (
          <EmptyHistory>暂时无法读取历史会话。</EmptyHistory>
        ) : sessionsQuery.isLoading ? (
          <EmptyHistory>正在读取历史会话…</EmptyHistory>
        ) : sessionsQuery.data?.length ? (
          <SessionList>
            {sessionsQuery.data.map((session) => (
              <SessionRow key={session.id} data-current={session.id === currentSessionId}>
                <SessionButton
                  type="button"
                  disabled={isStreamActive && session.id !== currentSessionId}
                  title={session.title}
                  onClick={() => openSession(session.id)}
                >
                  {session.title}
                </SessionButton>
                <DeleteButton
                  type="button"
                  aria-label={`删除会话 ${session.title}`}
                  disabled={isStreamActive || deleteSession.isPending}
                  onClick={() => void removeSession(session.id, session.title)}
                >
                  ×
                </DeleteButton>
              </SessionRow>
            ))}
          </SessionList>
        ) : (
          <EmptyHistory>还没有历史会话。发送第一条消息后，会话会保存到这里。</EmptyHistory>
        )}
      </Section>
    </>
  );
}
