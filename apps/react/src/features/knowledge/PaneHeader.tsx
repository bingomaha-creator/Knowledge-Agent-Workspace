import type { ReactNode } from 'react';
import styled from 'styled-components';

type PaneHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** 移动端（≤48rem）替换标题/描述显示的控件，供 Master/Detail 手机端选择器使用。 */
  mobileControls?: ReactNode;
};

const StyledPaneHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 4rem;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border);

  @media (max-width: 48rem) {
    flex-direction: column;
    align-items: stretch;
    padding: var(--space-3);
  }
`;

const PaneCopy = styled.div<{ $swapOnMobile: boolean }>`
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.2rem;

  @media (max-width: 48rem) {
    display: ${({ $swapOnMobile }) => ($swapOnMobile ? 'none' : 'flex')};
  }
`;

const PaneTitle = styled.h2`
  margin: 0;
  overflow: hidden;
  color: var(--color-text);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const PaneDescription = styled.p`
  margin: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const PaneActions = styled.div`
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-2);
`;

const PaneMobileControls = styled.div`
  display: none;
  align-items: center;
  min-width: 0;
  gap: var(--space-2);

  @media (max-width: 48rem) {
    display: flex;
  }
`;

export function PaneHeader({ title, description, actions, mobileControls }: PaneHeaderProps) {
  const swapOnMobile = Boolean(mobileControls);

  return (
    <StyledPaneHeader>
      <PaneCopy $swapOnMobile={swapOnMobile}>
        <PaneTitle>{title}</PaneTitle>
        {description ? <PaneDescription>{description}</PaneDescription> : null}
      </PaneCopy>
      {actions ? <PaneActions>{actions}</PaneActions> : null}
      {mobileControls ? <PaneMobileControls>{mobileControls}</PaneMobileControls> : null}
    </StyledPaneHeader>
  );
}
