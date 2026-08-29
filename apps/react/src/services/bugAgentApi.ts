import { ApiError, readJson, type Fetcher } from './sseClient';

export type BugEvidenceType =
  | 'error' | 'network' | 'test_failure' | 'code'
  | 'environment' | 'reproduction' | 'verification' | 'note';
export type BugInvestigationStatus = 'draft' | 'converted' | 'closed';
export type EvidenceQuality = 'pending' | 'sufficient' | 'limited' | 'insufficient';
export type BugReviewStatus = 'candidate' | 'confirmed' | 'rejected';
export type BugProcessingStatus = 'queued' | 'processing' | 'ready' | 'failed';
export type BugScope = 'project' | 'common';
export type BugResolutionType = 'root_cause_fix' | 'verified_workaround';

export type BugEvidenceInput = {
  type: BugEvidenceType;
  content: string;
  metadata?: { fileName?: string; language?: string; lineStart?: number | null };
};

export type BugEvidence = BugEvidenceInput & {
  id: string;
  redactions: Array<{ kind: string; count: number }>;
  metadata: { fileName: string; language: string; lineStart: number | null };
  createdAt: number;
};

export type BugInvestigationFacts = {
  errorTypes: string[];
  errorCodes?: string[];
  messages: string[];
  files: string[];
  locations: string[];
  languages?: string[];
  frameworks: string[];
  environments: string[];
  errorSignatures: string[];
  reproductionSteps: string[];
  verificationNotes: string[];
  evidenceIds: string[];
};

export type BugHypothesis = {
  title: string;
  reasoning: string;
  falsification?: string;
  confidenceLabel: 'supported' | 'plausible' | 'weak';
  supportingEvidenceIds: string[];
  counterEvidenceIds: string[];
  relatedCaseIds: string[];
};

export type BugVerificationStep = {
  title: string;
  instruction: string;
  supportingSignal?: string;
  refutingSignal?: string;
  expectedSignal?: string;
};

export type SimilarBugCase = {
  id: string;
  title: string;
  symptom: string;
  scope: BugScope;
  sourceProjectRef: string;
  rootCause: string | null;
  fix: string;
  verification: string;
  matchedChannels: Array<'exact' | 'fts' | 'vector'>;
  rank: number;
  score: number;
};

export type BugInvestigationAnalysis = {
  policyVersion?: string;
  status: 'idle' | 'stale' | 'success' | 'degraded' | 'insufficient';
  evidenceQuality: EvidenceQuality;
  summary: string;
  hypotheses: BugHypothesis[];
  verificationSteps: BugVerificationStep[];
  missingEvidence: string[];
  nextAction?: { title: string; description: string; evidenceType: BugEvidenceType } | null;
  similarCases: SimilarBugCase[];
  retrievalTrace: { degradedChannels: string[]; ambiguous: boolean; evidenceGap: boolean } | null;
  reasonCode: string;
};

export type InvestigationRun = {
  id: string;
  status: 'success' | 'degraded' | 'insufficient' | 'failed';
  mode: 'model' | 'deterministic';
  reasonCode: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  evidenceCount: number;
  similarCaseCount: number;
  createdAt: number;
};

export type BugInvestigation = {
  id: string;
  projectRef: string;
  title: string;
  status: BugInvestigationStatus;
  evidence: BugEvidence[];
  facts: BugInvestigationFacts;
  analysis: BugInvestigationAnalysis;
  runs: InvestigationRun[];
  candidateReadiness: { ready: boolean; checks: Array<{ key: string; label: string; passed: boolean }> };
  candidateBugCaseId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type BugContext = {
  language: string;
  framework: string;
  versions: string[];
  module: string;
  environment: string;
};

export type BugCaseDraft = {
  sourceProjectRef: string;
  title: string;
  symptom: string;
  errorSignatures: string[];
  reproductionSteps: string[];
  context: BugContext;
  resolutionType: BugResolutionType;
  rootCause: string | null;
  fix: string;
  workaroundRisks: string[];
  applicability: string[];
  verification: string;
  tags: string[];
  sourceRefs: string[];
};

export type BugCasePatch = Partial<Omit<BugCaseDraft, 'sourceProjectRef'>>;

export type BugCase = BugCaseDraft & {
  id: string;
  knowledgeBaseId: string;
  scope: BugScope;
  fingerprint: string;
  status: BugProcessingStatus;
  error: string | null;
  reviewStatus: BugReviewStatus;
  reviewedBy: string | null;
  reviewReason: string | null;
  reviewedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type BugProject = {
  projectRef: string;
  knowledgeBaseId: string;
  name: string;
  description: string;
  kind: 'project_bugs';
  bugCaseCount: number;
  createdAt: number;
  updatedAt: number;
};

export type BugCaseListFilters = {
  sourceProjectRef?: string;
  scope?: BugScope;
  reviewStatuses?: BugReviewStatus[];
  statuses?: BugProcessingStatus[];
  knowledgeBaseIds?: string[];
};

export type BugSearchFilters = {
  language?: string;
  framework?: string;
  versions?: string[];
  tags?: string[];
};

export type BugSearchRequest = {
  query: string;
  projectRef: string;
  includeCommon: boolean;
  additionalProjectRefs: string[];
  filters: BugSearchFilters;
  topK: number;
};

export type BugSearchResult = {
  bugCase: BugCase;
  rank: number;
  score: number;
  matchedChannels: Array<'exact' | 'fts' | 'vector'>;
  citations: Array<{
    id: string;
    documentId: string;
    knowledgeBaseId?: string;
    headingPath: string[];
    snippet: string;
    channel: 'fts' | 'vector';
    rank: number;
    bm25Score?: number;
    vectorScore?: number;
  }>;
};

export type BugSearchResponse = {
  results: BugSearchResult[];
  scope: { projectRefs: string[]; knowledgeBaseIds: string[]; includesCommon: boolean };
  trace: { degradedChannels: string[]; ambiguous: boolean; evidenceGap: boolean };
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

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new ApiError(message, { status: 502 });
  return value;
}

function caseListUrl(filters: BugCaseListFilters = {}) {
  const params = new URLSearchParams();
  if (filters.sourceProjectRef) params.set('sourceProjectRef', filters.sourceProjectRef);
  if (filters.scope) params.set('scope', filters.scope);
  filters.reviewStatuses?.forEach((status) => params.append('reviewStatus', status));
  filters.statuses?.forEach((status) => params.append('status', status));
  filters.knowledgeBaseIds?.forEach((id) => params.append('knowledgeBaseId', id));
  const query = params.toString();
  return `/api/bug-cases${query ? `?${query}` : ''}`;
}

export function createBugAgentApi(fetcher: Fetcher = fetch) {
  async function investigationAction(id: string, action: 'analyze' | 'convert' | 'close') {
    const data = await readJson<{ investigation?: BugInvestigation }>(
      `/api/bug-investigations/${encodeURIComponent(id)}/${action}`,
      jsonInit('POST'), fetcher
    );
    return requireValue(data.investigation, '更新 Bug 调查失败');
  }

  async function caseAction(id: string, action: 'promote') {
    const data = await readJson<{ bugCase?: BugCase }>(
      `/api/bug-cases/${encodeURIComponent(id)}/${action}`,
      jsonInit('POST'), fetcher
    );
    return requireValue(data.bugCase, '更新 BugCase 失败');
  }

  return {
    async listProjects() {
      const data = await readJson<{ projects?: BugProject[] }>('/api/bug-projects', jsonInit(), fetcher);
      return data.projects || [];
    },

    async createProject(input: { name: string; description?: string }) {
      const data = await readJson<{ project?: BugProject }>(
        '/api/bug-projects', jsonInit('POST', input), fetcher
      );
      return requireValue(data.project, '创建 Bug 项目失败');
    },

    async listInvestigations(projectRef: string, status?: BugInvestigationStatus) {
      const params = new URLSearchParams({ projectRef });
      if (status) params.set('status', status);
      const data = await readJson<{ investigations?: BugInvestigation[] }>(
        `/api/bug-investigations?${params}`, jsonInit(), fetcher
      );
      return data.investigations || [];
    },

    async getInvestigation(id: string) {
      const data = await readJson<{ investigation?: BugInvestigation }>(
        `/api/bug-investigations/${encodeURIComponent(id)}`, jsonInit(), fetcher
      );
      return requireValue(data.investigation, '加载 Bug 调查失败');
    },

    async createInvestigation(input: { projectRef: string; title?: string; evidence: BugEvidenceInput }) {
      const data = await readJson<{ investigation?: BugInvestigation }>(
        '/api/bug-investigations', jsonInit('POST', input), fetcher
      );
      return requireValue(data.investigation, '创建 Bug 调查失败');
    },

    async appendEvidence(id: string, evidence: BugEvidenceInput) {
      const data = await readJson<{ investigation?: BugInvestigation }>(
        `/api/bug-investigations/${encodeURIComponent(id)}/evidence`,
        jsonInit('POST', evidence), fetcher
      );
      return requireValue(data.investigation, '追加调查证据失败');
    },

    analyzeInvestigation: (id: string) => investigationAction(id, 'analyze'),
    convertInvestigation: (id: string) => investigationAction(id, 'convert'),
    closeInvestigation: (id: string) => investigationAction(id, 'close'),

    async listCases(filters: BugCaseListFilters = {}) {
      const data = await readJson<{ bugCases?: BugCase[] }>(caseListUrl(filters), jsonInit(), fetcher);
      return data.bugCases || [];
    },

    async getCase(id: string) {
      const data = await readJson<{ bugCase?: BugCase }>(
        `/api/bug-cases/${encodeURIComponent(id)}`, jsonInit(), fetcher
      );
      return requireValue(data.bugCase, '加载 BugCase 失败');
    },

    async createCase(input: BugCaseDraft) {
      const data = await readJson<{ bugCase?: BugCase }>(
        '/api/bug-cases', jsonInit('POST', input), fetcher
      );
      return requireValue(data.bugCase, '创建 BugCase 失败');
    },

    async updateCase(id: string, patch: BugCasePatch) {
      const data = await readJson<{ bugCase?: BugCase }>(
        `/api/bug-cases/${encodeURIComponent(id)}`, jsonInit('PATCH', patch), fetcher
      );
      return requireValue(data.bugCase, '更新 BugCase 失败');
    },

    async reviewCase(id: string, review: { reviewStatus: 'confirmed' | 'rejected'; reviewReason: string }) {
      const data = await readJson<{ bugCase?: BugCase }>(
        `/api/bug-cases/${encodeURIComponent(id)}/review`, jsonInit('POST', review), fetcher
      );
      return requireValue(data.bugCase, '审核 BugCase 失败');
    },

    promoteCase: (id: string) => caseAction(id, 'promote'),

    async deleteCase(id: string) {
      await readJson(`/api/bug-cases/${encodeURIComponent(id)}`, jsonInit('DELETE'), fetcher);
    },

    async searchCases(input: BugSearchRequest) {
      const data = await readJson<Partial<BugSearchResponse>>(
        '/api/bug-cases/search', jsonInit('POST', input), fetcher
      );
      return {
        results: data.results || [],
        scope: data.scope || { projectRefs: [], knowledgeBaseIds: [], includesCommon: false },
        trace: data.trace || { degradedChannels: [], ambiguous: false, evidenceGap: false }
      } satisfies BugSearchResponse;
    }
  };
}

export type BugAgentApi = ReturnType<typeof createBugAgentApi>;
export const bugAgentApi = createBugAgentApi((input, init) => fetch(input, init));
