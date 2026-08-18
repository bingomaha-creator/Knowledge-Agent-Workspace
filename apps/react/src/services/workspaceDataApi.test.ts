import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeCatalogApi } from './knowledgeCatalogApi';
import { createMemoryApi } from './memoryApi';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('Chat workspace data services', () => {
  it('loads knowledge bases through the shared server contract', async () => {
    const knowledgeBase = {
      id: 'kb-project', name: '项目资料', isDefault: false,
      documentCount: 2, publishedDocumentCount: 1, draftDocumentCount: 1,
      createdAt: 1, updatedAt: 2
    };
    const fetcher = vi.fn(async () => jsonResponse({ knowledgeBases: [knowledgeBase] }));

    await expect(createKnowledgeCatalogApi(fetcher).list()).resolves.toEqual([knowledgeBase]);
    expect(fetcher).toHaveBeenCalledWith('/api/knowledge-bases', expect.objectContaining({
      headers: { Accept: 'application/json' }
    }));
  });

  it('updates a memory through the existing Memory API', async () => {
    const memory = { id: 'memory-1', status: 'corrected', content: '始终使用中文' };
    const fetcher = vi.fn(async () => jsonResponse({ memory }));

    await createMemoryApi(fetcher).update('memory/1', {
      content: '始终使用中文', status: 'corrected'
    });

    expect(fetcher).toHaveBeenCalledWith('/api/memories/memory%2F1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ content: '始终使用中文', status: 'corrected' })
    }));
  });
});
