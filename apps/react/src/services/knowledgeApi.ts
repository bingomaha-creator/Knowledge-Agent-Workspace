import { ApiError, readJson, type Fetcher } from './sseClient';

export type KnowledgeBase = {
  id: string;
  name: string;
  description?: string;
  isDefault: boolean;
  documentCount: number;
  publishedDocumentCount: number;
  draftDocumentCount: number;
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeDocumentStatus = 'queued' | 'processing' | 'ready' | 'failed';
export type KnowledgePublicationStatus = 'draft' | 'published';

export type KnowledgeDocument = {
  id: string;
  name: string;
  knowledgeBaseId: string;
  status: KnowledgeDocumentStatus;
  publicationStatus: KnowledgePublicationStatus;
  publishedAt?: number | null;
  error?: string | null;
  createdAt: number;
  updatedAt?: number;
};

export type KnowledgePreview = {
  excerpt: string;
  truncated: boolean;
  characterCount: number;
  chunkCount: number;
  headings: string[];
};

export type KnowledgeDocumentPreview = {
  document: KnowledgeDocument;
  preview: KnowledgePreview;
};

type CreateKnowledgeBaseInput = { name: string; description?: string };

function jsonInit(method = 'GET', body?: unknown): RequestInit {
  return {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  };
}

function scopedUrl(path: string, knowledgeBaseId: string) {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`;
}

export function createKnowledgeApi(fetcher: Fetcher = fetch) {
  return {
    async listBases() {
      const data = await readJson<{ knowledgeBases?: KnowledgeBase[] }>(
        '/api/knowledge-bases', jsonInit(), fetcher
      );
      return data.knowledgeBases || [];
    },

    async createBase(input: CreateKnowledgeBaseInput) {
      const data = await readJson<{ knowledgeBase?: KnowledgeBase }>(
        '/api/knowledge-bases', jsonInit('POST', input), fetcher
      );
      if (!data.knowledgeBase) throw new ApiError('创建资料库失败', { status: 502 });
      return data.knowledgeBase;
    },

    async deleteBase(id: string) {
      await readJson(`/api/knowledge-bases/${encodeURIComponent(id)}?force=true`, jsonInit('DELETE'), fetcher);
    },

    async listDocuments(knowledgeBaseId: string) {
      const data = await readJson<{ documents?: KnowledgeDocument[] }>(
        scopedUrl('/api/knowledge', knowledgeBaseId), jsonInit(), fetcher
      );
      return data.documents || [];
    },

    async uploadDocuments(files: FileList | File[], knowledgeBaseId: string) {
      const body = new FormData();
      for (const file of Array.from(files)) body.append('files', file);
      body.append('knowledgeBaseId', knowledgeBaseId);
      const data = await readJson<{ documents?: KnowledgeDocument[] }>(
        '/api/knowledge/upload', { method: 'POST', body }, fetcher
      );
      return data.documents || [];
    },

    async getDocumentPreview(id: string, knowledgeBaseId: string) {
      const data = await readJson<Partial<KnowledgeDocumentPreview>>(
        scopedUrl(`/api/knowledge/${encodeURIComponent(id)}/preview`, knowledgeBaseId),
        jsonInit(), fetcher
      );
      if (!data.document || !data.preview) {
        throw new ApiError('加载文档预览失败', { status: 502 });
      }
      return data as KnowledgeDocumentPreview;
    },

    async publishDocument(id: string, knowledgeBaseId: string) {
      return documentMutation('publish', id, knowledgeBaseId, fetcher);
    },

    async withdrawDocument(id: string, knowledgeBaseId: string) {
      return documentMutation('withdraw', id, knowledgeBaseId, fetcher);
    },

    async deleteDocument(id: string, knowledgeBaseId: string) {
      await readJson(
        scopedUrl(`/api/knowledge/${encodeURIComponent(id)}`, knowledgeBaseId),
        jsonInit('DELETE'), fetcher
      );
    },

    async clearDocuments(knowledgeBaseId: string) {
      await readJson(scopedUrl('/api/knowledge', knowledgeBaseId), jsonInit('DELETE'), fetcher);
    }
  };
}

async function documentMutation(
  action: 'publish' | 'withdraw',
  id: string,
  knowledgeBaseId: string,
  fetcher: Fetcher
) {
  const data = await readJson<{ document?: KnowledgeDocument }>(
    scopedUrl(`/api/knowledge/${encodeURIComponent(id)}/${action}`, knowledgeBaseId),
    jsonInit('POST'), fetcher
  );
  if (!data.document) throw new ApiError('更新知识文档失败', { status: 502 });
  return data.document;
}

export type KnowledgeApi = ReturnType<typeof createKnowledgeApi>;
export const knowledgeApi = createKnowledgeApi((input, init) => fetch(input, init));
