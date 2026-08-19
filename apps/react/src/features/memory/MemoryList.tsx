import styled from 'styled-components';
import type { MemoryRecord } from '@/services/memoryApi';
import { memoryStatusLabel, memoryTypeLabel } from './memoryDisplay';

const ListPane = styled.div`
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  background: var(--color-background);
`;

const List = styled.div`
  min-height: 0;
  flex: 1;
  overflow-y: auto;
`;

const Row = styled.article`
  border-bottom: 1px solid var(--color-border);
`;

const RowButton = styled.button<{ $active: boolean }>`
  display: grid;
  width: 100%;
  gap: var(--space-2);
  padding: var(--space-4);
  border: 0;
  color: var(--color-text);
  background: ${({ $active }) => $active ? 'var(--color-surface)' : 'transparent'};
  text-align: left;
  cursor: pointer;

  &:hover { background: var(--color-surface); }
  strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  p {
    display: -webkit-box;
    margin: 0;
    overflow: hidden;
    color: var(--color-text-muted);
    font-size: 0.75rem;
    line-height: 1.5;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }
`;

const Meta = styled.span`
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-subtle);
  font-size: 0.6875rem;
`;

const Empty = styled.div`
  display: grid;
  min-height: 15rem;
  padding: var(--space-5);
  place-content: center;
  color: var(--color-text-muted);
  text-align: center;

  button {
    margin-top: var(--space-3);
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    background: var(--color-surface);
  }
`;

const Pagination = styled.nav`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-3);
  border-top: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 0.75rem;

  button {
    padding: 0.45rem 0.65rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    background: var(--color-surface);
  }
  button:disabled { opacity: 0.5; }
`;

type Props = {
  memories: MemoryRecord[];
  selectedId?: string;
  loading: boolean;
  error?: string;
  page: number;
  totalPages: number;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onPageChange: (page: number) => void;
};

export function MemoryList({
  memories,
  selectedId,
  loading,
  error,
  page,
  totalPages,
  onSelect,
  onRetry,
  onPageChange
}: Props) {
  return (
    <ListPane>
      <List role="list" aria-label="记忆列表" aria-busy={loading}>
        {error && <Empty><strong>无法加载记忆</strong><span>{error}</span><button type="button" onClick={onRetry}>重试</button></Empty>}
        {!error && !loading && !memories.length && <Empty>没有符合当前条件的记忆。</Empty>}
        {memories.map((memory) => (
          <Row key={memory.id} role="listitem">
            <RowButton
              type="button"
              $active={memory.id === selectedId}
              aria-current={memory.id === selectedId ? 'true' : undefined}
              aria-label={`打开记忆 ${memory.title}`}
              onClick={() => onSelect(memory.id)}
            >
              <Meta>
                <span>{memoryTypeLabel(memory.type)}</span>
                <span>{memoryStatusLabel(memory.status)}</span>
                <span>{Math.round(memory.confidence * 100)}%</span>
              </Meta>
              <strong>{memory.title}</strong>
              <p>{memory.content}</p>
            </RowButton>
          </Row>
        ))}
      </List>
      <Pagination aria-label="记忆分页">
        <button type="button" disabled={page <= 1 || loading} onClick={() => onPageChange(page - 1)}>上一页</button>
        <span>第 {page} / {Math.max(totalPages, 1)} 页</span>
        <button type="button" disabled={page >= totalPages || loading} onClick={() => onPageChange(page + 1)}>下一页</button>
      </Pagination>
    </ListPane>
  );
}
