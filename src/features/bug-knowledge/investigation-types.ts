export type BugEvidenceType =
  | 'error'
  | 'network'
  | 'test_failure'
  | 'code'
  | 'environment'
  | 'reproduction'
  | 'verification'
  | 'note';

export type BugInvestigationStatus = 'draft' | 'converted' | 'closed';
export type EvidenceQuality = 'pending' | 'sufficient' | 'limited' | 'insufficient';

export interface BugEvidenceInput {
  type: BugEvidenceType;
  content: string;
  metadata?: {
    fileName?: string;
    language?: string;
    lineStart?: number | null;
  };
}

export interface BugInvestigationDraftSeed {
  title?: string;
  evidence: BugEvidenceInput;
  sourceMessageId?: string;
  sourceSessionId?: string;
}

export interface BugEvidence extends BugEvidenceInput {
  id: string;
  redactions: Array<{ kind: string; count: number }>;
  metadata: {
    fileName: string;
    language: string;
    lineStart: number | null;
  };
  createdAt: number;
}

export interface BugInvestigationFacts {
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
}

export interface BugHypothesis {
  title: string;
  reasoning: string;
  /** grounding-v3 及更早数据兼容字段；新分析不再生成。 */
  falsification?: string;
  confidenceLabel: 'supported' | 'plausible' | 'weak';
  supportingEvidenceIds: string[];
  counterEvidenceIds: string[];
  relatedCaseIds: string[];
}

export interface BugVerificationStep {
  title: string;
  instruction: string;
  supportingSignal?: string;
  refutingSignal?: string;
  /** grounding-v3 及更早数据兼容字段。 */
  expectedSignal?: string;
}

export interface SimilarBugCase {
  id: string;
  title: string;
  symptom: string;
  scope: 'project' | 'common';
  sourceProjectRef: string;
  rootCause: string | null;
  fix: string;
  verification: string;
  matchedChannels: Array<'exact' | 'fts' | 'vector'>;
  rank: number;
  score: number;
}

export interface BugInvestigationAnalysis {
  policyVersion?: string;
  status: 'idle' | 'stale' | 'success' | 'degraded' | 'insufficient';
  evidenceQuality: EvidenceQuality;
  summary: string;
  hypotheses: BugHypothesis[];
  verificationSteps: BugVerificationStep[];
  missingEvidence: string[];
  nextAction?: {
    title: string;
    description: string;
    evidenceType: BugEvidenceType;
  } | null;
  similarCases: SimilarBugCase[];
  retrievalTrace: {
    degradedChannels: string[];
    ambiguous: boolean;
    evidenceGap: boolean;
  } | null;
  reasonCode: string;
}

export interface InvestigationRun {
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
}

export interface CandidateReadiness {
  ready: boolean;
  checks: Array<{
    key: string;
    label: string;
    passed: boolean;
  }>;
}

export interface BugInvestigation {
  id: string;
  projectRef: string;
  title: string;
  status: BugInvestigationStatus;
  evidence: BugEvidence[];
  facts: BugInvestigationFacts;
  analysis: BugInvestigationAnalysis;
  runs: InvestigationRun[];
  candidateReadiness: CandidateReadiness;
  candidateBugCaseId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BugInvestigationApi {
  fetchInvestigations(projectRef: string): Promise<BugInvestigation[]>;
  createInvestigation(input: {
    projectRef: string;
    title?: string;
    evidence: BugEvidenceInput;
  }): Promise<BugInvestigation>;
  appendEvidence(id: string, input: BugEvidenceInput): Promise<BugInvestigation>;
  analyzeInvestigation(id: string): Promise<BugInvestigation>;
  convertToCandidate(id: string): Promise<BugInvestigation>;
  closeInvestigation(id: string): Promise<BugInvestigation>;
}
