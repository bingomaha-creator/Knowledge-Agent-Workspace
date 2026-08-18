import { useEffect } from 'react';
import { NavLink } from 'react-router';
import styled from 'styled-components';
import { ChatSidebarSection } from '@/features/chat/ChatSidebarSection';
import type { WorkspaceModule } from './navigation';

type WorkspaceSidebarProps = {
  modules: readonly WorkspaceModule[];
  open: boolean;
  onClose: () => void;
};

const Backdrop = styled.button`
  display: none;

  @media (max-width: 63.9375rem) {
    position: fixed;
    z-index: 30;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    visibility: hidden;
    opacity: 0;
    background: rgba(24, 35, 54, 0.44);
    transition:
      opacity 180ms ease,
      visibility 180ms ease;

    &[data-open='true'] {
      visibility: visible;
      opacity: 1;
    }
  }
`;

const StyledSidebar = styled.aside`
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-6);
  overflow-y: auto;
  border-right: 1px solid var(--color-border);
  background: var(--color-sidebar);

  @media (max-width: 63.9375rem) {
    position: fixed;
    z-index: 31;
    inset: 0 auto 0 0;
    width: min(88vw, 22rem);
    height: 100dvh;
    padding: var(--space-5);
    visibility: hidden;
    transform: translateX(-102%);
    box-shadow: var(--shadow-drawer);
    transition:
      transform 180ms ease,
      visibility 180ms ease;

    &[data-open='true'] {
      visibility: visible;
      transform: translateX(0);
    }
  }
`;

const SidebarHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
`;

const Branding = styled.div`
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--space-3);
`;

const BrandMark = styled.span`
  display: grid;
  flex: 0 0 3rem;
  width: 3rem;
  height: 3rem;
  place-items: center;
  border-radius: 1rem;
  color: var(--color-primary);
  background: linear-gradient(145deg, #d9e8ff, #ffffff);
  box-shadow: 0 8px 24px rgba(69, 111, 180, 0.14);
  font-size: 1.5rem;
`;

const Eyebrow = styled.p`
  margin: 0;
  color: var(--color-text-subtle);
  font-size: 0.6875rem;
  font-weight: 750;
  letter-spacing: 0.11em;
  text-transform: uppercase;
`;

const BrandTitle = styled.h1`
  margin: 0.25rem 0;
  color: var(--color-text);
  font-size: 1.125rem;
  line-height: 1.15;
`;

const MutedText = styled.p`
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  line-height: 1.5;
`;

const CloseButton = styled.button`
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
  font-size: 1.5rem;
  line-height: 1;

  @media (max-width: 63.9375rem) {
    display: grid;
  }
`;

const MobileNavigation = styled.nav`
  display: none;
  gap: var(--space-2);

  @media (max-width: 63.9375rem) {
    display: grid;
  }
`;

const NavigationLink = styled(NavLink)`
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 2.75rem;
  gap: var(--space-3);
  padding: 0.625rem 0.75rem;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  color: var(--color-text-muted);
  text-decoration: none;

  small {
    color: var(--color-text-subtle);
    font-size: 0.625rem;
    letter-spacing: 0.08em;
  }

  &:hover,
  &[aria-current='page'] {
    border-color: var(--color-primary-border);
    color: var(--color-primary);
    background: var(--color-surface);
  }
`;

const SidebarSection = styled.section`
  display: grid;
  gap: var(--space-3);
`;

const SectionHeader = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);

  h2 {
    margin: 0;
    color: var(--color-text);
    font-size: 0.9375rem;
  }

  span {
    color: var(--color-text-subtle);
    font-size: 0.6875rem;
  }
`;

const SidebarCard = styled.div`
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: 1.125rem;
  background: var(--color-surface);
  box-shadow: 0 10px 30px rgba(77, 102, 144, 0.06);

  strong {
    display: block;
    margin-bottom: 0.25rem;
    color: var(--color-text);
    font-size: 0.8125rem;
  }
`;

const SidebarFooter = styled.div`
  margin-top: auto;
  padding-top: var(--space-2);
`;

const FooterButton = styled.button`
  width: 100%;
  min-height: 2.75rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  color: var(--color-text-muted);
  background: transparent;
  text-align: left;

  &:hover {
    border-color: var(--color-border);
    background: rgba(255, 255, 255, 0.6);
  }
`;

export function WorkspaceSidebar({ modules, open, onClose }: WorkspaceSidebarProps) {
  useEffect(() => {
    if (!open) return undefined;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, open]);

  return (
    <>
      <Backdrop
        type="button"
        data-open={open}
        aria-label="关闭工作区侧栏"
        onClick={onClose}
      />
      <StyledSidebar
        data-open={open}
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
        aria-label="工作区侧栏"
      >
        <SidebarHeader>
          <Branding>
            <BrandMark aria-hidden="true">✦</BrandMark>
            <div>
              <Eyebrow>Matthew&apos;s AI workspace</Eyebrow>
              <BrandTitle>Matthew&apos;s Workspace</BrandTitle>
              <MutedText>你的 AI 知识协作台</MutedText>
            </div>
          </Branding>
          <CloseButton type="button" aria-label="关闭工作区侧栏" onClick={onClose}>
            ×
          </CloseButton>
        </SidebarHeader>

        <MobileNavigation aria-label="Mobile workspace modules">
          {modules.map((module) => (
            <NavigationLink key={module.path} to={`/${module.path}`} onClick={onClose}>
              <span>{module.label}</span>
              <small>{module.eyebrow}</small>
            </NavigationLink>
          ))}
        </MobileNavigation>

        <ChatSidebarSection onNavigate={onClose} />

        <SidebarSection aria-labelledby="workspace-summary-title">
          <SectionHeader>
            <h2 id="workspace-summary-title">Workspace 摘要</h2>
            <span>Overview</span>
          </SectionHeader>
          <SidebarCard>
            <strong>资料库</strong>
            <MutedText>模块待迁移</MutedText>
          </SidebarCard>
          <SidebarCard>
            <strong>记忆中心</strong>
            <MutedText>模块待迁移</MutedText>
          </SidebarCard>
        </SidebarSection>

        <SidebarFooter>
          <FooterButton type="button">设置和帮助</FooterButton>
        </SidebarFooter>
      </StyledSidebar>
    </>
  );
}
