import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from './providers';
import { workspaceRoutes } from './router';
import { findWorkspaceModule } from './navigation';

function renderRoute(path: string, state?: unknown) {
  const router = createMemoryRouter(workspaceRoutes, {
    initialEntries: [{ pathname: path, state }]
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  const view = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  );
  return { ...view, router };
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
    if (url === '/api/research-new?limit=50&offset=0') {
      return Response.json({ runs: [] });
    }
    if (url === '/api/research-new/capabilities') {
      return Response.json({ capabilities: {
        model: true, webSearch: true,
        webSearchProvider: { name: 'tavily', fullText: true, domainFilter: true, temporalFilter: true },
        webReader: { configured: true, transport: 'tavily_extract' },
        modes: ['web', 'hybrid'], targetedReplan: true
      } });
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
    if (url === '/api/bug-review/reviews' || url === '/api/bug-review/library?q=') {
      return Response.json({ reviews: [] });
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
    expect(screen.queryByText(/Matthew's Workspace ·/)).not.toBeInTheDocument();
  });

  it('routes to Memory without selecting a record implicitly', async () => {
    renderRoute('/memory');

    expect(screen.getByRole('heading', { level: 1, name: 'Memory' })).toBeInTheDocument();
    expect(await screen.findByText('没有符合当前条件的记忆。')).toBeInTheDocument();
    expect(screen.getByText('从左侧选择一条记忆查看详情。')).toBeInTheDocument();
  });

  it('exposes one formal Bug review entry in the desktop navigation', async () => {
    renderRoute('/bug-review');
    expect(await screen.findByRole('heading', { name: '选择案例开始阅读' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Bug 复盘' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Bug 复盘' })).toHaveAttribute('href', '/bug-review');
    expect(screen.queryByRole('link', { name: 'Bug 案例' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Bug 复盘（试用）' })).not.toBeInTheDocument();
  });

  it.each([
    ['/bugs', '/bug-review'],
    ['/bugs/library', '/bug-review/library'],
    ['/bugs/review', '/bug-review/review'],
    ['/bugs/investigations', '/bug-review/review'],
    ['/bugs/review/new', '/bug-review/review'],
    ['/bugs/investigations/new', '/bug-review/review']
  ])('redirects the old Bug entry %s without using the old API', async (path, target) => {
    const { router } = renderRoute(path);
    expect(await screen.findByRole('heading', { name: 'Bug 修复经验沉淀' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(target);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => /\/api\/(bug-projects|bug-cases|bug-investigations)/.test(String(url)))).toBe(false);
  });

  it.each(['/bugs/library/case-1', '/bugs/review/case-1', '/bugs/investigations/investigation-1', '/bugs/legacy/id/history', '/bugs/unknown', '/bugs/unknown/new', '/bugs/library/new'])('keeps old record identity out of the new module at %s', async path => {
    renderRoute(path);
    expect(await screen.findByRole('heading', { name: '旧版 Bug 工作区已退役' })).toBeInTheDocument();
    expect(screen.getByText('旧记录保留在本地，不会自动迁入新的 PR 复盘。')).toBeInTheDocument();
    expect(findWorkspaceModule(path)?.path).toBe('bug-review');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/bug'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '进入 Bug 复盘' }));
    expect(await screen.findByRole('heading', { name: '选择案例开始阅读' })).toBeInTheDocument();
  });

  it('opens the formal Bug review entry from the mobile navigation', async () => {
    renderRoute('/chat');
    fireEvent.click(screen.getByLabelText('打开工作区侧栏'));
    const dialog = screen.getByRole('dialog', { name: '工作区侧栏' });
    // happy-dom does not lay out the mobile media query; verify visibility in the browser.
    fireEvent.click(within(dialog).getByRole('link', { name: /Bug 复盘/, hidden: true }));
    expect(await screen.findByRole('heading', { name: '选择案例开始阅读' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '工作区侧栏' })).not.toBeInTheDocument();
  });

  it('routes to the independent Research New workspace', async () => {
    renderRoute('/research-new');

    expect(screen.getByRole('heading', { level: 1, name: '深度研究' })).toBeInTheDocument();
    expect(await screen.findByText('还没有研究记录')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始研究' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '深度研究' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: '深度研究' })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: '新版深度研究' })).not.toBeInTheDocument();
  });

  it.each(['/research', '/research/new'])('redirects the retired entry %s to the active workspace', async (path) => {
    renderRoute(path);
    expect(await screen.findByRole('heading', { level: 1, name: '深度研究' })).toBeInTheDocument();
  });

  it('does not send an old task id to the new engine', async () => {
    renderRoute('/research/old-task/follow-up');
    expect(await screen.findByRole('heading', { level: 1, name: '旧版深度研究已退役' })).toBeInTheDocument();
    expect(findWorkspaceModule('/research/old-task/follow-up')?.path).toBe('research-new');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/research'))).toBe(false);
  });

  it('prefills a Chat draft without submitting or selecting its knowledge scope', async () => {
    const { router } = renderRoute('/research-new/new', { researchDraftSeed: { question: '请研究这条消息', knowledgeBaseIds: ['kb-default'] } });
    expect(await screen.findByRole('textbox', { name: '研究问题' })).toHaveValue('请研究这条消息');
    expect(screen.getByRole('button', { name: /仅网页/ })).toHaveAttribute('aria-pressed', 'true');
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(router.state.location.state).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新建研究' }));
    expect(screen.getByRole('textbox', { name: '研究问题' })).toHaveValue('');
  });

  it('ignores invalid Chat draft data', async () => {
    renderRoute('/research-new/new', { researchDraftSeed: { question: { content: 'not text' } } });
    expect(await screen.findByRole('textbox', { name: '研究问题' })).toHaveValue('');
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
