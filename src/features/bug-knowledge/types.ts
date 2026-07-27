export type BugResolutionType = 'root_cause_fix' | 'verified_workaround';
export type BugReviewStatus = 'candidate' | 'confirmed' | 'rejected';
export type BugProcessingStatus = 'queued' | 'processing' | 'ready' | 'failed';
export type BugScope = 'project' | 'common';

export interface BugContext {
  language: string;
  framework: string;
  versions: string[];
  module: string;
  environment: string;
}

export interface BugCaseDraft {
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
}

export type BugCasePatch = Partial<Omit<BugCaseDraft, 'sourceProjectRef'>>;

export interface BugCase extends BugCaseDraft {
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
}

export interface BugProject {
  projectRef: string;
  knowledgeBaseId: string;
  name: string;
  description: string;
  kind: 'project_bugs';
  bugCaseCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface BugCitation {
  id: string;
  documentId: string;
  knowledgeBaseId?: string;
  headingPath: string[];
  snippet: string;
  channel: 'fts' | 'vector';
  rank: number;
  bm25Score?: number;
  vectorScore?: number;
}

export interface BugSearchResult {
  bugCase: BugCase;
  rank: number;
  score: number;
  matchedChannels: Array<'exact' | 'fts' | 'vector'>;
  citations: BugCitation[];
}

export interface BugSearchFilters {
  language?: string;
  framework?: string;
  versions?: string[];
  tags?: string[];
}

export interface BugSearchRequest {
  query: string;
  projectRef: string;
  includeCommon: boolean;
  additionalProjectRefs: string[];
  filters: BugSearchFilters;
  topK: number;
}

export interface BugSearchResponse {
  results: BugSearchResult[];
  scope: {
    projectRefs: string[];
    knowledgeBaseIds: string[];
    includesCommon: boolean;
  };
  trace: {
    degradedChannels: string[];
    ambiguous: boolean;
    evidenceGap: boolean;
  };
}

export interface BugCaseListFilters {
  sourceProjectRef?: string;
  scope?: BugScope;
  reviewStatuses?: BugReviewStatus[];
  statuses?: BugProcessingStatus[];
  knowledgeBaseIds?: string[];
}

export interface BugKnowledgeApi {
  fetchProjects(): Promise<BugProject[]>;
  createProject(input: { name: string; description?: string }): Promise<BugProject>;
  updateProject(
    projectRef: string,
    patch: { name?: string; description?: string }
  ): Promise<BugProject>;
  fetchCases(filters?: BugCaseListFilters): Promise<BugCase[]>;
  createCase(input: BugCaseDraft): Promise<BugCase>;
  updateCase(id: string, patch: BugCasePatch): Promise<BugCase>;
  deleteCase(id: string): Promise<void>;
  reviewCase(
    id: string,
    review: { reviewStatus: 'confirmed' | 'rejected'; reviewReason: string }
  ): Promise<BugCase>;
  promoteCase(id: string): Promise<BugCase>;
  searchCases(input: BugSearchRequest): Promise<BugSearchResponse>;
}
