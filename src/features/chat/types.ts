import type { MemoryRecord, MemoryStatus } from '@/features/memory/types';

export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type MessageStatus = 'idle' | 'streaming' | 'done' | 'error';
export type ToolStatus = 'pending' | 'running' | 'success' | 'error';

export interface Citation {
  id: string;
  title: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  snippet: string;
  source: string;
  score?: number;
  headingPath?: string[];
  retrieval?: {
    sources?: string[];
    vectorRank?: number;
    keywordRank?: number;
    vectorScore?: number;
    bm25Score?: number;
    rrfScore?: number;
  };
}

export interface ToolInvocation {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  result?: string;
}

export type MemoryReviewStatus = MemoryStatus | 'saving' | 'error';

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  status: MessageStatus;
  citations?: Citation[];
  tools?: ToolInvocation[];
  memoryCandidate?: MemoryRecord;
  memoryStatus?: MemoryReviewStatus;
  run?: AgentRun;
}

export type RunStatus = 'running' | 'success' | 'error' | 'cancelled' | 'interrupted';
export type ContextPurpose = 'tool_planning' | 'answer_generation';
export type ContextKind =
  | 'system_rule'
  | 'current_user'
  | 'conversation_turn'
  | 'knowledge_chunk'
  | 'memory'
  | 'research_evidence'
  | 'tool_exchange'
  | 'few_shot';
export type ContextDecisionReason =
  | 'required'
  | 'conversation_continuity'
  | 'active_tool_chain'
  | 'relevant'
  | 'out_of_scope'
  | 'duplicate'
  | 'over_budget'
  | 'stale'
  | 'superseded'
  | 'invalid'
  | 'low_relevance';

export interface ContextManifest {
  schemaVersion: 1;
  buildId: string;
  purpose: ContextPurpose;
  policyVersion: string;
  estimatorVersion: string;
  profile: {
    id: string;
    contextWindowTokens: number;
    outputReserveTokens: number;
    safetyReserveTokens: number;
    inputBudgetTokens: number;
  };
  estimatedInputTokens: number;
  decisions: Array<{
    candidateId: string;
    kind: ContextKind;
    sourceRef: { id: string; parentId?: string };
    estimatedTokens: number;
    decision: 'included' | 'excluded';
    reason: ContextDecisionReason;
  }>;
  summary: {
    includedCount: number;
    excludedCount: number;
    includedByKind: Partial<Record<ContextKind, number>>;
    excludedByReason: Partial<Record<ContextDecisionReason, number>>;
  };
  warnings: string[];
}

export interface ContextSummary {
  buildId: string;
  purpose: ContextPurpose;
  profile: ContextManifest['profile'];
  estimatedInputTokens: number;
  summary: ContextManifest['summary'];
  warnings: string[];
}

export type KnowledgeEvidenceStatus = 'evidence' | 'evidence_gap' | 'unavailable';

export interface KnowledgeEvidenceTrace {
  policyVersion: string;
  status: KnowledgeEvidenceStatus;
  reason: 'hybrid_match' | 'lexical_match' | 'weak_candidates' | 'no_candidates' | 'retrieval_error';
  candidateCount: number;
  selectedCount: number;
  filteredCount: number;
  channels: {
    keywordCandidates: number;
    vectorOnlyCandidates: number;
    degradedChannels: string[];
  };
}

export interface AgentSpan {
  id: string;
  runId: string;
  parentId?: string | null;
  name: string;
  kind: string;
  status: RunStatus;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown> & {
    contextManifest?: ContextManifest;
    evidence?: KnowledgeEvidenceTrace;
  };
  startedAt: number;
  finishedAt?: number | null;
  durationMs?: number | null;
}

export interface AgentRun {
  id: string;
  conversationId: string;
  status: RunStatus;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown> & {
    contextSummary?: ContextSummary;
  };
  createdAt: number;
  updatedAt: number;
  finishedAt?: number | null;
  spans?: AgentSpan[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  knowledgeBaseIds: string[];
  presetId?: string;
  messages: ChatMessage[];
}

export interface AgentPreset {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  modelParameters: {
    temperature: number;
    topP?: number;
    maxTokens?: number;
  };
  toolWhitelist: string[];
  defaultKnowledgeBaseIds: string[];
  fewShot: Array<{ user: string; assistant: string }>;
}

export interface BackendStreamEvent {
  type: 'token' | 'tool' | 'citations' | 'memory_candidate' | 'run' | 'done' | 'error';
  token?: string;
  citations?: Citation[];
  memoryCandidate?: MemoryRecord;
  tool?: ToolInvocation;
  tools?: ToolInvocation[];
  run?: AgentRun;
  message?: string;
  details?: string;
  code?: string;
}

export interface ApiErrorPayload {
  error: string;
  details?: string;
  code?: string;
}

export interface QwenMessage {
  id?: string;
  role: Role;
  content: string;
}

/** The frozen request DTO sent to the existing chat streaming endpoint. */
export interface ChatStreamRequest {
  messages: QwenMessage[];
  hasKnowledge?: boolean;
  ragEnabled?: boolean;
  knowledgeBaseIds?: string[];
  conversationId?: string;
  sourceMessageIds?: string[];
  presetId?: string;
}

/** Chat's complete dependency on remote HTTP/SSE behavior. */
export interface ChatTransport {
  listPresets(): Promise<AgentPreset[]>;
  getRun(id: string): Promise<AgentRun>;
  stream(
    request: ChatStreamRequest,
    signal: AbortSignal
  ): AsyncIterable<BackendStreamEvent>;
}
