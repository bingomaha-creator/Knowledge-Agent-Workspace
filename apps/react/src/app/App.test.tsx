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
    if (url === '/api/knowledge-bases') {
      return new Response(JSON.stringify({ knowledgeBases: [{
        id: 'kb-default', name: '默认知识库', isDefault: true,
        documentCount: 0, publishedDocumentCount: 0, draftDocumentCount: 0,
        createdAt: 1, updatedAt: 1
      }] }), { status: 200 });
    }
    if (url === '/api/knowledge?knowledgeBaseId=kb-default') {
      return new Response(JSON.stringify({ documents: [] }), { status: 200 });
    }
    if (url === '/api/memories?limit=50&offset=0' || url === '/api/memories?limit=1&offset=0') {
      return new Response(JSON.stringify({ memories: [], total: 0 }), { status: 200 });
    }
    if (url === '/api/memories?status=candidate&limit=1&offset=0') {
      return new Response(JSON.stringify({ memories: [], total: 0 }), { status: 200 });
    }
    if (url === '/api/bug-projects') {
      return Response.json({ projects: [{
        projectRef: 'project-a', knowledgeBaseId: 'kb-a', name: '结算系统', description: '',
        kind: 'project_bugs', bugCaseCount: 0, createdAt: 1, updatedAt: 1
      }] });
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

  it('routes to Knowledge through the shared workspace layout', async () => {
    renderRoute('/knowledge');

    expect(screen.getByRole('heading', { level: 1, name: 'Knowledge' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: '默认知识库' })).toBeInTheDocument();
    expect(await screen.findByText('这个资料库还是空的')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Workspace modules' })).toBeInTheDocument();
  });

  it('routes to Memory without selecting a record implicitly', async () => {
    renderRoute('/memory');

    expect(screen.getByRole('heading', { level: 1, name: 'Memory' })).toBeInTheDocument();
    expect(await screen.findByText('没有符合当前条件的记忆。')).toBeInTheDocument();
    expect(screen.getByText('从左侧选择一条记忆查看详情。')).toBeInTheDocument();
  });

  it('restores a deep Bug Agent work area from the URL', async () => {
    renderRoute('/bugs/library/case-1?project=project-a');

    expect(await screen.findByRole('heading', { level: 1, name: 'Bug Agent' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '案例库' })).toHaveAttribute('aria-selected', 'true');
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
