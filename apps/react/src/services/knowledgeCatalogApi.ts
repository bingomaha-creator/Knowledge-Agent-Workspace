import type { KnowledgeBaseSummary } from '@/features/chat/chat.types';
import { readJson, type Fetcher } from './sseClient';

export function createKnowledgeCatalogApi(fetcher: Fetcher = fetch) {
  return {
    async list() {
      const data = await readJson<{ knowledgeBases?: KnowledgeBaseSummary[] }>(
        '/api/knowledge-bases',
        { headers: { Accept: 'application/json' } },
        fetcher
      );
      return data.knowledgeBases || [];
    }
  };
}

export const knowledgeCatalogApi = createKnowledgeCatalogApi(
  (input, init) => fetch(input, init)
);
