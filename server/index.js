/**
 * 服务端组合根：创建长生命周期依赖、挂载路由、监听端口并按顺序关闭资源。
 * 领域路由、聊天状态机、MCP 协议和 Store 规则都位于可独立测试的模块中。
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createBugReviewRouter } from './modules/bug-review/routes.js';
import { createBugReviewClient } from './modules/bug-review/sidecar-client.js';
import { createChatOrchestrator } from './modules/chat/orchestrator.js';
import { createChatService } from './modules/chat/service.js';
import { createChatStore } from './modules/chat/store.js';
import { createRouteMcpCaller } from './shared/http/utils.js';
import { createMcpGateway } from './infrastructure/mcp-client/gateway.js';
import { createMcpSessionManager } from './infrastructure/mcp-client/session.js';
import { createChatQwenClient } from './infrastructure/ai/qwen-client.js';
import { createMcpKnowledgeSearchAdapter } from './shared/retrieval/knowledge-search-adapter.js';
import { createKnowledgeStore } from './modules/knowledge/store.js';
import { loadPresets } from './modules/chat/presets.js';
import { createResearchNewStore } from './modules/research-new/store.js';
import { readGraphScope } from './modules/research-new/graph-scope.js';
import { createResearchSidecarClient } from './modules/research-new/sidecar-client.js';
import { createResearchNewSidecarWorker } from './modules/research-new/sidecar-worker.js';
import { createChatRouter } from './modules/chat/routes.js';
import { createKnowledgeRouter } from './modules/knowledge/routes.js';
import { createMemoryRouter } from './modules/memory/routes.js';
import { createResearchNewRouter } from './modules/research-new/routes.js';
import { createSystemRouter } from './modules/system/routes.js';
import { createRunStore } from './modules/chat/run-store.js';
import { parsePricing } from './modules/chat/run-utils.js';
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
const researchKnowledgeStore = createKnowledgeStore();
const researchKnowledgeSearch = createMcpKnowledgeSearchAdapter({ toolExecutor });
const researchSidecarClient = createResearchSidecarClient({
  baseUrl: process.env.RESEARCH_SIDECAR_URL || 'http://127.0.0.1:8000/api/v1',
  timeoutMs: Number(process.env.RESEARCH_SIDECAR_TIMEOUT_MS) || 15_000
});
const researchNewWorker = createResearchNewSidecarWorker({
  store: researchNewStore,
  client: researchSidecarClient,
  pollMs: Number(process.env.RESEARCH_SIDECAR_POLL_MS) || 1_000
});
const callMcpTool = createRouteMcpCaller({ toolExecutor });
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
  orchestrator: chatOrchestrator,
  listMemories: async (filters) => {
    const result = await callMcpTool('list_memories', filters, { fallbackMessage: '恢复历史记忆候选失败' });
    return result.memories;
  }
});

await chatService.recoverMemoryProjections();

void researchNewWorker.resume().catch((error) => {
  console.error('[research-new] startup recovery failed:', error?.message || error);
});

const app = createApp({
  bugReviewRouter: createBugReviewRouter({ client: createBugReviewClient() }),
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
    modelConfigured: true,
    engine: 'sidecar',
    webReaderTransport: 'research_sidecar',
    webSearchCapabilities: { provider: 'research_sidecar', fullText: true, domainFilter: false, temporalFilter: false },
    webSearchConfigured: true
  }),
  knowledgeRouter: createKnowledgeRouter({ callMcpTool }),
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
