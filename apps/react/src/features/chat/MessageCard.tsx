import styled from 'styled-components';
import type { ChatMessage } from './chat.types';

type MessageCardProps = {
  message: ChatMessage;
};

const Article = styled.article`
  display: grid;
  width: min(100%, 52rem);
  min-width: 0;
  gap: var(--space-2);
  margin: 0 auto;
  padding: var(--space-3) var(--space-5);

  &[data-role='user'] {
    justify-items: end;
  }
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
  white-space: pre-wrap;

  ${Article}[data-role='user'] & {
    border-color: var(--color-primary-border);
    border-bottom-right-radius: 0.35rem;
    background: var(--color-primary-surface);
  }

  ${Article}[data-role='assistant'] & {
    border-bottom-left-radius: 0.35rem;
  }
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

export function MessageCard({ message }: MessageCardProps) {
  const label = statusLabel(message.status);
  return (
    <Article data-role={message.role} aria-label={message.role === 'user' ? '你的消息' : '助手消息'}>
      <MessageMeta>
        <span>{message.role === 'user' ? '你' : 'Workspace Agent'}</span>
        {message.status === 'streaming' ? <StreamingDot aria-hidden="true" /> : null}
        {label ? <span>{label}</span> : null}
      </MessageMeta>
      <Bubble>{message.content || (message.status === 'streaming' ? '正在思考…' : '暂无内容')}</Bubble>
      {message.errorMessage ? <ErrorText>{message.errorMessage}</ErrorText> : null}
    </Article>
  );
}
