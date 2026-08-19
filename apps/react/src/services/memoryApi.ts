import { ApiError, readJson, type Fetcher } from './sseClient';

export type MemoryType = 'profile' | 'preference' | 'fact' | 'event' | 'pitfall';
export type MemoryStatus = 'candidate' | 'confirmed' | 'corrected' | 'rejected';

export type MemoryRecord = Record<string, unknown> & {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  details: Record<string, unknown>;
  confidence: number;
  status: MemoryStatus;
  sourceConversationId: string;
  sourceMessageIds: string[];
  sourceExcerpt: string;
  sourceExcerptTruncated?: boolean;
  createdAt: number;
  updatedAt: number;
  confirmedAt?: number | null;
  score?: number;
};

export type MemoryCandidate = Pick<
  MemoryRecord,
  | 'id'
  | 'type'
  | 'title'
  | 'content'
  | 'confidence'
  | 'status'
  | 'sourceConversationId'
  | 'sourceMessageIds'
  | 'sourceExcerpt'
  | 'sourceExcerptTruncated'
> & Record<string, unknown>;

export type MemoryPatch = Partial<Pick<
  MemoryRecord,
  'type' | 'title' | 'content' | 'details' | 'confidence' | 'status'
>>;

export type MemoryCreateInput = Pick<MemoryRecord, 'type' | 'title' | 'content'>;

export type MemoryListFilters = {
  status?: MemoryStatus;
  type?: MemoryType;
  query?: string;
  limit?: number;
  offset?: number;
};

export type MemoryListResult = {
  memories: MemoryRecord[];
  total: number;
};

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

function listUrl(filters: MemoryListFilters = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.type) params.set('type', filters.type);
  if (filters.query?.trim()) params.set('query', filters.query.trim().slice(0, 500));
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters.offset !== undefined) params.set('offset', String(filters.offset));
  const search = params.toString();
  return `/api/memories${search ? `?${search}` : ''}`;
}

export function createMemoryApi(fetcher: Fetcher = fetch) {
  return {
    async list(filters: MemoryListFilters = {}): Promise<MemoryListResult> {
      const data = await readJson<{ memories?: MemoryRecord[]; total?: number }>(
        listUrl(filters), jsonInit(), fetcher
      );
      return {
        memories: data.memories || [],
        total: Number.isFinite(Number(data.total)) ? Number(data.total) : 0
      };
    },

    async get(memoryId: string) {
      const data = await readJson<{ memory?: MemoryRecord }>(
        `/api/memories/${encodeURIComponent(memoryId)}`, jsonInit(), fetcher
      );
      if (!data.memory) throw new ApiError('加载长期记忆失败', { status: 502 });
      return data.memory;
    },

    async create(input: MemoryCreateInput) {
      const data = await readJson<{ memory?: MemoryRecord }>(
        '/api/memories', jsonInit('POST', input), fetcher
      );
      if (!data.memory) throw new ApiError('创建长期记忆失败', { status: 502 });
      return data.memory;
    },

    async update(memoryId: string, patch: MemoryPatch) {
      const data = await readJson<{ memory?: MemoryRecord }>(
        `/api/memories/${encodeURIComponent(memoryId)}`,
        jsonInit('PATCH', patch),
        fetcher
      );
      if (!data.memory) throw new ApiError('更新长期记忆失败', { status: 502 });
      return data.memory;
    },

    async remove(memoryId: string) {
      await readJson(
        `/api/memories/${encodeURIComponent(memoryId)}`,
        jsonInit('DELETE'),
        fetcher
      );
    }
  };
}

export type MemoryApi = ReturnType<typeof createMemoryApi>;
export const memoryApi = createMemoryApi((input, init) => fetch(input, init));
