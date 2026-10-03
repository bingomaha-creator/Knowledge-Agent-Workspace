import type { ReactNode } from 'react';
import styled from 'styled-components';

type PageHeaderProps = {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
};

const StyledPageHeader = styled.header`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  min-width: 0;
  gap: var(--space-6);

  @media (max-width: 40rem) {
    flex-direction: column;
  }
`;

const HeaderCopy = styled.div`
  min-width: 0;
`;

const Eyebrow = styled.p`
  margin: 0;
  color: var(--color-text-subtle);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.12em;
`;

const Title = styled.h1`
  margin: 0.5rem 0;
  color: var(--color-text);
  font-size: clamp(2rem, 5vw, 3.375rem);
  line-height: 1.05;
  text-wrap: balance;
`;

const Description = styled.p`
  max-width: 70ch;
  margin: 0;
  color: var(--color-text-muted);
  line-height: 1.65;
`;

const Meta = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);

  @media (max-width: 40rem) {
    justify-content: flex-start;
  }
`;

export function PageHeader({ eyebrow, title, description, meta }: PageHeaderProps) {
  return (
    <StyledPageHeader>
      <HeaderCopy>
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <Title>{title}</Title>
        {description ? <Description>{description}</Description> : null}
      </HeaderCopy>
      {meta ? <Meta>{meta}</Meta> : null}
    </StyledPageHeader>
  );
}
