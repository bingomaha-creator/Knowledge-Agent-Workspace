import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { knowledgeQueryKeys } from './knowledgeQueries';
import { KnowledgeWorkspace } from './KnowledgeWorkspace';
import type { KnowledgeDocument } from '@/services/knowledgeApi';

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
    ...props,
    queryClient
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('KnowledgeWorkspace', () => {
  it('shows the catalog error with a working retry button', async () => {
    let catalogCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/knowledge-bases') {
        catalogCalls += 1;
        return Response.json({ error: '目录服务不可用' }, { status: 500 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderWorkspace();

    expect(await screen.findByText('无法加载资料库目录。')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(catalogCalls).toBeGreaterThanOrEqual(2));
  });

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

describe('KnowledgeWorkspace upload', () => {
  const createdDocument = {
    id: 'doc-new', name: 'regression.md', knowledgeBaseId: 'kb-default', status: 'queued',
    publicationStatus: 'draft', publishedAt: null, error: null, createdAt: 3, updatedAt: 4
  };

  function stubUploadFetch(uploadResponse: () => Response) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/knowledge-bases') return Response.json({ knowledgeBases: [defaultBase] });
      if (url === '/api/knowledge?knowledgeBaseId=kb-default') return Response.json({ documents: [] });
      if (url === '/api/knowledge/upload' && init?.method === 'POST') return uploadResponse();
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  /**
   * 复现真实浏览器语义的 FileList 替身：input.files 返回活引用，
   * 且清空 value 会就地清空同一个文件列表（这正是旧实现踩中的行为）。
   */
  function attachLiveFileList(input: HTMLInputElement, files: File[]) {
    const list = Object.assign([...files], {
      item(index: number) { return list[index] ?? null; }
    });
    let value = '';
    Object.defineProperty(input, 'files', { configurable: true, get: () => list });
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => value,
      set: (next: string) => {
        if (next === '') list.length = 0;
        value = next;
      }
    });
    return list;
  }

  function uploadCalls() {
    return vi.mocked(fetch).mock.calls.filter(([request, requestInit]) => (
      String(request) === '/api/knowledge/upload' && requestInit?.method === 'POST'
    ));
  }

  it('sends the selected file even when the browser clears the input value', async () => {
    vi.stubGlobal('fetch', stubUploadFetch(() => Response.json({
      documents: [createdDocument],
      message: '已接收 1 份知识草稿，正在后台处理。'
    })));
    const { queryClient } = renderWorkspace();

    // 等资料库列表加载完成（与真实用户点击时机一致），activeBaseId 才可用；
    // 用唯一的 aria-label 等待，避免撞上多处的同名文本。
    await screen.findByLabelText('选择资料库 默认知识库');
    const input = (await screen.findByLabelText('上传知识文件')) as HTMLInputElement;
    attachLiveFileList(input, [new File(['# 回归'], 'regression.md', { type: 'text/markdown' })]);
    fireEvent.change(input);

    await waitFor(() => expect(uploadCalls()).toHaveLength(1));
    const body = uploadCalls()[0][1]?.body as FormData;
    expect(body.get('knowledgeBaseId')).toBe('kb-default');
    expect(((body.get('files') as File) || { name: '' }).name).toBe('regression.md');

    // 输入框被重置，支持连续上传同名文件
    expect(input.value).toBe('');
    expect(await screen.findByText('文件已上传，后台正在处理。处理完成后可手动发布。')).toBeInTheDocument();
    await waitFor(() => {
      const documents = queryClient.getQueryData<KnowledgeDocument[]>(knowledgeQueryKeys.documents('kb-default'));
      expect(documents?.some((document) => document.id === 'doc-new')).toBe(true);
    });
  });

  it('does not send an upload request when the change event carries no files', async () => {
    vi.stubGlobal('fetch', stubUploadFetch(() => Response.json({ documents: [createdDocument] })));
    renderWorkspace();

    const input = (await screen.findByLabelText('上传知识文件')) as HTMLInputElement;
    attachLiveFileList(input, []);
    fireEvent.change(input);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uploadCalls()).toHaveLength(0);
    expect(screen.queryByText(/文件已上传/)).not.toBeInTheDocument();
  });

  it('shows an error when the upload request fails', async () => {
    vi.stubGlobal('fetch', stubUploadFetch(() => Response.json({ error: '服务器繁忙' }, { status: 500 })));
    renderWorkspace();

    await screen.findByLabelText('选择资料库 默认知识库');
    const input = (await screen.findByLabelText('上传知识文件')) as HTMLInputElement;
    attachLiveFileList(input, [new File(['# 失败'], 'failing.md', { type: 'text/markdown' })]);
    fireEvent.change(input);

    expect(await screen.findByText('服务器繁忙')).toBeInTheDocument();
    expect(uploadCalls()).toHaveLength(1);
  });
});
