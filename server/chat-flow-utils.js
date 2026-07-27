/**
 * 聊天编排的纯函数层。
 *
 * 这里不访问网络和数据库，专门回答“是否自动检索、模型能看哪些工具、消息如何补回、
 * 引用如何合并”等决策问题。把这些规则从 Express 路由抽出后，可以用单元测试直接
 * 验证安全边界，而不必启动模型或 MCP 子进程。
 */
import { evaluateToolCall, filterTools } from './tool-capabilities.js';

// 模型产生 tool_calls 后，OpenAI-compatible 协议要求先保留这条 assistant 消息，
// 后续 role=tool 才能通过 tool_call_id 与它对应；只保存 tool calls，不保存规划草稿正文。
export function appendToolPlanningChoice(messages, choice, toolCalls) {
  if (!toolCalls.length) {
    return false;
  }

  messages.push({
    role: 'assistant',
    content: choice?.content || '',
    tool_calls: toolCalls
  });

  return true;
}

export function getLatestUserContent(messages) {
  return [...messages].reverse().find((message) => message?.role === 'user' && message.content?.trim())?.content.trim() || '';
}

const KNOWLEDGE_INTENT_PATTERNS = [
  /(知识库|项目文档|项目资料|readme)/i,
  /(根据|按照|结合|参考|基于).{0,12}(文档|资料|文件|知识库)/i,
  /(文档|资料|文件|知识库).{0,12}(中|里|内|提到|说明|写了|查询|检索|查找)/i,
  /上传(?:过|的)?(?:文档|资料|文件)/i
];

// 保留该识别器，用于回答中需要明确“资料未覆盖”时的措辞；它不再决定是否执行检索。
export function hasExplicitKnowledgeIntent(query) {
  const text = typeof query === 'string' ? query.trim() : '';
  return Boolean(text && KNOWLEDGE_INTENT_PATTERNS.some((pattern) => pattern.test(text)));
}

export function createAutoRetrieveToolCall(query, knowledgeBaseIds = []) {
  const args = { query, topK: 4 };
  if (Array.isArray(knowledgeBaseIds) && knowledgeBaseIds.length) {
    args.knowledgeBaseIds = knowledgeBaseIds;
  }

  return {
    id: 'auto-retrieve-knowledge',
    type: 'function',
    function: {
      name: 'retrieve_knowledge',
      arguments: JSON.stringify(args)
    }
  };
}

export function getModelVisibleTools(tools, { ragEnabled = true } = {}) {
  return filterTools(tools, {
    caller: 'chat',
    invocation: 'autonomous',
    knowledgeScopeEnabled: ragEnabled
  });
}

export function getPresetVisibleTools(
  tools,
  { knowledgeScopeEnabled = true, toolWhitelist = [] } = {}
) {
  return filterTools(tools, {
    caller: 'chat',
    invocation: 'autonomous',
    knowledgeScopeEnabled,
    allowedToolNames: new Set(Array.isArray(toolWhitelist) ? toolWhitelist : [])
  });
}

export function isToolExecutionAllowed(
  name,
  allowedToolNames,
  context = { caller: 'chat', invocation: 'autonomous' }
) {
  return evaluateToolCall(name, { ...context, allowedToolNames }).allowed;
}

export function mergeCitations(current, incoming) {
  // chunk id 是引用身份；同一 chunk 被多轮工具命中时保留分数更高的版本，
  // 避免前端重复展示，同时不因后来的弱命中覆盖较完整的检索信息。
  const byId = new Map(current.map((citation) => [citation.id, citation]));
  for (const citation of incoming) {
    const existing = byId.get(citation.id);
    if (!existing || (citation.score ?? -Infinity) > (existing.score ?? -Infinity)) {
      byId.set(citation.id, citation);
    }
  }
  return [...byId.values()];
}
