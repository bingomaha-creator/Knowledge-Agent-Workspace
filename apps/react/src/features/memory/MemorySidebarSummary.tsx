import { NavLink } from 'react-router';
import styled from 'styled-components';
import { useMemoryCounts } from './memoryQueries';

const SummaryLink = styled(NavLink)`
  display: block;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: 1.125rem;
  color: inherit;
  background: var(--color-surface);
  box-shadow: 0 10px 30px rgba(77, 102, 144, 0.06);
  text-decoration: none;
  &:hover { border-color: var(--color-primary-border); }
  strong { display: block; margin-bottom: 0.25rem; color: var(--color-text); font-size: 0.8125rem; }
  span { color: var(--color-text-muted); font-size: 0.8125rem; line-height: 1.5; }
`;

export function MemorySidebarSummary({ onNavigate }: { onNavigate?: () => void }) {
  const counts = useMemoryCounts();
  return (
    <SummaryLink to="/memory" onClick={onNavigate}>
      <strong>记忆中心</strong>
      <span>
        {counts.isLoading
          ? '正在加载…'
          : counts.isError
            ? '暂时无法读取摘要'
            : `${counts.total} 条记忆 · ${counts.candidates} 条待审查`}
      </span>
    </SummaryLink>
  );
}
