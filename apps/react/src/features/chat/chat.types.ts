export type ChatMessageRole = 'user' | 'assistant';
export type ChatMessageStatus = 'streaming' | 'done' | 'error' | 'cancelled' | 'interrupted';
export type ChatToolStatus = 'pending' | 'running' | 'success' | 'error';

export type ChatCitation = {
  id: string;
  title: string;
  snippet: string;
  source: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  score?: number;
  headingPath?: string[];
  retrieval?: Record<string, unknown>;
};

export type ChatToolInvocation = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ChatToolStatus;
  result?: unknown;
};

export type ChatMemoryCandidate = Record<string, unknown> & {
  id?: string;
};

export type AgentRun = Record<string, unknown> & {
  id: string;
  status: 'running' | 'success' | 'error' | 'cancelled' | 'interrupted';
};

export type ChatSession = {
  id: string;
  title: string;
  presetId: string;
  ragEnabled: boolean;
  knowledgeBaseIds: string[];
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

export type ChatMessage = {
  id: string;
  sessionId: string;
  sequenceNo: number;
  requestId: string;
  role: ChatMessageRole;
  content: string;
  status: ChatMessageStatus;
  citations: ChatCitation[];
  tools: ChatToolInvocation[];
  memoryCandidate: ChatMemoryCandidate | null;
  runId: string | null;
  errorCode: string;
  errorMessage: string;
  createdAt: number;
  updatedAt: number;
};

export type ChatMessagePage = {
  messages: ChatMessage[];
  nextCursor: number | null;
};

export type ChatAccepted = {
  reused: boolean;
  session: ChatSession;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
};

export type ChatProtocolError = {
  code: string;
  message: string;
  details: string;
};

export type ChatStreamEvent =
  | { type: 'accepted'; accepted: ChatAccepted }
  | { type: 'token'; token: string }
  | { type: 'tool'; tool: ChatToolInvocation }
  | { type: 'citations'; citations: ChatCitation[] }
  | { type: 'memory_candidate'; memoryCandidate: ChatMemoryCandidate }
  | { type: 'run'; run: AgentRun }
  | {
      type: 'error';
      error: ChatProtocolError;
      message?: ChatMessage;
    }
  | {
      type: 'done';
      message: ChatMessage;
      citations: ChatCitation[];
      tools: ChatToolInvocation[];
      run: AgentRun | null;
    };

export type OpenChatReplyInput = {
  requestId: string;
  content: string;
  sessionId?: string;
  presetId?: string;
  ragEnabled?: boolean;
  knowledgeBaseIds?: string[];
};

export type UpdateChatSessionInput = Partial<Pick<
  ChatSession,
  'presetId' | 'ragEnabled' | 'knowledgeBaseIds'
>>;

export type AgentPreset = {
  id: string;
  name: string;
  description: string;
  defaultKnowledgeBaseIds: string[];
  [key: string]: unknown;
};
