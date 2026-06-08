import dotenv from 'dotenv';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { rankKnowledgeChunks, tokenize } from './rag-utils.js';

// MCP Server 作为独立子进程启动时，也需要读取 Qwen API Key 和 embedding 模型配置。
// index.js 会通过 stdio 启动这个文件，但这里仍然要自己加载环境变量。
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

// 当前知识库是进程内存态：
// - documents 保存原始文档信息和全文
// - chunks 保存分块文本、分块 token 和 embedding
// 所以 mcp-server.js 进程重启后，知识库内容会丢失。
const state = {
  documents: [],
  chunks: []
};

// MCP Server 里主要用 Qwen 的 embedding 能力。
// 聊天模型请求在 server/index.js 中完成；这里负责向量化文档和查询。
const config = {
  apiKey: process.env.QWEN_API_KEY,
  baseUrl: (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
  embeddingModel: process.env.QWEN_EMBEDDING_MODEL || 'text-embedding-v3'
};

// 给 document/chunk 生成带前缀的唯一 id，方便前端和后端区分数据类型。
function uid(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

// 创建统一的业务错误对象。
// MCP 工具内部会把这类错误转成 toErrorContent 返回给 MCP Client。
function createAppError(code, message, details = '', status = 500) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}

// 把长文本切成带重叠的片段。
// overlap 的作用是避免重要上下文刚好被切断在两个 chunk 边界处。
function chunkText(text, chunkSize = 900, overlap = 160) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    const value = text.slice(start, end).trim();
    if (value) chunks.push(value);
    start += chunkSize - overlap;
  }
  return chunks;
}

// 计算两个 embedding 向量的余弦相似度。
// 结果越接近 1，说明两个向量方向越接近，文本语义越相似。
function cosineSimilarity(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < len; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// MCP Server 内部请求 Qwen 的统一封装。
// 这里主要用于 /embeddings，不负责聊天生成。
async function qwenFetch(endpoint, body) {
  if (!config.apiKey) {
    throw createAppError('MISSING_API_KEY', '缺少 Qwen API Key', '请检查服务端 `.env.local` 中的 `QWEN_API_KEY` 配置。', 500);
  }

  let response;
  try {
    // 这里是真正请求 Qwen OpenAI-Compatible API 的地方。
    response = await fetch(`${config.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body)
    });
  } catch {
    // 网络层无法连接时，返回更明确的业务错误。
    throw createAppError(
      'NETWORK_UNREACHABLE',
      '无法连接到 Qwen 服务',
      '当前运行环境访问 DashScope 失败。请检查网络、代理、VPN 或防火墙设置。',
      502
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 401) {
      throw createAppError('INVALID_API_KEY', 'Qwen API Key 无效或已过期', text || '请检查 `QWEN_API_KEY` 是否正确。', 401);
    }

    if (response.status === 429) {
      throw createAppError('RATE_LIMITED', 'Qwen 请求过于频繁', text || '请稍后重试，或检查账户配额是否充足。', 429);
    }

    throw createAppError('QWEN_HTTP_ERROR', `Qwen 请求失败（${response.status}）`, text || '上游模型服务返回异常响应。', 502);
  }

  return response.json();
}

// 为一段文本生成 embedding 向量。
// 文档导入时会对每个 chunk 调用；检索时会对用户 query 调用。
async function createEmbedding(text) {
  const result = await qwenFetch('/embeddings', {
    model: config.embeddingModel,
    // 限制输入长度，避免过长文本导致 embedding 接口失败或成本过高。
    input: text.slice(0, 6000)
  });

  const vector = result.data?.[0]?.embedding;
  if (!vector) {
    throw createAppError('EMBEDDING_EMPTY', 'Embedding 生成失败', '模型返回为空，无法建立向量索引。', 502);
  }

  return vector;
}

// 把内部 chunk 转成前端能展示的 citation。
// citation 是 RAG 命中的“参考来源”，最终会显示在 assistant 消息下方。
function buildCitation(chunk, score) {
  return {
    id: chunk.id,
    title: chunk.documentName,
    snippet: chunk.text,
    source: `向量知识库 / ${chunk.documentName}`,
    score: Number(score.toFixed(4))
  };
}

// 知识库检索主函数：
// 1. 给 query 生成 embedding
// 2. 每个 chunk 计算向量相似度
// 3. 交给 rankKnowledgeChunks 做向量分数 + 关键词分数混合排序
// 4. 转成 citations 返回
async function searchKnowledge(query, topK = 4) {
  if (!state.chunks.length) {
    return [];
  }

  const queryEmbedding = await createEmbedding(query);
  return rankKnowledgeChunks(
    query,
    state.chunks.map((chunk) => ({
      ...chunk,
      vectorScore: cosineSimilarity(queryEmbedding, chunk.embedding)
    })),
    topK
  ).map((chunk) => buildCitation(chunk, chunk.score));
}

// 导入文档并建立向量索引。
// Express 上传文件后，会通过 MCP 工具 ingest_knowledge_documents 调到这里。
async function ingestDocuments(documents) {
  // 当前只支持文本类知识文件。
  const supported = documents.filter((document) => /\.(txt|md|markdown|json)$/i.test(document.name));

  if (!supported.length) {
    throw createAppError('UNSUPPORTED_FILES', '没有可导入的知识文件', '仅支持 `.md`、`.markdown`、`.txt`、`.json` 文件。', 400);
  }

  const inserted = [];
  const nextDocuments = [];
  const nextChunks = [];

  for (const source of supported) {
    const content = source.content.trim();
    if (!content) continue;

    const document = {
      id: uid('doc'),
      name: source.name,
      content,
      createdAt: Date.now()
    };

    // nextDocuments / nextChunks 先临时收集。
    // 只有整个导入过程成功后，最后才 push 到全局 state，避免半成品写入。
    nextDocuments.push(document);
    // inserted 返回给前端，只包含元信息，不把全文 content 返回给浏览器。
    inserted.push({ id: document.id, name: document.name, createdAt: document.createdAt });

    // 一个文档会被拆成多个 chunk，每个 chunk 单独生成 embedding。
    const parts = chunkText(content);
    for (const part of parts) {
      const embedding = await createEmbedding(part);
      nextChunks.push({
        id: uid('chunk'),
        documentId: document.id,
        documentName: document.name,
        text: part,
        tokens: tokenize(part),
        embedding
      });
    }
  }

  if (!inserted.length) {
    throw createAppError('EMPTY_FILES', '上传的文件内容为空', '请确认文件不是空文件，且编码为 UTF-8。', 400);
  }

  // 真正写入内存知识库。
  state.documents.push(...nextDocuments);
  state.chunks.push(...nextChunks);

  return inserted;
}

// 返回文档元信息列表。
// 不返回 content，避免把完整知识库内容直接暴露给前端。
function listDocuments() {
  return state.documents.map((document) => ({
    id: document.id,
    name: document.name,
    createdAt: document.createdAt
  }));
}

// 删除指定文档，同时删除该文档对应的所有 chunks。
function deleteDocument(id) {
  const before = state.documents.length;
  state.documents = state.documents.filter((document) => document.id !== id);
  state.chunks = state.chunks.filter((chunk) => chunk.documentId !== id);

  if (before === state.documents.length) {
    throw createAppError('DOCUMENT_NOT_FOUND', '知识文件不存在', '请确认传入的文档 ID 是否正确。', 404);
  }

  return { ok: true, id };
}

// 清空内存知识库。
function clearDocuments() {
  state.documents = [];
  state.chunks = [];
  return { ok: true };
}

// MCP 工具成功返回格式：
// - content: 给人类/前端工具卡片看的文本
// - structuredContent: 给程序继续处理的结构化数据
function toTextContent(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: value
  };
}

// MCP 工具失败返回格式。
// 注意这里不是 throw 给 MCP Client，而是返回 isError=true 的工具结果。
function toErrorContent(error) {
  return {
    content: [
      {
        type: 'text',
        text: error.details ? `${error.message}\n${error.details}` : error.message
      }
    ],
    structuredContent: {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message,
      details: error.details || ''
    },
    isError: true
  };
}

// 创建 MCP Server 实例。
// server/index.js 会作为 MCP Client，通过 stdio 连接到这个 server。
const server = new McpServer({
  name: 'yuan-agent-mcp-server',
  version: '1.0.0'
});

// 工具 1：知识库检索。
// 这是 RAG 的核心工具，Express 的自动 RAG 和模型自主工具调用都可能调用它。
server.registerTool(
  'retrieve_knowledge',
  {
    description: '从后端向量知识库检索与用户问题最相关的文档片段',
    // zod schema 会变成 MCP 工具的输入 schema，也会被 index.js 转成 Qwen tools 参数。
    inputSchema: z.object({
      query: z.string().min(1, 'query 不能为空'),
      topK: z.number().int().min(1).max(10).optional()
    })
  },
  async ({ query, topK = 4 }) => {
    try {
      const citations = await searchKnowledge(query, topK);
      return toTextContent({ citations, count: citations.length });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

// 工具 2：列出知识库文档。
// 前端刷新文档列表、健康检查都会间接调用它。
server.registerTool(
  'list_knowledge_documents',
  {
    description: '列出当前后端知识库中的文档',
    inputSchema: z.object({})
  },
  async () => toTextContent({ documents: listDocuments() })
);

// 工具 3：导入知识库文档。
// Express 先用 multer 读取上传文件，再通过这个 MCP 工具把文本导入内存知识库。
server.registerTool(
  'ingest_knowledge_documents',
  {
    description: '导入知识文档到向量知识库中并建立向量索引',
    inputSchema: z.object({
      documents: z.array(
        z.object({
          name: z.string().min(1, 'name 不能为空'),
          content: z.string().min(1, 'content 不能为空')
        })
      ).min(1, '至少导入一份文档')
    })
  },
  async ({ documents }) => {
    try {
      const inserted = await ingestDocuments(documents);
      return toTextContent({ documents: inserted, message: `已成功导入 ${inserted.length} 份知识文件。` });
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

// 工具 4：删除指定知识文档。
server.registerTool(
  'delete_knowledge_document',
  {
    description: '删除指定的知识文档以及对应的向量索引',
    inputSchema: z.object({
      id: z.string().min(1, 'id 不能为空')
    })
  },
  async ({ id }) => {
    try {
      return toTextContent(deleteDocument(id));
    } catch (error) {
      return toErrorContent(error);
    }
  }
);

// 工具 5：清空知识库。
server.registerTool(
  'clear_knowledge_documents',
  {
    description: '清空知识库中的所有文档与向量索引',
    inputSchema: z.object({})
  },
  async () => toTextContent(clearDocuments())
);

// 工具 6：获取当前时间。
// 这个工具和 RAG 无关，用来展示 MCP 可以暴露任意后端能力。
server.registerTool(
  'get_current_time',
  {
    description: '获取当前系统时间',
    inputSchema: z.object({})
  },
  async () =>
    toTextContent({
      iso: new Date().toISOString(),
      locale: new Date().toLocaleString('zh-CN', { hour12: false })
    })
  );

// 使用 stdio transport 启动 MCP 协议通信。
// index.js 中的 StdioClientTransport 会连接到这里。
const transport = new StdioServerTransport();
await server.connect(transport);
