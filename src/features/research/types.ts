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

export type ResearchResultQuality =
  | 'pending'
  | 'sufficient'
  | 'limited'
  | 'insufficient';

export interface ResearchLimitation {
  code: string;
  message: string;
}

export interface ResearchContinuationContext {
  originQuestion: string;
  parent: {
    taskId: string;
    question: string;
    reportExcerpt: string;
    resultQuality: string;
    limitations: ResearchLimitation[];
  };
  citations: Array<{
    id: string;
    title: string;
    snippet: string;
    url?: string;
    kind: 'local' | 'web';
    sourceKind?: string;
    originTaskId: string;
  }>;
}

export interface ResearchCapabilities {
  localKnowledge: boolean;
  publicPrimarySearch: {
    available: boolean;
    role: 'supplemental';
  };
}

export interface ResearchCitation {
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
  sourceKind?: 'project_knowledge' | 'official_docs' | 'official_repo' | 'paper' | 'standard' | 'public_web' | string;
  sourceType?: 'project_knowledge' | 'repository' | 'documentation' | 'paper' | 'standard' | 'web_page' | string;
  provenance?: 'verified_primary' | 'candidate_primary' | 'secondary' | 'unknown' | string;
  providerRank?: number;
  sourceDomain?: string;
  publishedAt?: string;
  score?: number;
  queries?: string[];
  retrieval?: {
    vectorScore?: number;
    lexicalScore?: number;
    bm25Score?: number;
    rrfScore?: number;
    sources?: string[];
  };
}

export interface ResearchArtifacts {
  subquestions?: string[];
  plan?: {
    schemaVersion?: number;
    objective: string;
    planner: 'model' | 'direct' | 'fallback' | string;
    fallbackReason?: string;
    diagnostics?: ResearchStageDiagnostics | null;
    subquestionCount?: number;
    knowledgeBaseIds?: string[];
    searchMode?: ResearchSearchMode;
    evidencePolicy?: {
      id: 'general_research' | 'project_diagnosis' | 'local_only' | string;
      label: string;
      sourcePriority: Array<'local' | 'web'>;
      maxLocalSources: number;
      maxSourcesPerDocument: number;
      maxEvidencePerSubquestion: number;
    };
    subquestions: Array<{
      id: string;
      subject?: string;
      question: string;
      searchQuery: string;
      intent: string;
      facets?: string[];
      evidenceNeed?: {
        preferredSourceTypes?: string[];
        freshness?: 'current' | 'historical' | 'any' | string;
      };
      rationale: string;
    }>;
  };
  search?: {
    mode: ResearchSearchMode;
    queries: Array<{
      id: string;
      question: string;
      searchQuery: string;
      intent: string;
      subject?: string;
      facets?: string[];
      evidenceNeed?: {
        preferredSourceTypes?: string[];
        freshness?: string;
      } | null;
    }>;
    webSearchStatus: ResearchWebSearchStatus;
    diagnostics?: Array<{
      id: string;
      query: string;
      durationMs: number;
      sourceCount: number;
      status: 'success' | 'degraded' | string;
    }>;
  };
  sources?: ResearchCitation[];
  excludedSources?: Array<{
    id: string;
    title: string;
    kind: 'local' | 'web';
    reason: 'low_relevance' | string;
    relevance?: {
      lexicalCoverage: number;
      vectorScore: number | null;
    };
  }>;
  evidence?: Array<{
    citationId: string;
    citationNumber?: number;
    claim: string;
    snippet: string;
    passage?: string;
    source?: string;
    sourceId?: string;
    queries?: string[];
  }>;
  evidencePack?: {
    candidateCount: number;
    acceptedCount: number;
    excludedCount: number;
    includedCount: number;
    citationCount?: number;
    readSourceCount?: number;
    passageCount?: number;
    totalCharacters?: number;
    snippetFallbackCount?: number;
    exclusionReasons: string[];
    policy?: string;
    policyLabel?: string;
    selectionExcluded?: Array<{
      id: string;
      title: string;
      kind: 'local' | 'web';
      reason: string;
    }>;
  };
  writer?: {
    mode: 'model' | 'fallback' | string;
    status?: 'success' | 'degraded' | string;
    reasonCode?: string;
    fallbackReason?: string;
    durationMs?: number;
    evidenceCount?: number;
    evidenceCharacters?: number;
    inputTokens?: number;
    outputTokens?: number;
    outputCharacters?: number;
    finishReason?: string;
  };
  reading?: {
    selectedSourceCount?: number;
    readSourceCount?: number;
    failedSourceCount?: number;
    durationMs?: number;
    failures?: Array<{
      sourceId: string;
      code: string;
      message: string;
    }>;
  };
  diagnostics?: {
    planning?: ResearchStageDiagnostics | null;
    retrieval?: Array<{
      id: string;
      query: string;
      durationMs: number;
      sourceCount: number;
      status: string;
    }>;
    reading?: ResearchArtifacts['reading'] | null;
    writing?: ResearchArtifacts['writer'] | null;
  };
  outline?: Array<{
    id?: string;
    title?: string;
    heading?: string;
    purpose?: string;
    question?: string;
  }>;
  sections?: Array<{
    id?: string;
    title?: string;
    heading?: string;
    question?: string;
    content: string;
    citationNumbers?: number[];
  }>;
  verification?: {
    valid: boolean;
    referencedCitationIds?: string[];
    missingCitationIds?: string[];
    invalidCitationNumbers?: number[];
    invalidCitationMarkers?: string[];
    unreferencedCitationIds?: string[];
  };
  quality?: {
    quality: ResearchResultQuality;
    limitations: ResearchLimitation[];
    metrics: {
      relevantEvidenceCount: number;
      excludedEvidenceCount: number;
      unverifiedPublicSourceCount: number;
      evidenceCharacters?: number;
      coveredSubquestionCount: number;
      totalSubquestionCount: number;
      coverageRatio: number;
      citationStructureValid: boolean;
    };
  };
  [key: string]: unknown;
}

export interface ResearchStageDiagnostics {
  mode?: string;
  status?: string;
  reasonCode?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ResearchTask {
  id: string;
  question: string;
  status: ResearchTaskStatus;
  stage: ResearchStage;
  progress: number;
  error?: string;
  failedStage?: ResearchStage | '';
  report?: string;
  citations: ResearchCitation[];
  knowledgeBaseIds: string[];
  searchMode: ResearchSearchMode;
  webSearchStatus: ResearchWebSearchStatus;
  resultQuality: ResearchResultQuality;
  limitations: ResearchLimitation[];
  attempt: number;
  cancelRequested?: boolean;
  sessionId: string;
  parentTaskId: string;
  turnIndex: number;
  continuationContext?: ResearchContinuationContext | null;
  artifacts?: ResearchArtifacts;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export interface ResearchDraftSeed {
  question?: string;
  searchMode?: ResearchSearchMode;
  knowledgeBaseIds?: string[];
  sourceSessionId?: string;
  sourceMessageId?: string;
}

export interface ResearchDraft {
  question: string;
  searchMode: ResearchSearchMode;
  knowledgeBaseIds: string[];
  sourceSessionId?: string;
  sourceMessageId?: string;
  status: 'editing' | 'submitting' | 'submitted';
}

export interface CreateResearchInput {
  question: string;
  searchMode: ResearchSearchMode;
  knowledgeBaseIds: string[];
}

export interface ContinueResearchInput {
  question: string;
  searchMode?: ResearchSearchMode;
  knowledgeBaseIds?: string[];
}

export interface ResearchApi {
  getCapabilities(): Promise<ResearchCapabilities>;
  listTasks(): Promise<ResearchTask[]>;
  getTask(id: string): Promise<ResearchTask>;
  getSession(id: string): Promise<ResearchTask[]>;
  createTask(input: CreateResearchInput): Promise<{ task: ResearchTask; notice?: string }>;
  continueTask(id: string, input: ContinueResearchInput): Promise<{ task: ResearchTask; notice?: string }>;
  cancelTask(id: string): Promise<ResearchTask>;
  retryTask(id: string): Promise<ResearchTask>;
}
