import type { ReactNode } from 'react';
import styled from 'styled-components';

type EmptyProps = {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
};

const StyledEmpty = styled.div`
  display: flex;
  align-items: flex-start;
  min-width: 0;
  gap: var(--space-4);
`;

const EmptyIcon = styled.span`
  display: grid;
  flex: 0 0 2.625rem;
  width: 2.625rem;
  height: 2.625rem;
  place-items: center;
  border-radius: var(--radius-control);
  color: var(--color-primary);
  background: var(--color-surface-muted);
  font-size: 1.25rem;
`;

const EmptyTitle = styled.h2`
  margin: 0 0 0.375rem;
  color: var(--color-text);
  font-size: 1.1875rem;
`;

const EmptyDescription = styled.p`
  max-width: 70ch;
  margin: 0;
  color: var(--color-text-muted);
  line-height: 1.65;
`;

const EmptyAction = styled.div`
  margin-top: var(--space-4);
`;

export function Empty({ title, description, icon, action }: EmptyProps) {
  return (
    <StyledEmpty>
      {icon ? <EmptyIcon aria-hidden="true">{icon}</EmptyIcon> : null}
      <div>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
        {action ? <EmptyAction>{action}</EmptyAction> : null}
      </div>
    </StyledEmpty>
  );
}
