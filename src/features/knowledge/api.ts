import type {
  CreateKnowledgeBaseInput,
  KnowledgeApi,
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeDocumentPreview,
  UpdateKnowledgeBaseInput
} from './types';

interface ErrorPayload {
  error?: string;
  details?: string;
}

async function readResponse<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  let payload: (T & ErrorPayload) | null = null;
  if (text) {
    try {
      payload = JSON.parse(text) as T & ErrorPayload;
    } catch {
      throw new Error(response.ok ? fallback : text);
    }
  }
  if (!response.ok) {
    const message = payload?.error || fallback;
    throw new Error(payload?.details ? `${message}\n${payload.details}` : message);
  }
  return (payload || {}) as T;
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function scopedKnowledgeUrl(path: string, knowledgeBaseId: string) {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`;
}

async function documentsResponse(response: Promise<Response>, fallback: string) {
  const data = await readResponse<{ documents?: KnowledgeDocument[] }>(await response, fallback);
  return data.documents || [];
}

async function baseResponse(response: Promise<Response>, fallback: string) {
  const data = await readResponse<{ knowledgeBase?: KnowledgeBase }>(await response, fallback);
  if (!data.knowledgeBase) throw new Error(fallback);
  return data.knowledgeBase;
}

async function documentResponse(response: Promise<Response>, fallback: string) {
  const data = await readResponse<{ document?: KnowledgeDocument }>(await response, fallback);
  if (!data.document) throw new Error(fallback);
  return data.document;
}

export const knowledgeApi: KnowledgeApi = {
  async listBases() {
    const data = await readResponse<{ knowledgeBases?: KnowledgeBase[] }>(
      await fetch('/api/knowledge-bases'),
      '加载资料库失败'
    );
    return data.knowledgeBases || [];
  },

  createBase(input: CreateKnowledgeBaseInput) {
    return baseResponse(
      fetch('/api/knowledge-bases', jsonRequest('POST', input)),
      '创建资料库失败'
    );
  },

  updateBase(id: string, input: UpdateKnowledgeBaseInput) {
    return baseResponse(
      fetch(
        `/api/knowledge-bases/${encodeURIComponent(id)}`,
        jsonRequest('PATCH', input)
      ),
      '更新资料库失败'
    );
  },

  async deleteBase(id: string, force = false) {
    const suffix = force ? '?force=true' : '';
    await readResponse(
      await fetch(`/api/knowledge-bases/${encodeURIComponent(id)}${suffix}`, {
        method: 'DELETE'
      }),
      '删除资料库失败'
    );
  },

  listDocuments(knowledgeBaseId: string) {
    return documentsResponse(
      fetch(scopedKnowledgeUrl('/api/knowledge', knowledgeBaseId)),
      '加载资料库失败'
    );
  },

  uploadDocuments(files: FileList | File[], knowledgeBaseId: string) {
    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append('files', file));
    formData.append('knowledgeBaseId', knowledgeBaseId);
    return documentsResponse(
      fetch('/api/knowledge/upload', { method: 'POST', body: formData }),
      '上传失败'
    );
  },

  async getDocumentPreview(id: string, knowledgeBaseId: string) {
    const data = await readResponse<KnowledgeDocumentPreview>(
      await fetch(scopedKnowledgeUrl(
        `/api/knowledge/${encodeURIComponent(id)}/preview`,
        knowledgeBaseId
      )),
      '加载文档预览失败'
    );
    if (!data.document || !data.preview) throw new Error('加载文档预览失败');
    return data;
  },

  publishDocument(id: string, knowledgeBaseId: string) {
    return documentResponse(
      fetch(
        scopedKnowledgeUrl(`/api/knowledge/${encodeURIComponent(id)}/publish`, knowledgeBaseId),
        { method: 'POST' }
      ),
      '发布知识文档失败'
    );
  },

  withdrawDocument(id: string, knowledgeBaseId: string) {
    return documentResponse(
      fetch(
        scopedKnowledgeUrl(`/api/knowledge/${encodeURIComponent(id)}/withdraw`, knowledgeBaseId),
        { method: 'POST' }
      ),
      '撤回知识文档失败'
    );
  },

  async deleteDocument(id: string, knowledgeBaseId: string) {
    await readResponse(
      await fetch(
        scopedKnowledgeUrl(`/api/knowledge/${encodeURIComponent(id)}`, knowledgeBaseId),
        { method: 'DELETE' }
      ),
      '删除失败'
    );
  },

  async clearDocuments(knowledgeBaseId: string) {
    await readResponse(
      await fetch(scopedKnowledgeUrl('/api/knowledge', knowledgeBaseId), {
        method: 'DELETE'
      }),
      '清空失败'
    );
  }
};
