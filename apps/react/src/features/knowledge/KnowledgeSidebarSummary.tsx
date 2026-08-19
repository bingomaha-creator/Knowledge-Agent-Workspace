import { NavLink } from 'react-router';
import styled from 'styled-components';
import { useKnowledgeBases } from './knowledgeQueries';

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

export function KnowledgeSidebarSummary({ onNavigate }: { onNavigate?: () => void }) {
  const basesQuery = useKnowledgeBases();
  const bases = basesQuery.data || [];
  const documents = bases.reduce((total, base) => total + base.documentCount, 0);
  const published = bases.reduce((total, base) => total + base.publishedDocumentCount, 0);

  return (
    <SummaryLink to="/knowledge" onClick={onNavigate}>
      <strong>资料库</strong>
      <span>
        {basesQuery.isLoading
          ? '正在加载…'
          : basesQuery.isError
            ? '暂时无法读取摘要'
            : `${bases.length} 个资料库 · ${documents} 个文档 · ${published} 已发布`}
      </span>
    </SummaryLink>
  );
}
