import { type RefObject } from 'react';
import styled from 'styled-components';
import { PaneHeader } from '@/ui/PaneHeader';
import type { ResearchSessionGroup } from './researchPresentation';
import {
  formatResearchTime,
  researchQualityLabel,
  researchSearchModeLabel,
  researchStatusLabel
} from './researchPresentation';
import type { ResearchStatusFilter } from './researchViewState';

type ResearchSessionPanelProps = {
  sessions: ResearchSessionGroup[];
  statusFilter: ResearchStatusFilter;
  onStatusFilterChange: (filter: ResearchStatusFilter) => void;
  activeTaskId?: string;
  expandedSessionId?: string;
  onToggleSession: (sessionId: string) => void;
  onSelectTask: (taskId: string) => void;
  loading: boolean;
  totalCount: number;
  activeCount: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** 列表请求失败且没有任何数据；与筛选为空、数据库为空是三种不同状态。 */
  error?: string | null;
  onRetry: () => void;
};

const Panel = styled.div`
  display: flex;
  min-height: 0;
  flex-direction: column;
  background: var(--color-background);
`;

const FilterRow = styled.div`
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--color-border);

  select {
    width: 100%;
    min-height: 2.25rem;
    padding: 0.35rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    color: var(--color-text);
    background: var(--color-surface);
    font-size: 0.8125rem;
  }
`;

const SessionList = styled.div`
  display: grid;
  flex: 1;
  align-content: start;
  gap: var(--space-2);
  min-height: 0;
  padding: var(--space-3);
  overflow-y: auto;
`;

const SessionCard = styled.div<{ $selected?: boolean }>`
  display: grid;
  gap: var(--space-1);
  padding: var(--space-2);
  border: 1px solid ${({ $selected }) => ($selected ? 'var(--color-primary-border)' : 'transparent')};
  border-radius: var(--radius-control);
  background: ${({ $selected }) => ($selected ? 'var(--color-primary-surface)' : 'transparent')};

  &:hover { background: var(--color-primary-surface); }
`;

const SessionHeader = styled.button`
  display: grid;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-2);
  border: 0;
  color: var(--color-text);
  background: transparent;
  text-align: left;
  cursor: pointer;

  .session-topline { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
  .session-topic { min-width: 0; overflow-wrap: anywhere; font-weight: 650; text-align: left; }
  .session-status { flex: 0 0 auto; padding: 0.15rem 0.45rem; border-radius: 999px; color: var(--color-text-muted); background: var(--color-surface-muted); font-size: 0.68rem; font-weight: 700; }
  .session-status[data-status='running'], .session-status[data-status='queued'] { color: var(--color-primary); background: var(--color-primary-surface); }
  .session-status[data-status='completed'] { color: var(--color-success); background: var(--color-success-surface); }
  .session-status[data-status='failed'] { color: var(--color-danger); background: var(--color-danger-surface); }
  .session-meta { color: var(--color-text-muted); font-size: 0.72rem; }
`;

const RunList = styled.div`
  display: grid;
  gap: var(--space-1);
  padding: 0 var(--space-2) var(--space-2);
`;

const RunButton = styled.button`
  display: grid;
  gap: 0.15rem;
  width: 100%;
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  color: var(--color-text);
  background: var(--color-surface);
  text-align: left;
  cursor: pointer;

  &[aria-current='true'] { border-color: var(--color-primary-border); background: var(--color-primary-surface); }
  .run-question { min-width: 0; overflow: hidden; font-size: 0.8125rem; text-overflow: ellipsis; white-space: nowrap; }
  .run-meta { color: var(--color-text-muted); font-size: 0.7rem; }
`;

const EmptyState = styled.p`
  margin: 0;
  padding: var(--space-6) var(--space-4);
  color: var(--color-text-muted);
  text-align: center;
  font-size: 0.8125rem;
`;

const ErrorState = styled.div`
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  margin: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-danger-border);
  border-radius: var(--radius-control);
  background: var(--color-danger-surface);
  color: var(--color-danger);
  text-align: center;
  font-size: 0.8125rem;

  p { margin: 0; overflow-wrap: anywhere; }
  button {
    padding: 0.4rem 0.7rem;
    border: 1px solid var(--color-danger-border);
    border-radius: var(--radius-control);
    color: var(--color-danger);
    background: var(--color-surface);
    font-size: 0.78rem;
    cursor: pointer;
  }
`;

const StaleNotice = styled.p`
  margin: 0;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-muted);
  background: var(--color-background);
  font-size: 0.72rem;
`;

export function ResearchSessionPanel({
  sessions,
  statusFilter,
  onStatusFilterChange,
  activeTaskId,
  expandedSessionId,
  onToggleSession,
  onSelectTask,
  loading,
  totalCount,
  activeCount,
  scrollRef,
  error,
  onRetry
}: ResearchSessionPanelProps) {
  return (
    <Panel>
      <PaneHeader
        title="研究记录"
        description={loading ? '正在同步研究记录…' : `${sessions.length} 个会话 · ${activeCount} 轮进行中`}
      />
      <FilterRow>
        <select
          aria-label="研究状态筛选"
          value={statusFilter}
          onChange={(event) => onStatusFilterChange(event.target.value as ResearchStatusFilter)}
        >
          <option value="all">全部状态</option>
          <option value="active">进行中</option>
          <option value="completed">已完成</option>
          <option value="failed">失败</option>
          <option value="cancelled">已取消</option>
        </select>
      </FilterRow>
      {error && totalCount > 0 ? (
        <StaleNotice>研究记录同步失败，正在显示上一次成功结果。</StaleNotice>
      ) : null}
      <SessionList ref={scrollRef}>
        {error && !totalCount ? (
          <ErrorState>
            <p>加载研究记录失败：{error}</p>
            <button type="button" onClick={onRetry}>重试</button>
          </ErrorState>
        ) : (
          <>
            {loading && !totalCount ? <EmptyState>正在加载研究记录…</EmptyState> : null}
            {!loading && !error && !totalCount ? <EmptyState>还没有研究任务，从一个问题开始。</EmptyState> : null}
            {!loading && !error && totalCount > 0 && !sessions.length ? (
              <EmptyState>没有符合当前筛选的研究。</EmptyState>
            ) : null}
          </>
        )}
        {sessions.map((session) => {
          const expanded = expandedSessionId === session.id;
          const selected = session.runs.some((run) => run.id === activeTaskId);
          return (
            <SessionCard key={session.id} $selected={selected}>
              <SessionHeader
                type="button"
                aria-expanded={expanded}
                onClick={() => onToggleSession(session.id)}
              >
                <span className="session-topline">
                  <span className="session-topic">{session.root.question}</span>
                  <span className="session-status" data-status={session.latest.status}>
                    {researchStatusLabel(session.latest.status)}
                  </span>
                </span>
                <span className="session-meta">
                  {session.runs.length} 轮研究 · {researchSearchModeLabel(session.latest.searchMode)} · {formatResearchTime(session.latest.updatedAt)}
                  {session.latest.status === 'completed' ? ` · ${researchQualityLabel(session.latest.resultQuality)}` : ''}
                </span>
              </SessionHeader>
              {expanded ? (
                <RunList>
                  {session.runs.map((run) => (
                    <RunButton
                      key={run.id}
                      type="button"
                      aria-current={run.id === activeTaskId}
                      onClick={() => onSelectTask(run.id)}
                    >
                      <span className="run-question">{run.question}</span>
                      <span className="run-meta">
                        第 {run.turnIndex} 轮 · {researchStatusLabel(run.status)}
                      </span>
                    </RunButton>
                  ))}
                </RunList>
              ) : null}
            </SessionCard>
          );
        })}
      </SessionList>
    </Panel>
  );
}
