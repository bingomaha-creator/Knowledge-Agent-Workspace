import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppProviders } from './providers';
import { workspaceRoutes } from './router';

function renderRoute(path: string) {
  const router = createMemoryRouter(workspaceRoutes, {
    initialEntries: [path]
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  return render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  );
}

describe('React workspace shell', () => {
  it('redirects the workspace root to the Chat page', async () => {
    renderRoute('/');

    expect(await screen.findByRole('heading', { level: 1, name: '对话' })).toBeInTheDocument();
    expect(screen.getByText('历史会话将在这里恢复')).toBeInTheDocument();
  });

  it('routes to an explicit Page through the shared workspace layout', () => {
    renderRoute('/knowledge');

    expect(screen.getByRole('heading', { level: 1, name: '资料库' })).toBeInTheDocument();
    expect(screen.getByText('Knowledge 模块等待迁移')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Workspace modules' })).toBeInTheDocument();
  });

  it('opens and closes the mobile workspace sidebar', () => {
    renderRoute('/chat');

    fireEvent.click(screen.getByLabelText('打开工作区侧栏'));
    expect(screen.getByRole('dialog', { name: '工作区侧栏' })).toBeInTheDocument();
    expect(document.body).toHaveStyle({ overflow: 'hidden' });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '工作区侧栏' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveStyle({ overflow: 'hidden' });
  });
});
