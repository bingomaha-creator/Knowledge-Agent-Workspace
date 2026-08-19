import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeWorkspace } from './KnowledgeWorkspace';

const defaultBase = {
  id: 'kb-default', name: '默认知识库', description: '', isDefault: true,
  documentCount: 1, publishedDocumentCount: 0, draftDocumentCount: 1,
  createdAt: 1, updatedAt: 1
};
const projectBase = {
  ...defaultBase, id: 'kb-project', name: '项目资料', isDefault: false,
  documentCount: 0, draftDocumentCount: 0
};
const draftDocument = {
  id: 'doc-1', name: 'guide.md', knowledgeBaseId: 'kb-default', status: 'ready',
  publicationStatus: 'draft', publishedAt: null, error: null, createdAt: 2, updatedAt: 3
};

function renderWorkspace(props: Partial<Parameters<typeof KnowledgeWorkspace>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const defaults = {
    activeBaseId: 'kb-default', documentId: undefined,
    onSelectBase: vi.fn(), onOpenDocument: vi.fn(), onCloseDocument: vi.fn()
  };
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return {
    ...render(<KnowledgeWorkspace {...defaults} {...props} />, { wrapper: Wrapper }),
    ...defaults,
    ...props
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('KnowledgeWorkspace', () => {
  it('renders the catalog and publishes stable navigation intents', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/knowledge-bases') return Response.json({ knowledgeBases: [defaultBase, projectBase] });
      if (url === '/api/knowledge?knowledgeBaseId=kb-default') return Response.json({ documents: [draftDocument] });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const onSelectBase = vi.fn();
    const onOpenDocument = vi.fn();
    renderWorkspace({ onSelectBase, onOpenDocument });

    expect(await screen.findByRole('heading', { name: '资料库管理' })).toBeInTheDocument();
    expect(await screen.findByText('guide.md')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /选择资料库 项目资料/ }));
    expect(onSelectBase).toHaveBeenCalledWith('kb-project');
    await userEvent.click(screen.getByRole('button', { name: '预览 guide.md' }));
    expect(onOpenDocument).toHaveBeenCalledWith('doc-1');
  });

  it('creates a base from the management dialog and selects it', async () => {
    const created = { ...projectBase, id: 'kb-new', name: '新项目' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/knowledge-bases' && init?.method === 'POST') {
        return Response.json({ knowledgeBase: created }, { status: 201 });
      }
      if (url === '/api/knowledge-bases') return Response.json({ knowledgeBases: [defaultBase] });
      if (url === '/api/knowledge?knowledgeBaseId=kb-default') return Response.json({ documents: [] });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const onSelectBase = vi.fn();
    renderWorkspace({ onSelectBase });

    await userEvent.click(await screen.findByRole('button', { name: '新建资料库' }));
    await userEvent.type(screen.getByRole('textbox', { name: '资料库名称' }), '新项目');
    await userEvent.click(screen.getByRole('button', { name: '创建并打开' }));

    await waitFor(() => expect(onSelectBase).toHaveBeenCalledWith('kb-new'));
  });

  it('renders a document preview and publishes a ready draft', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/knowledge-bases') return Response.json({ knowledgeBases: [defaultBase] });
      if (url === '/api/knowledge?knowledgeBaseId=kb-default') return Response.json({ documents: [draftDocument] });
      if (url.includes('/preview')) return Response.json({
        document: draftDocument,
        preview: { excerpt: '# Guide\n可信内容', truncated: false, characterCount: 13, chunkCount: 1, headings: ['Guide'] }
      });
      if (url.includes('/publish') && init?.method === 'POST') return Response.json({
        document: { ...draftDocument, publicationStatus: 'published', publishedAt: 4 }
      });
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderWorkspace({ documentId: 'doc-1' });

    expect(await screen.findByText(/可信内容/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '发布为可检索知识' }));
    expect(await screen.findByText('知识已发布，现在可供 AI 检索。')).toBeInTheDocument();
  });
});
