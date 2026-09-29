/**
 * 服务端组合根：创建长生命周期依赖、挂载路由、监听端口并按顺序关闭资源。
 * 领域路由、聊天状态机、MCP 协议和 Store 规则都位于可独立测试的模块中。
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createChatOrchestrator } from './modules/chat/orchestrator.js';
import { createChatService } from './modules/chat/service.js';
import { createChatStore } from './modules/chat/store.js';
import { createRouteMcpCaller } from './shared/http/utils.js';
import { createMcpGateway } from './infrastructure/mcp-client/gateway.js';
import { createMcpSessionManager } from './infrastructure/mcp-client/session.js';
import { createChatQwenClient } from './infrastructure/ai/qwen-client.js';
import { createMcpKnowledgeSearchAdapter } from './shared/retrieval/knowledge-search-adapter.js';
import { createKnowledgeStore } from './modules/knowledge/store.js';
import { createBugInvestigationStore } from './modules/bug-investigation/store.js';
import { createBugInvestigationService } from './modules/bug-investigation/service.js';
import { loadPresets } from './modules/chat/presets.js';
import { createResearchNewStore } from './modules/research-new/store.js';
import { readGraphScope } from './modules/research-new/graph-scope.js';
import { createResearchNewWorker } from './modules/research-new/worker.js';
import { createResearchSidecarClient } from './modules/research-new/sidecar-client.js';
import { createResearchNewSidecarWorker } from './modules/research-new/sidecar-worker.js';
import { createResearchNewAiService } from './modules/research-new/ai-service.js';
import { createResearchNewSearch } from './modules/research-new/acquisition/search.js';
import { createResearchNewSourceReader } from './modules/research-new/acquisition/source-readers.js';
import { createSafeHttpsReader } from './infrastructure/web-reading/safe-request.js';
import { createWebDocumentReader } from './infrastructure/web-reading/reader.js';
import { createTavilyWebSearchProvider } from './infrastructure/web-search/provider.js';
import { createChatRouter } from './modules/chat/routes.js';
import { createBugKnowledgeRouter } from './modules/bug-knowledge/routes.js';
import { createBugInvestigationRouter } from './modules/bug-investigation/routes.js';
import { createKnowledgeRouter } from './modules/knowledge/routes.js';
import { createMemoryRouter } from './modules/memory/routes.js';
import { createResearchNewRouter } from './modules/research-new/routes.js';
import { createSystemRouter } from './modules/system/routes.js';
import { createRunStore } from './modules/chat/run-store.js';
import { parsePricing } from './modules/chat/run-utils.js';
import { createBugInvestigationAiService } from './modules/bug-investigation/ai-analyzer.js';
import { createToolExecutor } from './shared/agent-tools/catalog.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const config = {
  apiKey: process.env.QWEN_API_KEY,
  baseUrl: (
    process.env.QWEN_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1'
  ).replace(/\/$/, ''),
  model: process.env.QWEN_MODEL || 'qwen-plus',
  contextWindowTokens: Math.max(
    8_192,
    Math.min(
      Number.isFinite(Number(process.env.QWEN_CONTEXT_WINDOW_TOKENS))
        ? Math.floor(Number(process.env.QWEN_CONTEXT_WINDOW_TOKENS))
        : 32_768,
      1_000_000
    )
  ),
  port: Number(process.env.PORT || process.env.SERVER_PORT || 8787),
  host: process.env.HOST || '127.0.0.1',
  pricing: parsePricing(process.env.QWEN_PRICING_JSON),
  presets: loadPresets(process.env.AGENT_PRESETS_JSON),
  modelRetries: Math.max(
    0,
    Math.min(
      Number.isFinite(Number(process.env.QWEN_MAX_RETRIES))
        ? Math.floor(Number(process.env.QWEN_MAX_RETRIES))
        : 1,
      2
    )
  )
};

const qwenClient = createChatQwenClient({
  apiKey: config.apiKey,
  baseUrl: config.baseUrl
});
const mcpSessionManager = createMcpSessionManager({
  clientInfo: {
    name: 'yuan-agent-chat-orchestrator',
    version: '1.0.0'
  },
  transportOptions: {
    command: process.execPath,
    args: [path.resolve(__dirname, './mcp-server/index.js')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'development'
    },
    stderr: 'pipe'
  }
});
const mcpGateway = createMcpGateway({ sessionManager: mcpSessionManager });
const toolExecutor = createToolExecutor({ gateway: mcpGateway });
const runStore = createRunStore();
const chatStore = createChatStore();
const researchNewStore = createResearchNewStore();
const bugInvestigationStore = createBugInvestigationStore();
const researchKnowledgeStore = createKnowledgeStore();
const researchKnowledgeSearch = createMcpKnowledgeSearchAdapter({ toolExecutor });
const researchNewWebSearchProvider = createTavilyWebSearchProvider();
const researchNewSearch = createResearchNewSearch({
  knowledgeSearch: researchKnowledgeSearch,
  webSearchProvider: researchNewWebSearchProvider
});
const researchNewSafeReader = createSafeHttpsReader();
const researchNewWebDocumentReader = createWebDocumentReader({ safeReader: researchNewSafeReader });
const researchNewSourceReader = createResearchNewSourceReader({
  safeReader: researchNewSafeReader,
  webDocumentReader: researchNewWebDocumentReader
});
const researchNewAiService = createResearchNewAiService({ qwenClient, model: config.model });
const researchNewEngine = process.env.RESEARCH_NEW_ENGINE === 'sidecar' ? 'sidecar' : 'node';
const researchNewNodeWorker = createResearchNewWorker({
  store: researchNewStore,
  search: researchNewSearch,
  sourceReader: researchNewSourceReader,
  aiService: researchNewAiService
});
const researchSidecarClient = createResearchSidecarClient({
  baseUrl: process.env.RESEARCH_SIDECAR_URL || 'http://127.0.0.1:8000/api/v1',
  timeoutMs: Number(process.env.RESEARCH_SIDECAR_TIMEOUT_MS) || 15_000
});
const researchNewSidecarWorker = createResearchNewSidecarWorker({
  store: researchNewStore,
  client: researchSidecarClient,
  pollMs: Number(process.env.RESEARCH_SIDECAR_POLL_MS) || 1_000
});
const researchNewWorkers = { node: researchNewNodeWorker, sidecar: researchNewSidecarWorker };
const researchNewWorker = {
  enqueue(id) {
    const run = researchNewStore.get(id);
    return researchNewWorkers[run?.diagnostics?.engine || researchNewEngine].enqueue(id);
  },
  cancel(id) {
    const run = researchNewStore.get(id);
    return researchNewWorkers[run?.diagnostics?.engine || researchNewEngine].cancel(id);
  },
  async resume() {
    await Promise.all([researchNewNodeWorker.resume(), researchNewSidecarWorker.resume()]);
  }
};
const callMcpTool = createRouteMcpCaller({ toolExecutor });
const callBugMcpTool = createRouteMcpCaller({ toolExecutor, caller: 'bug-ui' });
const bugInvestigationAiService = createBugInvestigationAiService({
  qwenClient: config.apiKey ? qwenClient : null,
  model: config.model
});
const bugInvestigationService = createBugInvestigationService({
  store: bugInvestigationStore,
  projectExists: async (projectRef) => {
    const result = await callBugMcpTool('list_bug_projects');
    return (result.projects || []).some((project) => project.projectRef === projectRef);
  },
  searchBugCases: (input) => callBugMcpTool('search_bug_cases', input),
  analyzeEvidence: bugInvestigationAiService.analyze,
  createBugCase: (input) => callBugMcpTool('create_bug_case', input)
});
const chatOrchestrator = createChatOrchestrator({
  qwenClient,
  mcpGateway,
  toolExecutor,
  runStore,
  presets: config.presets,
  model: config.model,
  pricing: config.pricing,
  modelRetries: config.modelRetries,
  contextWindowTokens: config.contextWindowTokens
});
const chatService = createChatService({
  store: chatStore,
  orchestrator: chatOrchestrator
});

void researchNewWorker.resume().catch((error) => {
  console.error('[research-new] startup recovery failed:', error?.message || error);
});

const app = createApp({
  systemRouter: createSystemRouter({
    presets: config.presets,
    runStore,
    callMcpTool
  }),
  researchNewRouter: createResearchNewRouter({
    store: researchNewStore,
    worker: researchNewWorker,
    knowledgeStore: researchKnowledgeStore,
    knowledgeSearch: researchKnowledgeSearch,
    graphScope: (ids) => readGraphScope(
      path.resolve(process.env.RESEARCH_GRAPH_MANIFEST || 'services/research-sidecar/data/current-graph.json'),
      researchKnowledgeStore, ids),
    modelConfigured: researchNewEngine === 'sidecar' || Boolean(config.apiKey),
    engine: researchNewEngine,
    webReaderTransport: researchNewEngine === 'sidecar'
      ? 'research_sidecar'
      : (researchNewWebSearchProvider.configured ? 'tavily_raw_content' : 'direct_pinned'),
    webSearchCapabilities: researchNewEngine === 'sidecar'
      ? { provider: 'research_sidecar', fullText: true, domainFilter: false, temporalFilter: false }
      : researchNewWebSearchProvider.capabilities,
    webSearchConfigured: researchNewEngine === 'sidecar' || researchNewWebSearchProvider.configured
  }),
  knowledgeRouter: createKnowledgeRouter({ callMcpTool }),
  bugKnowledgeRouter: createBugKnowledgeRouter({ callMcpTool: callBugMcpTool }),
  bugInvestigationRouter: createBugInvestigationRouter({ investigationService: bugInvestigationService }),
  memoryRouter: createMemoryRouter({
    callMcpTool,
    syncMemoryProjection: (id, memory) => chatStore.syncMemoryCandidateProjection(id, memory)
  }),
  chatRouter: createChatRouter({
    orchestrator: chatOrchestrator,
    chatService
  }),
  frontendDir: path.resolve(__dirname, '../apps/react/dist')
});

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`Server running at http://${config.host}:${config.port}`);
});

async function shutdown(signal) {
  console.log(`[server] received ${signal}, shutting down`);
  httpServer.close();
  chatStore.close();
  bugInvestigationStore.close();
  researchNewStore.close();
  researchKnowledgeStore.close();
  await mcpSessionManager.close();
}

process.once('SIGINT', () => {
  shutdown('SIGINT').finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  shutdown('SIGTERM').finally(() => process.exit(0));
});
