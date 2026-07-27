/**
 * 服务端组合根：创建长生命周期依赖、挂载路由、监听端口并按顺序关闭资源。
 * 领域路由、聊天状态机、MCP 协议和 Store 规则都位于可独立测试的模块中。
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createChatOrchestrator } from './chat/chat-orchestrator.js';
import { createRouteMcpCaller } from './http-utils.js';
import { createMcpGateway } from './infrastructure/mcp-gateway.js';
import { createMcpSessionManager } from './infrastructure/mcp-session.js';
import { createChatQwenClient } from './infrastructure/qwen-client.js';
import { createMcpKnowledgeSearchAdapter } from './infrastructure/mcp-knowledge-search-adapter.js';
import { createKnowledgeStore } from './knowledge-store.js';
import { createBugInvestigationStore } from './bug-investigation/bug-investigation-store.js';
import { createBugInvestigationService } from './bug-investigation/bug-investigation-service.js';
import { loadPresets } from './preset-utils.js';
import { createResearchStore } from './research-store.js';
import { createResearchWorker } from './research-worker.js';
import { createChatRouter } from './routes/chat-routes.js';
import { createBugKnowledgeRouter } from './routes/bug-knowledge-routes.js';
import { createBugInvestigationRouter } from './routes/bug-investigation-routes.js';
import { createKnowledgeRouter } from './routes/knowledge-routes.js';
import { createMemoryRouter } from './routes/memory-routes.js';
import { createResearchRouter } from './routes/research-routes.js';
import { createSystemRouter } from './routes/system-routes.js';
import { createRunStore } from './run-store.js';
import { parsePricing } from './run-utils.js';
import {
  createResearchSearchService,
  normalizeKnowledgeBaseIds
} from './services/research-search-service.js';
import { createResearchAiService } from './services/research-ai-service.js';
import { createBugInvestigationAiService } from './services/bug-investigation-ai-service.js';
import { createResearchSourceReader } from './services/research-source-reader.js';
import { createResearchRepositoryResolver } from './services/research-repository-resolver.js';
import { createToolExecutor } from './tool-capabilities.js';

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
    args: [path.resolve(__dirname, './mcp-server.js')],
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
const researchStore = createResearchStore();
const bugInvestigationStore = createBugInvestigationStore();
const researchKnowledgeStore = createKnowledgeStore();
const researchKnowledgeSearch = createMcpKnowledgeSearchAdapter({ toolExecutor });
const researchSearchService = createResearchSearchService({
  searchEvidence: researchKnowledgeSearch.searchEvidence,
  toolExecutor
});
const researchAiService = createResearchAiService({
  // 研究任务的模型能力是可选增强；没有聊天模型配置时 Worker 会退回单问题、
  // 确定性证据报告，而不是把任务标成失败。
  qwenClient: config.apiKey ? qwenClient : null,
  model: config.model
});
const researchSourceReader = createResearchSourceReader();
const researchRepositoryResolver = createResearchRepositoryResolver();
const researchWorker = createResearchWorker({
  store: researchStore,
  searchSources: researchSearchService.searchSources,
  planResearch: researchAiService.planResearch,
  resolveResearchRepositories: researchRepositoryResolver.resolveRepositories,
  readResearchSources: researchSourceReader.readSelected,
  writeResearchReport: researchAiService.writeResearchReport
});
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

void researchWorker.resume().catch((error) => {
  console.error('[research] startup recovery failed:', error?.message || error);
});
const enqueueResearch = (id) => {
  void researchWorker.enqueue(id).catch((error) => {
    console.error(`[research] task ${id} could not start:`, error?.message || error);
  });
};

const app = createApp({
  systemRouter: createSystemRouter({
    presets: config.presets,
    runStore,
    callMcpTool
  }),
  researchRouter: createResearchRouter({
    researchStore,
    researchWorker,
    researchKnowledgeStore,
    enqueueResearch,
    normalizeKnowledgeBaseIds,
    webSearchConfigured: Boolean(
      process.env.BOCHA_API_KEY || (
        (process.env.RESEARCH_WEB_SEARCH_ENDPOINT || process.env.WEB_SEARCH_ENDPOINT) &&
        (process.env.RESEARCH_WEB_SEARCH_API_KEY || process.env.WEB_SEARCH_API_KEY)
      )
    )
  }),
  knowledgeRouter: createKnowledgeRouter({ callMcpTool }),
  bugKnowledgeRouter: createBugKnowledgeRouter({ callMcpTool: callBugMcpTool }),
  bugInvestigationRouter: createBugInvestigationRouter({ investigationService: bugInvestigationService }),
  memoryRouter: createMemoryRouter({ callMcpTool }),
  chatRouter: createChatRouter({ orchestrator: chatOrchestrator }),
  frontendDir: path.resolve(__dirname, '../dist')
});

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`Server running at http://${config.host}:${config.port}`);
});

async function shutdown(signal) {
  console.log(`[server] received ${signal}, shutting down`);
  httpServer.close();
  bugInvestigationStore.close();
  researchStore.close();
  await mcpSessionManager.close();
}

process.once('SIGINT', () => {
  shutdown('SIGINT').finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  shutdown('SIGTERM').finally(() => process.exit(0));
});
