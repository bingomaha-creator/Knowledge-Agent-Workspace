import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import type { MemoryRecord, MemoryStatus, MemoryType } from '@/services/memoryApi';
import { MasterDetailLayout } from '@/ui/MasterDetailLayout';
import { WorkspaceControlBar } from '@/ui/WorkspaceControlBar';
import { MemoryCreateDialog } from './MemoryCreateDialog';
import { MemoryDetail } from './MemoryDetail';
import { MemoryList } from './MemoryList';
import { matchesMemoryFilters, memoryStatusLabel, memoryStatuses, memoryTypeLabel, memoryTypes } from './memoryDisplay';
import { MEMORY_PAGE_SIZE, type MemoryFilters, useMemoryCounts, useMemoryList } from './memoryQueries';

type Props = {
  filters: MemoryFilters;
  memoryId?: string;
  onFiltersChange: (filters: MemoryFilters) => void;
  onOpenMemory: (id: string) => void;
  onCloseMemory: () => void;
  onCreated: (id: string) => void;
  onOpenSourceConversation: (id: string) => void;
};

const Workspace = styled.section`
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-surface);
`;

const Header = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);
  h1 { margin: 0; font-size: 1.125rem; }
  p { margin: 0.25rem 0 0; color: var(--color-text-muted); font-size: 0.75rem; }
`;

const HeaderActions = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--color-text-muted);
  font-size: 0.75rem;
`;

const Button = styled.button<{ $primary?: boolean }>`
  padding: 0.6rem 0.8rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: ${({ $primary }) => $primary ? 'white' : 'var(--color-text)'};
  background: ${({ $primary }) => $primary ? 'var(--color-primary)' : 'var(--color-surface)'};
`;

const MemoryControlBar = styled(WorkspaceControlBar)<{ $hiddenOnMobile: boolean }>`
  input {
    flex: 1 1 12rem;
  }

  select {
    flex: 0 0 auto;
  }

  @media (max-width: 48rem) {
    display: ${({ $hiddenOnMobile }) => ($hiddenOnMobile ? 'none' : 'flex')};

    input {
      flex-basis: 100%;
    }

    select {
      flex: 1 1 8rem;
    }

    button {
      flex-basis: 100%;
    }
  }
`;

const QuickFilter = styled.button<{ $active: boolean }>`
  min-height: 2.5rem;
  padding: 0.45rem 0.75rem;
  border: 1px solid ${({ $active }) => $active ? 'var(--color-primary-border)' : 'var(--color-border)'};
  border-radius: var(--radius-control);
  color: ${({ $active }) => $active ? 'var(--color-primary)' : 'var(--color-text-muted)'};
  background: ${({ $active }) => $active ? 'var(--color-primary-surface)' : 'var(--color-surface)'};
  font-size: 0.875rem;
`;

const Feedback = styled.p<{ $error?: boolean }>`
  margin: 0;
  padding: var(--space-2) var(--space-5);
  color: ${({ $error }) => $error ? 'var(--color-danger)' : 'var(--color-text)'};
  background: ${({ $error }) => $error ? 'var(--color-danger-surface)' : 'var(--color-background)'};
  font-size: 0.75rem;
`;

export function MemoryWorkspace({
  filters,
  memoryId,
  onFiltersChange,
  onOpenMemory,
  onCloseMemory,
  onCreated,
  onOpenSourceConversation
}: Props) {
  const list = useMemoryList(filters);
  const counts = useMemoryCounts();
  const [queryDraft, setQueryDraft] = useState(filters.query);
  const [createOpen, setCreateOpen] = useState(false);
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const filtersRef = useRef(filters);
  const onFiltersChangeRef = useRef(onFiltersChange);
  const totalPages = Math.max(1, Math.ceil((list.data?.total || 0) / MEMORY_PAGE_SIZE));

  useEffect(() => setQueryDraft(filters.query), [filters.query]);

  useEffect(() => {
    filtersRef.current = filters;
    onFiltersChangeRef.current = onFiltersChange;
  }, [filters, onFiltersChange]);

  useEffect(() => {
    if (queryDraft.trim() === filters.query) return;
    const timer = window.setTimeout(() => {
      onFiltersChangeRef.current({
        ...filtersRef.current,
        query: queryDraft.trim().slice(0, 500),
        page: 1
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [filters.query, queryDraft]);

  useEffect(() => {
    if (list.isSuccess && !list.isFetching && filters.page > totalPages) {
      onFiltersChangeRef.current({ ...filtersRef.current, page: totalPages });
    }
  }, [filters.page, list.isFetching, list.isSuccess, totalPages]);

  useEffect(() => {
    if (!memoryId || !list.isSuccess || list.isFetching) return;
    if (!list.data.memories.some((memory) => memory.id === memoryId)) onCloseMemory();
  }, [list.data, list.isFetching, list.isSuccess, memoryId, onCloseMemory]);

  function changeFilter(patch: Partial<MemoryFilters>) {
    onFiltersChange({ ...filters, ...patch, page: patch.page || 1 });
  }

  function changed(memory: MemoryRecord) {
    if (!matchesMemoryFilters(memory, filters)) onCloseMemory();
  }

  function openCreate() {
    setReturnFocus(document.activeElement instanceof HTMLElement ? document.activeElement : createButtonRef.current);
    setCreateOpen(true);
  }

  return (
    <Workspace>
      <Header>
        <div><h1>Memory</h1><p>创建、审查并纠正可由 Workspace 长期召回的记忆。</p></div>
        <HeaderActions>
          <span>{counts.total} 条 · {counts.candidates} 条待审查</span>
          <Button ref={createButtonRef} $primary onClick={openCreate}>新建记忆</Button>
        </HeaderActions>
      </Header>
      {notice && <Feedback>{notice}</Feedback>}
      {error && <Feedback $error>{error}</Feedback>}
      <MemoryControlBar $hiddenOnMobile={Boolean(memoryId)}>
        <input aria-label="搜索记忆" value={queryDraft} placeholder="搜索标题、内容或来源" onChange={(event) => setQueryDraft(event.target.value)} />
        <select aria-label="记忆状态筛选" value={filters.status || ''} onChange={(event) => changeFilter({ status: (event.target.value || undefined) as MemoryStatus | undefined })}>
          <option value="">全部状态</option>{memoryStatuses.map((status) => <option key={status} value={status}>{memoryStatusLabel(status)}</option>)}
        </select>
        <select aria-label="记忆类型筛选" value={filters.type || ''} onChange={(event) => changeFilter({ type: (event.target.value || undefined) as MemoryType | undefined })}>
          <option value="">全部类型</option>{memoryTypes.map((type) => <option key={type} value={type}>{memoryTypeLabel(type)}</option>)}
        </select>
        <QuickFilter $active={filters.status === 'candidate'} onClick={() => changeFilter({ status: filters.status === 'candidate' ? undefined : 'candidate' })}>
          待审查 {counts.candidates}
        </QuickFilter>
      </MemoryControlBar>
      <MasterDetailLayout
        master={<MemoryList
          memories={list.data?.memories || []}
          selectedId={memoryId}
          loading={list.isLoading || list.isFetching}
          error={list.isError ? (list.error instanceof Error ? list.error.message : '加载长期记忆失败') : undefined}
          page={filters.page}
          totalPages={totalPages}
          onSelect={onOpenMemory}
          onRetry={() => void list.refetch()}
          onPageChange={(page) => changeFilter({ page })}
        />}
        detail={<MemoryDetail
          memoryId={memoryId}
          onClose={onCloseMemory}
          onChanged={changed}
          onDeleted={onCloseMemory}
          onOpenSource={onOpenSourceConversation}
          onNotice={(message) => { setError(''); setNotice(message); }}
          onError={(message) => { setNotice(''); setError(message); }}
        />}
        masterWidth="22rem"
        mobilePane={memoryId ? 'detail' : 'master'}
        masterLabel="记忆列表"
        detailLabel="记忆详情"
      />
      <MemoryCreateDialog
        open={createOpen}
        returnFocus={returnFocus}
        onClose={() => setCreateOpen(false)}
        onCreated={(memory) => { setCreateOpen(false); setNotice('记忆已创建并确认。'); onCreated(memory.id); }}
      />
    </Workspace>
  );
}
