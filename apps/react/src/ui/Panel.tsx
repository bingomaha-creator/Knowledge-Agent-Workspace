import type { ReactNode } from 'react';
import styled from 'styled-components';

type PanelProps = {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
};

const StyledPanel = styled.section`
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--color-surface);
  box-shadow: var(--shadow-soft);
`;

const PanelHeader = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-6) 0;
`;

const PanelTitle = styled.h2`
  margin: 0;
  color: var(--color-text);
  font-size: 1.125rem;
`;

const PanelActions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
`;

const PanelBody = styled.div`
  min-width: 0;
  padding: var(--space-6);

  @media (max-width: 40rem) {
    padding: var(--space-5);
  }
`;

export function Panel({ title, actions, children, className }: PanelProps) {
  return (
    <StyledPanel className={className}>
      {title || actions ? (
        <PanelHeader>
          {title ? <PanelTitle>{title}</PanelTitle> : <span />}
          {actions ? <PanelActions>{actions}</PanelActions> : null}
        </PanelHeader>
      ) : null}
      <PanelBody>{children}</PanelBody>
    </StyledPanel>
  );
}
