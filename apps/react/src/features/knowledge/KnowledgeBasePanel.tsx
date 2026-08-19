import styled from 'styled-components';
import type { KnowledgeBase } from '@/services/knowledgeApi';

const Panel = styled.aside`
  min-height: 0;
  overflow-y: auto;
  border-right: 1px solid var(--color-border);
  background: var(--color-background);

  @media (max-width: 48rem) { display: none; }
`;

const Heading = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--color-border);

  h2 { margin: 0; font-size: 0.875rem; }
`;

const List = styled.div`
  display: grid;
  gap: 0.25rem;
  padding: var(--space-2);
`;

const BaseButton = styled.button<{ $active?: boolean }>`
  width: 100%;
  padding: var(--space-3);
  border: 1px solid ${({ $active }) => $active ? 'var(--color-border-strong)' : 'transparent'};
  border-radius: var(--radius-md);
  color: var(--color-text);
  background: ${({ $active }) => $active ? 'var(--color-surface)' : 'transparent'};
  text-align: left;
  cursor: pointer;

  &:hover { background: var(--color-surface); }
  strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  span { display: block; margin-top: 0.25rem; color: var(--color-text-muted); font-size: 0.75rem; }
`;

export function KnowledgeBasePanel({
  bases,
  activeBaseId,
  onSelectBase
}: {
  bases: KnowledgeBase[];
  activeBaseId?: string;
  onSelectBase: (id: string) => void;
}) {
  return (
    <Panel aria-label="资料库列表">
      <Heading><h2>资料库管理</h2><span>{bases.length}</span></Heading>
      <List>
        {bases.map((base) => (
          <BaseButton
            key={base.id}
            type="button"
            $active={base.id === activeBaseId}
            aria-label={`选择资料库 ${base.name}`}
            aria-pressed={base.id === activeBaseId}
            onClick={() => onSelectBase(base.id)}
          >
            <strong>{base.name}</strong>
            <span>{base.publishedDocumentCount} 已发布 · {base.draftDocumentCount} 草稿</span>
          </BaseButton>
        ))}
      </List>
    </Panel>
  );
}
