import { beforeEach, describe, expect, it, vi } from 'vitest';
import { knowledgeApi } from './api';
import type { KnowledgeBase, KnowledgeDocument } from './types';

const base: KnowledgeBase = {
  id: 'kb-default',
  name: '默认知识库',
  description: '',
  isDefault: true,
  documentCount: 1,
  publishedDocumentCount: 0,
  draftDocumentCount: 1,
  createdAt: 1,
  updatedAt: 1
};

const document: KnowledgeDocument = {
  id: 'doc/1',
  name: 'guide.md',
  knowledgeBaseId: 'kb project',
  status: 'queued',
  publicationStatus: 'draft',
  error: null,
  createdAt: 2,
  updatedAt: 2
};

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

describe('Knowledge HTTP adapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('loads the authoritative knowledge base catalog', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ knowledgeBases: [base] }));

    await expect(knowledgeApi.listBases()).resolves.toEqual([base]);
    expect(fetch).toHaveBeenCalledWith('/api/knowledge-bases');
  });

  it('maps knowledge base mutations to the existing HTTP contract', async () => {
    const project = { ...base, id: 'kb-project', name: '项目资料', isDefault: false };
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ knowledgeBase: project }))
      .mockResolvedValueOnce(response({ knowledgeBase: { ...project, name: '项目文档' } }))
      .mockResolvedValueOnce(response({}));

    await expect(knowledgeApi.createBase({ name: '项目资料' })).resolves.toEqual(project);
    await expect(knowledgeApi.updateBase('kb-project', { name: '项目文档' }))
      .resolves.toEqual({ ...project, name: '项目文档' });
    await expect(knowledgeApi.deleteBase('kb-project', true)).resolves.toBeUndefined();

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/knowledge-bases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '项目资料' })
    });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/knowledge-bases/kb-project', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '项目文档' })
    });
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/knowledge-bases/kb-project?force=true',
      { method: 'DELETE' }
    );
  });

  it('keeps document scope explicit across list, upload, delete, and clear', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ documents: [document] }))
      .mockResolvedValueOnce(response({ documents: [document] }))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({}));

    await expect(knowledgeApi.listDocuments('kb project')).resolves.toEqual([document]);
    const file = new File(['guide'], 'guide.md', { type: 'text/markdown' });
    await expect(knowledgeApi.uploadDocuments([file], 'kb project')).resolves.toEqual([document]);
    await expect(knowledgeApi.deleteDocument('doc/1', 'kb project')).resolves.toBeUndefined();
    await expect(knowledgeApi.clearDocuments('kb project')).resolves.toBeUndefined();

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/knowledge?knowledgeBaseId=kb%20project'
    );
    const uploadCall = vi.mocked(fetch).mock.calls[1];
    expect(uploadCall[0]).toBe('/api/knowledge/upload');
    expect(uploadCall[1]?.method).toBe('POST');
    expect(uploadCall[1]?.body).toBeInstanceOf(FormData);
    expect((uploadCall[1]?.body as FormData).get('knowledgeBaseId')).toBe('kb project');
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/knowledge/doc%2F1?knowledgeBaseId=kb%20project',
      { method: 'DELETE' }
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      '/api/knowledge?knowledgeBaseId=kb%20project',
      { method: 'DELETE' }
    );
  });

  it('maps preview, publish, and withdraw to explicit governance commands', async () => {
    const preview = {
      document,
      preview: {
        excerpt: '# Guide',
        truncated: false,
        characterCount: 7,
        chunkCount: 1,
        headings: ['Guide']
      }
    };
    const published = {
      ...document,
      status: 'ready' as const,
      publicationStatus: 'published' as const,
      publishedAt: 10
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(preview))
      .mockResolvedValueOnce(response({ document: published }))
      .mockResolvedValueOnce(response({
        document: { ...published, publicationStatus: 'draft', publishedAt: null }
      }));

    await expect(knowledgeApi.getDocumentPreview('doc/1', 'kb project')).resolves.toEqual(preview);
    await expect(knowledgeApi.publishDocument('doc/1', 'kb project')).resolves.toEqual(published);
    await expect(knowledgeApi.withdrawDocument('doc/1', 'kb project')).resolves.toMatchObject({
      publicationStatus: 'draft',
      publishedAt: null
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/knowledge/doc%2F1/preview?knowledgeBaseId=kb%20project'
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/knowledge/doc%2F1/publish?knowledgeBaseId=kb%20project',
      { method: 'POST' }
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      '/api/knowledge/doc%2F1/withdraw?knowledgeBaseId=kb%20project',
      { method: 'POST' }
    );
  });
});
