import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/chat/sessions') {
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    }
    if (url === '/api/presets') {
      return new Response(JSON.stringify({ presets: [] }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('React workspace shell', () => {
  it('redirects the workspace root to the Chat page', async () => {
    renderRoute('/');

    expect(await screen.findByRole('heading', { level: 1, name: '新对话' })).toBeInTheDocument();
    expect(await screen.findByText('还没有历史会话。发送第一条消息后，会话会保存到这里。'))
      .toBeInTheDocument();
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
