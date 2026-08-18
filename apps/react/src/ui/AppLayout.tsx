import type { ReactNode } from 'react';
import styled from 'styled-components';

type AppLayoutProps = {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
};

const StyledAppLayout = styled.div`
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  width: 100%;
  height: 100dvh;
  overflow: hidden;
  background: var(--color-background);

  @media (max-width: 63.9375rem) {
    display: block;
    min-height: 100dvh;
    height: auto;
    overflow: visible;
  }
`;

const SidebarRegion = styled.div`
  grid-row: 1 / -1;
  min-width: 0;
  min-height: 0;

  @media (max-width: 63.9375rem) {
    display: contents;
  }
`;

const HeaderRegion = styled.div`
  grid-column: 2;
  min-width: 0;

  @media (max-width: 63.9375rem) {
    position: sticky;
    z-index: 20;
    top: 0;
  }
`;

const Main = styled.main`
  grid-column: 2;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: clamp(2rem, 4vw, 4rem) clamp(1.25rem, 5vw, 6rem);

  @media (max-width: 63.9375rem) {
    min-height: calc(100dvh - 4.5rem);
    overflow: visible;
  }

  @media (max-width: 40rem) {
    padding: 1.5rem 1rem 2rem;
  }
`;

const MainContent = styled.div`
  display: grid;
  width: min(100%, var(--content-max));
  min-height: 100%;
  min-width: 0;
  gap: var(--space-7);
  margin: 0 auto;
`;

export function AppLayout({ sidebar, header, children }: AppLayoutProps) {
  return (
    <StyledAppLayout>
      <SidebarRegion>{sidebar}</SidebarRegion>
      <HeaderRegion>{header}</HeaderRegion>
      <Main>
        <MainContent>{children}</MainContent>
      </Main>
    </StyledAppLayout>
  );
}
