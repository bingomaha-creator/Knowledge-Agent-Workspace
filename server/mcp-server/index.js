/**
 * MCP Tool Runtime 的组合根。
 *
 * 这里仅创建长生命周期依赖、注册工具并连接 stdio。知识库与记忆规则位于 modules，
 * zod/MCP DTO 映射位于 register-*，因此导入领域模块本身不会打开数据库或连接网络。
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createEmbeddingQwenClient } from '../infrastructure/ai/qwen-client.js';
import { createKnowledgeStore } from '../modules/knowledge/store.js';
import { createBugKnowledgeService } from '../modules/bug-knowledge/service.js';
import { createMemoryStore } from '../modules/memory/store.js';
import { registerKnowledgeTools } from './register-knowledge-tools.js';
import { registerBugTools } from './register-bug-tools.js';
import { registerMemoryTools } from './register-memory-tools.js';
import { registerSystemTools } from './register-system-tools.js';
import { createKnowledgeIndexLifecycle } from '../modules/knowledge/index-lifecycle.js';
import { createKnowledgeService } from '../modules/knowledge/service.js';
import { createMemoryService } from '../modules/memory/service.js';
import { createWebSearchProvider } from '../infrastructure/web-search/provider.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

const config = {
  apiKey: process.env.QWEN_API_KEY,
  baseUrl: (
    process.env.QWEN_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1'
  ).replace(/\/$/, ''),
  embeddingModel: process.env.QWEN_EMBEDDING_MODEL || 'text-embedding-v3'
};

const embeddingClient = createEmbeddingQwenClient({
  apiKey: config.apiKey,
  baseUrl: config.baseUrl,
  model: config.embeddingModel
});
const knowledgeStore = createKnowledgeStore();
const memoryStore = createMemoryStore();
const webSearchProvider = createWebSearchProvider();
const knowledgeService = createKnowledgeService({
  store: knowledgeStore,
  embeddingClient,
  embeddingModel: config.embeddingModel
});
const knowledgeIndexLifecycle = createKnowledgeIndexLifecycle({
  store: knowledgeStore,
  embeddingClient
});
const bugKnowledgeService = createBugKnowledgeService({
  store: knowledgeStore,
  knowledgeRetrieval: knowledgeService
});
const memoryService = createMemoryService({
  store: memoryStore,
  embeddingClient,
  embeddingModel: config.embeddingModel
});

const server = new McpServer({
  name: 'yuan-agent-mcp-server',
  version: '1.0.0'
});
registerKnowledgeTools(server, { knowledgeService });
registerBugTools(server, { bugKnowledgeService });
registerMemoryTools(server, { memoryService });
registerSystemTools(server, { webSearchProvider });

const transport = new StdioServerTransport();
await server.connect(transport);

// Lifecycle 同时接管运行期入队通知与进程重启后的 queued/processing 恢复。
knowledgeIndexLifecycle.start();
