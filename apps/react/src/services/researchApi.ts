import { ApiError, readJson, type Fetcher } from './sseClient';

export type ResearchTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ResearchStage =
  | 'planning'
  | 'retrieving'
  | 'extracting'
  | 'outlining'
  | 'writing'
  | 'verifying'
  | 'completed';

export type ResearchSearchMode = 'local' | 'hybrid' | 'web';

export type ResearchWebSearchStatus =
  | 'not_requested'
  | 'pending'
  | 'available'
  | 'unavailable'
  | 'partial'
  | 'error';

export type ResearchResultQuality = 'pending' | 'sufficient' | 'limited' | 'insufficient';

export type ResearchLimitation = { code: string; message: string };

export type ResearchCapabilities = {
  localKnowledge: boolean;
  publicPrimarySearch: { available: boolean; role: string };
};

export type ResearchCitation = {
  id: string;
  index?: number;
  title: string;
  snippet: string;
  source: string;
  url?: string;
  kind?: 'local' | 'web';
  knowledgeBaseId?: string;
  documentId?: string;
  subquestion?: string;
  sourceKind?: string;
  provenance?: string;
  sourceDomain?: string;
};

export type ResearchStageDiagnostics = {
  mode?: string;
  status?: string;
  reasonCode?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type ResearchArtifacts = {
  plan?: {
    schemaVersion?: number;
    objective?: string;
    planner?: string;
    fallbackReason?: string;
    diagnostics?: ResearchStageDiagnostics | null;
    evidencePolicy?: {
      id?: string;
      label?: string;
      sourcePriority?: Array<'local' | 'web'>;
    };
    subquestions?: Array<{
      id: string;
      subject?: string;
      question: string;
      searchQuery?: string;
      intent?: string;
      facets?: string[];
      rationale?: string;
      evidenceNeed?: { preferredSourceTypes?: string[] };
    }>;
  };
  evidencePack?: {
    candidateCount?: number;
    acceptedCount?: number;
    excludedCount?: number;
    includedCount?: number;
    citationCount?: number;
    readSourceCount?: number;
    passageCount?: number;
    totalCharacters?: number;
    snippetFallbackCount?: number;
    exclusionReasons?: string[];
    policyLabel?: string;
  };
  evidence?: Array<{
    citationId: string;
    citationNumber?: number;
    claim: string;
    snippet: string;
    source?: string;
  }>;
  sources?: ResearchCitation[];
  reading?: {
    selectedSourceCount?: number;
    readSourceCount?: number;
    failedSourceCount?: number;
    durationMs?: number;
    failures?: Array<{ sourceId: string; code: string; message: string }>;
  };
  writer?: {
    mode?: string;
    status?: string;
    reasonCode?: string;
    fallbackReason?: string;
    durationMs?: number;
    evidenceCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    outputCharacters?: number;
  };
  diagnostics?: {
    planning?: ResearchStageDiagnostics | null;
    retrieval?: Array<{ id: string; query: string; durationMs: number; sourceCount: number; status: string }>;
    reading?: ResearchArtifacts['reading'] | null;
    writing?: ResearchArtifacts['writer'] | null;
  };
  [key: string]: unknown;
};

export type ResearchContinuationContext = {
  originQuestion?: string;
  parent?: {
    taskId?: string;
    question?: string;
    reportExcerpt?: string;
    resultQuality?: string;
    limitations?: ResearchLimitation[];
  };
  citations?: Array<{
    id?: string;
    title?: string;
    snippet?: string;
    url?: string;
    kind?: 'local' | 'web';
    originTaskId?: string;
  }>;
};

export type ResearchTask = {
  id: string;
  question: string;
  status: ResearchTaskStatus;
  stage: ResearchStage;
  progress: number;
  error: string;
  report: string;
  citations: ResearchCitation[];
  searchMode: ResearchSearchMode;
  webSearchStatus: ResearchWebSearchStatus;
  resultQuality: ResearchResultQuality;
  limitations: ResearchLimitation[];
  failedStage: string;
  attempt: number;
  cancelRequested: boolean;
  sessionId: string;
  parentTaskId: string;
  turnIndex: number;
  continuationContext: ResearchContinuationContext | null;
  knowledgeBaseIds: string[];
  artifacts: ResearchArtifacts;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type ResearchSessionSnapshot = {
  sessionId: string;
  runs: ResearchTask[];
};

export type CreateResearchInput = {
  question: string;
  searchMode: ResearchSearchMode;
  knowledgeBaseIds: string[];
};

export type ContinueResearchInput = {
  question: string;
  searchMode?: ResearchSearchMode;
  knowledgeBaseIds?: string[];
};

export function isResearchNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function requireTask(value: ResearchTask | undefined | null, message: string): ResearchTask {
  if (!value || typeof value.id !== 'string' || !value.id) {
    throw new ApiError(message, { code: 'INVALID_RESEARCH_PAYLOAD', status: 502 });
  }
  return value;
}

/** 缺失或非数组的 tasks/runs 属于协议错误；合法的空数组保持正常空态。 */
function requireTaskArray(value: unknown, message: string): ResearchTask[] {
  if (!Array.isArray(value)) {
    throw new ApiError(message, { code: 'INVALID_RESEARCH_PAYLOAD', status: 502 });
  }
  return value as ResearchTask[];
}

export function createResearchApi(fetcher: Fetcher = (input, init) => fetch(input, init)) {
  return {
    async getCapabilities(): Promise<ResearchCapabilities> {
      const data = await readJson<{ capabilities?: Partial<ResearchCapabilities> }>(
        '/api/research/capabilities', { method: 'GET' }, fetcher
      );
      const capabilities = data.capabilities;
      return {
        localKnowledge: Boolean(capabilities?.localKnowledge),
        publicPrimarySearch: {
          available: Boolean(capabilities?.publicPrimarySearch?.available),
          role: capabilities?.publicPrimarySearch?.role || 'supplemental'
        }
      };
    },

    async listTasks(): Promise<ResearchTask[]> {
      const data = await readJson<{ tasks?: unknown }>('/api/research', { method: 'GET' }, fetcher);
      return requireTaskArray(data.tasks, '研究任务列表格式无效');
    },

    async getTask(id: string): Promise<ResearchTask> {
      const data = await readJson<{ task?: ResearchTask }>(
        `/api/research/${encodeURIComponent(id)}`, { method: 'GET' }, fetcher
      );
      return requireTask(data.task, '读取研究任务失败');
    },

    async getSession(id: string): Promise<ResearchSessionSnapshot> {
      const data = await readJson<{ sessionId?: string; runs?: unknown }>(
        `/api/research/${encodeURIComponent(id)}/session`, { method: 'GET' }, fetcher
      );
      return {
        sessionId: data.sessionId || id,
        runs: requireTaskArray(data.runs, '研究会话时间线格式无效')
      };
    },

    async createTask(input: CreateResearchInput): Promise<{ task: ResearchTask; notice: string }> {
      const data = await readJson<{ task?: ResearchTask; notice?: string }>(
        '/api/research', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, fetcher
      );
      return { task: requireTask(data.task, '创建研究任务失败'), notice: data.notice || '' };
    },

    async continueTask(id: string, input: ContinueResearchInput): Promise<{ task: ResearchTask; notice: string }> {
      const data = await readJson<{ task?: ResearchTask; notice?: string }>(
        `/api/research/${encodeURIComponent(id)}/follow-ups`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
        fetcher
      );
      return { task: requireTask(data.task, '创建后续研究失败'), notice: data.notice || '' };
    },

    async retryTask(id: string): Promise<ResearchTask> {
      const data = await readJson<{ task?: ResearchTask }>(
        `/api/research/${encodeURIComponent(id)}/retry`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        fetcher
      );
      return requireTask(data.task, '重试研究任务失败');
    },

    async cancelTask(id: string): Promise<ResearchTask> {
      const data = await readJson<{ task?: ResearchTask }>(
        `/api/research/${encodeURIComponent(id)}/cancel`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        fetcher
      );
      return requireTask(data.task, '取消研究任务失败');
    }
  };
}

export type ResearchApi = ReturnType<typeof createResearchApi>;
export const researchApi = createResearchApi();
