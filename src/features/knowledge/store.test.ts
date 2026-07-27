// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKnowledgeStore } from './store';
import type { KnowledgeApi, KnowledgeBase, KnowledgeDocument } from './types';

const defaultBase: KnowledgeBase = {
  id: 'kb-default',
  name: '默认知识库',
  description: '',
  isDefault: true,
  documentCount: 1,
  publishedDocumentCount: 1,
  draftDocumentCount: 0,
  createdAt: 1,
  updatedAt: 1
};

const readyDocument: KnowledgeDocument = {
  id: 'doc-1',
  name: 'guide.md',
  knowledgeBaseId: 'kb-default',
  status: 'ready',
  publicationStatus: 'published',
  publishedAt: 3,
  error: null,
  createdAt: 2,
  updatedAt: 3
};

const projectBase: KnowledgeBase = {
  id: 'kb-project',
  name: '项目资料',
  description: '',
  isDefault: false,
  documentCount: 0,
  publishedDocumentCount: 0,
  draftDocumentCount: 0,
  createdAt: 4,
  updatedAt: 4
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function api(overrides: Partial<KnowledgeApi> = {}): KnowledgeApi {
  return {
    listBases: vi.fn(async () => [defaultBase]),
    createBase: vi.fn(async () => defaultBase),
    updateBase: vi.fn(async () => defaultBase),
    deleteBase: vi.fn(async () => undefined),
    listDocuments: vi.fn(async () => [readyDocument]),
    uploadDocuments: vi.fn(async () => [readyDocument]),
    getDocumentPreview: vi.fn(async () => ({
      document: readyDocument,
      preview: {
        excerpt: '# Guide',
        truncated: false,
        characterCount: 7,
        chunkCount: 1,
        headings: ['Guide']
      }
    })),
    publishDocument: vi.fn(async () => readyDocument),
    withdrawDocument: vi.fn(async () => ({
      ...readyDocument,
      publicationStatus: 'draft' as const,
      publishedAt: null
    })),
    deleteDocument: vi.fn(async () => undefined),
    clearDocuments: vi.fn(async () => undefined),
    ...overrides
  };
}

describe('Knowledge store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.useRealTimers();
  });

  it('initializes an authoritative catalog and the active base document snapshot', async () => {
    localStorage.setItem('yuan-agent-active-knowledge-base-v1', 'kb-missing');
    const store = createKnowledgeStore(api(), {
      storeId: 'knowledge-initialize'
    })();

    expect(await store.initialize()).toBe(true);
    expect(store.knowledgeBases).toEqual([defaultBase]);
    expect(store.activeKnowledgeBaseId).toBe('kb-default');
    expect(store.activeBase).toEqual(defaultBase);
    expect(store.documents).toEqual([readyDocument]);
    expect(store.initialized).toBe(true);
    expect(store.errorMessage).toBe('');
    expect(localStorage.getItem('matthews-workspace-active-knowledge-base-v1'))
      .toBe('kb-default');
    expect(localStorage.getItem('yuan-agent-active-knowledge-base-v1')).toBeNull();
  });

  it('returns an authoritative created base for Workspace composition', async () => {
    const transport = api({
      createBase: vi.fn(async () => projectBase)
    });
    const store = createKnowledgeStore(transport, {
      storeId: 'knowledge-create'
    })();
    await store.initialize();

    expect(await store.createBase(' 项目资料 ')).toEqual(projectBase);
    expect(store.knowledgeBases).toEqual([defaultBase, projectBase]);
    expect(store.activeKnowledgeBaseId).toBe('kb-project');
    expect(store.documents).toEqual([]);
    expect(store.noticeMessage).toBe('已创建资料库“项目资料”。');
  });

  it('selects an existing management base without changing any Chat retrieval scope', async () => {
    const projectDocument: KnowledgeDocument = {
      ...readyDocument,
      id: 'doc-project',
      name: 'project.md',
      knowledgeBaseId: 'kb-project'
    };
    const transport = api({
      listBases: vi.fn(async () => [defaultBase, projectBase]),
      listDocuments: vi.fn(async (knowledgeBaseId) =>
        knowledgeBaseId === 'kb-project' ? [projectDocument] : [readyDocument]
      )
    });
    const store = createKnowledgeStore(transport, {
      storeId: 'knowledge-select'
    })();
    await store.initialize();

    expect(await store.selectBase('kb-project')).toBe(true);
    expect(store.activeKnowledgeBaseId).toBe('kb-project');
    expect(store.documents).toEqual([projectDocument]);
    expect(await store.selectBase('kb-missing')).toBe(false);
    expect(store.activeKnowledgeBaseId).toBe('kb-project');
  });

  it('never exposes the previous base documents after a failed selection', async () => {
    const transport = api({
      listBases: vi.fn(async () => [defaultBase, projectBase]),
      listDocuments: vi.fn()
        .mockResolvedValueOnce([readyDocument])
        .mockRejectedValueOnce(new Error('项目库不可用'))
    });
    const store = createKnowledgeStore(transport, {
      storeId: 'knowledge-select-failure'
    })();
    await store.initialize();

    expect(await store.selectBase('kb-project')).toBe(false);
    expect(store.activeKnowledgeBaseId).toBe('kb-project');
    expect(store.documents).toEqual([]);
    expect(store.errorMessage).toBe('项目库不可用');
  });

  it('returns deletion success only after the authoritative catalog is updated', async () => {
    const transport = api({
      listBases: vi.fn(async () => [defaultBase, projectBase])
    });
    const store = createKnowledgeStore(transport, {
      storeId: 'knowledge-delete'
    })();
    await store.initialize();
    await store.selectBase('kb-project');

    expect(await store.deleteBase('kb-project')).toBe(true);
    expect(store.knowledgeBases).toEqual([defaultBase]);
    expect(store.activeKnowledgeBaseId).toBe('kb-default');
    expect(store.documents).toEqual([readyDocument]);
    expect(store.noticeMessage).toBe('资料库已删除。');
  });

  it('keeps a successful deletion authoritative when the fallback document refresh fails', async () => {
    localStorage.setItem('yuan-agent-active-knowledge-base-v1', 'kb-project');
    const projectDocument = {
      ...readyDocument,
      id: 'doc-project',
      knowledgeBaseId: 'kb-project'
    };
    const transport = api({
      listBases: vi.fn(async () => [defaultBase, projectBase]),
      listDocuments: vi.fn()
        .mockResolvedValueOnce([projectDocument])
        .mockRejectedValueOnce(new Error('默认库刷新失败'))
    });
    const store = createKnowledgeStore(transport, {
      storeId: 'knowledge-delete-followup-failure'
    })();
    await store.initialize();

    expect(await store.deleteBase('kb-project')).toBe(true);
    expect(store.knowledgeBases).toEqual([defaultBase]);
    expect(store.activeKnowledgeBaseId).toBe('kb-default');
    expect(store.documents).toEqual([]);
    expect(store.errorMessage).toBe('默认库刷新失败');
  });

  it('removes a document only after the remote mutation succeeds', async () => {
    const emptyDefault = {
      ...defaultBase,
      documentCount: 0,
      publishedDocumentCount: 0,
      updatedAt: 5
    };
    const transport = api({
      listBases: vi.fn()
        .mockResolvedValueOnce([defaultBase])
        .mockResolvedValueOnce([emptyDefault])
    });
    const store = createKnowledgeStore(transport, {
      storeId: 'knowledge-remove-document'
    })();
    await store.initialize();

    expect(await store.removeDocument('doc-1', 'kb-default')).toBe(true);
    expect(store.documents).toEqual([]);
    expect(store.knowledgeBases).toEqual([emptyDefault]);
    expect(store.noticeMessage).toBe('知识文件已移除。');
  });

  it('clears only the explicitly targeted active knowledge base', async () => {
    const emptyDefault = {
      ...defaultBase,
      documentCount: 0,
      publishedDocumentCount: 0,
      updatedAt: 6
    };
    const transport = api({
      listBases: vi.fn()
        .mockResolvedValueOnce([defaultBase])
        .mockResolvedValueOnce([emptyDefault])
    });
    const store = createKnowledgeStore(transport, {
      storeId: 'knowledge-clear-documents'
    })();
    await store.initialize();

    expect(await store.clearDocuments('kb-default')).toBe(true);
    expect(store.documents).toEqual([]);
    expect(store.knowledgeBases).toEqual([emptyDefault]);
    expect(store.noticeMessage).toBe('资料库已清空。');
  });

  it('shows queued uploads immediately and privately polls them to a terminal state', async () => {
    vi.useFakeTimers();
    const queuedDocument: KnowledgeDocument = {
      ...readyDocument,
      status: 'queued',
      updatedAt: 2
    };
    const transport = api({
      listDocuments: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([readyDocument]),
      uploadDocuments: vi.fn(async () => [queuedDocument])
    });
    const store = createKnowledgeStore(transport, {
      storeId: 'knowledge-upload-poll'
    })();
    await store.initialize();

    const file = new File(['# Guide'], 'guide.md', { type: 'text/markdown' });
    expect(await store.uploadDocuments([file], 'kb-default')).toBe(true);
    expect(store.documents).toEqual([queuedDocument]);
    expect(store.noticeMessage).toContain('正在后台处理');

    await vi.advanceTimersByTimeAsync(1_500);
    expect(store.documents).toEqual([readyDocument]);
    store.dispose();
  });

  it('keeps a successful upload visible when the catalog count refresh fails', async () => {
    const queuedDocument: KnowledgeDocument = {
      ...readyDocument,
      status: 'queued'
    };
    const transport = api({
      listBases: vi.fn()
        .mockResolvedValueOnce([defaultBase])
        .mockRejectedValueOnce(new Error('目录计数刷新失败')),
      listDocuments: vi.fn(async () => []),
      uploadDocuments: vi.fn(async () => [queuedDocument])
    });
    const store = createKnowledgeStore(transport, {
      storeId: 'knowledge-upload-followup-failure'
    })();
    await store.initialize();

    expect(await store.uploadDocuments([], 'kb-default')).toBe(true);
    expect(store.documents).toEqual([queuedDocument]);
    expect(store.noticeMessage).toContain('正在后台处理');
    expect(store.errorMessage).toBe('目录计数刷新失败');
    store.dispose();
  });

  it('keeps preview separate from publication and reflects publish plus withdraw commands', async () => {
    const draftDocument: KnowledgeDocument = {
      ...readyDocument,
      publicationStatus: 'draft',
      publishedAt: null
    };
    const publishedDocument: KnowledgeDocument = {
      ...readyDocument,
      publicationStatus: 'published',
      publishedAt: 10
    };
    const transport = api({
      listDocuments: vi.fn(async () => [draftDocument]),
      getDocumentPreview: vi.fn(async () => ({
        document: draftDocument,
        preview: {
          excerpt: '# Guide',
          truncated: false,
          characterCount: 7,
          chunkCount: 1,
          headings: ['Guide']
        }
      })),
      publishDocument: vi.fn(async () => publishedDocument),
      withdrawDocument: vi.fn(async () => draftDocument)
    });
    const store = createKnowledgeStore(transport, {
      storeId: 'knowledge-governance'
    })();
    await store.initialize();

    expect(await store.previewDocument('doc-1', 'kb-default')).toBe(true);
    expect(store.selectedPreview?.preview.chunkCount).toBe(1);
    expect(await store.publishDocument('doc-1', 'kb-default')).toBe(true);
    expect(store.documents[0].publicationStatus).toBe('published');
    expect(store.selectedPreview?.document.publicationStatus).toBe('published');
    expect(store.noticeMessage).toContain('AI 检索');

    expect(await store.withdrawDocument('doc-1', 'kb-default')).toBe(true);
    expect(store.documents[0].publicationStatus).toBe('draft');
    expect(store.selectedPreview?.document.publicationStatus).toBe('draft');
    expect(store.noticeMessage).toContain('预索引已保留');

    store.closePreview();
    expect(store.selectedPreview).toBeNull();
  });

  it('does not let a late document response overwrite a newer active base', async () => {
    const otherBase: KnowledgeBase = {
      ...projectBase,
      id: 'kb-other',
      name: '其他资料'
    };
    const projectDocument = {
      ...readyDocument,
      id: 'doc-project',
      knowledgeBaseId: 'kb-project'
    };
    const otherDocument = {
      ...readyDocument,
      id: 'doc-other',
      knowledgeBaseId: 'kb-other'
    };
    const lateProject = deferred<KnowledgeDocument[]>();
    const transport = api({
      listBases: vi.fn(async () => [defaultBase, projectBase, otherBase]),
      listDocuments: vi.fn(async (knowledgeBaseId) => {
        if (knowledgeBaseId === 'kb-project') return lateProject.promise;
        if (knowledgeBaseId === 'kb-other') return [otherDocument];
        return [readyDocument];
      })
    });
    const store = createKnowledgeStore(transport, {
      storeId: 'knowledge-stale-documents'
    })();
    await store.initialize();

    const firstSelection = store.selectBase('kb-project');
    await store.selectBase('kb-other');
    lateProject.resolve([projectDocument]);
    await firstSelection;

    expect(store.activeKnowledgeBaseId).toBe('kb-other');
    expect(store.documents).toEqual([otherDocument]);
  });
});
