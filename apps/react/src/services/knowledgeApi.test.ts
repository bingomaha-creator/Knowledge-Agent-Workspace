import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeApi } from './knowledgeApi';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('knowledgeApi', () => {
  it('owns the knowledge base and document JSON contracts', async () => {
    const base = { id: 'kb-project', name: '项目资料' };
    const document = { id: 'doc-1', knowledgeBaseId: 'kb-project', name: 'guide.md' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ knowledgeBases: [base] }))
      .mockResolvedValueOnce(jsonResponse({ knowledgeBase: base }, 201))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ documents: [document] }))
      .mockResolvedValueOnce(jsonResponse({ document, preview: { excerpt: '# Guide' } }))
      .mockResolvedValueOnce(jsonResponse({ document }))
      .mockResolvedValueOnce(jsonResponse({ document }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const api = createKnowledgeApi(fetcher);

    await expect(api.listBases()).resolves.toEqual([base]);
    await api.createBase({ name: '项目资料' });
    await api.deleteBase('kb/project');
    await api.listDocuments('kb/project');
    await api.getDocumentPreview('doc/1', 'kb/project');
    await api.publishDocument('doc/1', 'kb/project');
    await api.withdrawDocument('doc/1', 'kb/project');
    await api.deleteDocument('doc/1', 'kb/project');
    await api.clearDocuments('kb/project');

    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/knowledge-bases', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: '项目资料' })
    }));
    expect(fetcher).toHaveBeenNthCalledWith(3, '/api/knowledge-bases/kb%2Fproject?force=true', expect.objectContaining({ method: 'DELETE' }));
    expect(fetcher).toHaveBeenNthCalledWith(4, '/api/knowledge?knowledgeBaseId=kb%2Fproject', expect.any(Object));
    expect(fetcher).toHaveBeenNthCalledWith(5, '/api/knowledge/doc%2F1/preview?knowledgeBaseId=kb%2Fproject', expect.any(Object));
    expect(fetcher).toHaveBeenNthCalledWith(6, '/api/knowledge/doc%2F1/publish?knowledgeBaseId=kb%2Fproject', expect.objectContaining({ method: 'POST' }));
    expect(fetcher).toHaveBeenNthCalledWith(7, '/api/knowledge/doc%2F1/withdraw?knowledgeBaseId=kb%2Fproject', expect.objectContaining({ method: 'POST' }));
    expect(fetcher).toHaveBeenNthCalledWith(8, '/api/knowledge/doc%2F1?knowledgeBaseId=kb%2Fproject', expect.objectContaining({ method: 'DELETE' }));
    expect(fetcher).toHaveBeenNthCalledWith(9, '/api/knowledge?knowledgeBaseId=kb%2Fproject', expect.objectContaining({ method: 'DELETE' }));
  });

  it('uploads bounded files with the target knowledge base', async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse({ documents: [{ id: 'doc-1' }] })
    );
    const api = createKnowledgeApi(fetcher);
    const file = new File(['# Guide'], 'guide.md', { type: 'text/markdown' });

    await api.uploadDocuments([file], 'kb-project');

    const [, init] = fetcher.mock.calls[0];
    expect(init).toEqual(expect.objectContaining({ method: 'POST' }));
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get('knowledgeBaseId')).toBe('kb-project');
    expect((init?.body as FormData).getAll('files')).toHaveLength(1);
  });
});
