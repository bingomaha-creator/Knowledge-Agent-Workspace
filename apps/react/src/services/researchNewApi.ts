import { ApiError, readJson, type Fetcher } from './sseClient';

export type ResearchNewMode = 'web' | 'hybrid';
export type ResearchNewStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ResearchNewStage = 'planning' | 'researching' | 'assessing' | 'reporting' | 'verifying' | 'completed';
export type ResearchNewQuality = 'pending' | 'sufficient' | 'limited' | 'insufficient';

export type ResearchNewTrack = {
  id: string;
  question: string;
  searchQueries?: string[];
  evidenceRequirements?: string[];
  status?: 'pending' | 'answered' | 'partial' | 'unresolved';
  gaps?: string[];
};

export type ResearchNewSource = {
  id: string;
  trackId: string;
  origin: 'workspace' | 'web';
  title: string;
  url?: string;
  snippet: string;
  query: string;
  sourceKind: string;
  knowledgeBaseId?: string;
  documentId?: string;
  readerKind?: string;
  contentLevel?: string;
  readFailure?: { code?: string; message?: string } | null;
};

export type ResearchNewEvidence = {
  id: string;
  trackId: string;
  sourceId: string;
  origin: 'workspace' | 'web';
  passage: string;
  supports: string[];
  contradicts: string[];
  relevance: number;
  sourceRole: string;
  contentLevel: string;
};

export type ResearchNewBudget = {
  maxRounds: number;
  maxSearchCalls: number;
  maxSourcesRead: number;
  maxWallTimeMs: number;
  maxWriterAttempts: number;
  roundsUsed: number;
  searchCalls: number;
  sourcesRead: number;
  writerAttempts: number;
};

export type ResearchNewRun = {
  id: string;
  question: string;
  mode: ResearchNewMode;
  knowledgeBaseIds: string[];
  status: ResearchNewStatus;
  stage: ResearchNewStage;
  progress: number;
  error: string;
  resultQuality: ResearchNewQuality;
  report: string;
  brief: Record<string, unknown>;
  tracks: ResearchNewTrack[];
  diagnostics: Record<string, unknown>;
  budget: ResearchNewBudget;
  attempt: number;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  sources: ResearchNewSource[];
  evidence: ResearchNewEvidence[];
};

export type ResearchNewRunSummary = Omit<ResearchNewRun, 'sources' | 'evidence'>;

export type ResearchNewCapabilities = {
  model: boolean;
  webSearch: boolean;
  webSearchProvider: {
    name: string;
    fullText: boolean;
    domainFilter: boolean;
    temporalFilter: boolean;
  };
  webReader: { configured: boolean; transport: string };
  modes: ResearchNewMode[];
  targetedReplan: boolean;
};

export type CreateResearchNewInput = {
  question: string;
  mode: ResearchNewMode;
  knowledgeBaseIds: string[];
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

export function createResearchNewApi(fetcher: Fetcher = fetch) {
  return {
    async getCapabilities() {
      const data = await readJson<{ capabilities?: ResearchNewCapabilities }>(
        '/api/research-new/capabilities', jsonInit(), fetcher
      );
      if (!data.capabilities) throw new ApiError('加载新版研究能力失败', { status: 502 });
      return data.capabilities;
    },

    async listRuns() {
      const data = await readJson<{ runs?: ResearchNewRunSummary[] }>(
        '/api/research-new?limit=50&offset=0', jsonInit(), fetcher
      );
      return data.runs || [];
    },

    async getRun(id: string) {
      const data = await readJson<{ run?: ResearchNewRun }>(
        `/api/research-new/${encodeURIComponent(id)}`, jsonInit(), fetcher
      );
      if (!data.run) throw new ApiError('新版研究任务不存在', { status: 404 });
      return data.run;
    },

    async createRun(input: CreateResearchNewInput) {
      const data = await readJson<{ run?: ResearchNewRun; notice?: string }>(
        '/api/research-new', jsonInit('POST', input), fetcher
      );
      if (!data.run) throw new ApiError('创建新版研究任务失败', { status: 502 });
      return { run: data.run, notice: data.notice || '' };
    },

    async cancelRun(id: string) {
      const data = await readJson<{ run?: ResearchNewRun }>(
        `/api/research-new/${encodeURIComponent(id)}/cancel`, jsonInit('POST'), fetcher
      );
      if (!data.run) throw new ApiError('取消新版研究任务失败', { status: 502 });
      return data.run;
    }
  };
}

export type ResearchNewApi = ReturnType<typeof createResearchNewApi>;
export const researchNewApi = createResearchNewApi((input, init) => fetch(input, init));
