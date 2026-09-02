import type { ReactNode } from 'react';
import styled from 'styled-components';

type FeatureHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

const StyledHeader = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  min-width: 0;
  min-height: 4.75rem;
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);

  @media (max-width: 48rem) {
    flex-wrap: wrap;
    padding: var(--space-3) var(--space-4);
  }
`;

const Copy = styled.div`
  min-width: 0;
`;

const Title = styled.h1`
  margin: 0;
  overflow: hidden;
  color: var(--color-text);
  font-size: 1.125rem;
  font-weight: 700;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Description = styled.p`
  margin: 0.25rem 0 0;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  line-height: 1.4;
`;

const HeaderMeta = styled.div`
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--color-text-muted);
  font-size: 0.75rem;
`;

const HeaderActions = styled.div`
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
`;

export function FeatureHeader({ title, description, meta, actions, className }: FeatureHeaderProps) {
  return (
    <StyledHeader className={className}>
      <Copy>
        <Title>{title}</Title>
        {description ? <Description>{description}</Description> : null}
      </Copy>
      {meta ? <HeaderMeta>{meta}</HeaderMeta> : null}
      {actions ? <HeaderActions data-slot="actions">{actions}</HeaderActions> : null}
    </StyledHeader>
  );
}
