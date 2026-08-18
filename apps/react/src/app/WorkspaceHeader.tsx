import { NavLink } from 'react-router';
import styled from 'styled-components';
import type { WorkspaceModule } from './navigation';

type WorkspaceHeaderProps = {
  modules: readonly WorkspaceModule[];
  activeModule: WorkspaceModule;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
};

const StyledHeader = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  min-height: 5.25rem;
  gap: var(--space-6);
  padding: 0.875rem clamp(1.25rem, 4vw, 3rem);
  border-bottom: 1px solid var(--color-border);
  background: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(16px);

  @media (max-width: 63.9375rem) {
    min-height: 4.5rem;
    padding: 0.75rem 1.25rem;
    background: rgba(247, 249, 253, 0.94);
  }
`;

const HeaderCopy = styled.div`
  min-width: 0;
`;

const WorkspaceName = styled.p`
  margin: 0;
  color: var(--color-text);
  font-size: 1rem;
  font-weight: 750;
`;

const WorkspaceDescription = styled.p`
  margin: 0.25rem 0 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const DesktopNavigation = styled.nav`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
  gap: var(--space-2);

  @media (max-width: 63.9375rem) {
    display: none;
  }
`;

const NavigationLink = styled(NavLink)`
  display: inline-flex;
  align-items: center;
  min-height: 2.625rem;
  padding: 0.625rem 0.875rem;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  color: var(--color-text-muted);
  font-size: 0.875rem;
  font-weight: 650;
  text-decoration: none;
  transition:
    color 160ms ease,
    border-color 160ms ease,
    background-color 160ms ease;

  &:hover,
  &[aria-current='page'] {
    border-color: var(--color-primary-border);
    color: var(--color-primary);
    background: var(--color-primary-surface);
  }
`;

const MobileMenuButton = styled.button`
  display: none;
  flex: 0 0 2.625rem;
  width: 2.625rem;
  height: 2.625rem;
  padding: 0;
  place-items: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  color: var(--color-text);
  background: var(--color-surface);
  font-size: 1.25rem;

  @media (max-width: 63.9375rem) {
    display: grid;
  }
`;

const MobileHeaderGroup = styled.div`
  display: contents;

  @media (max-width: 63.9375rem) {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: var(--space-3);
  }
`;

const MobileHeaderSpacer = styled.span`
  display: none;
  width: 2.625rem;
  height: 2.625rem;

  @media (max-width: 63.9375rem) {
    display: block;
  }
`;

export function WorkspaceHeader({
  modules,
  activeModule,
  sidebarOpen,
  onOpenSidebar
}: WorkspaceHeaderProps) {
  return (
    <StyledHeader>
      <MobileHeaderGroup>
        <MobileMenuButton
          type="button"
          aria-label="打开工作区侧栏"
          aria-expanded={sidebarOpen}
          onClick={onOpenSidebar}
        >
          <span aria-hidden="true">☰</span>
        </MobileMenuButton>
        <HeaderCopy>
          <WorkspaceName>Matthew&apos;s Workspace · {activeModule.label}</WorkspaceName>
          <WorkspaceDescription>{activeModule.description}</WorkspaceDescription>
        </HeaderCopy>
      </MobileHeaderGroup>

      <DesktopNavigation aria-label="Workspace modules">
        {modules.map((module) => (
          <NavigationLink key={module.path} to={`/${module.path}`}>
            {module.label}
          </NavigationLink>
        ))}
      </DesktopNavigation>

      <MobileHeaderSpacer aria-hidden="true" />
    </StyledHeader>
  );
}
