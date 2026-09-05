/**
 * 可注入的聊天编排状态机（ChatOrchestrator）。
 *
 * 它只理解请求 DTO、领域事件、模型/MCP 和 run/span，不依赖 Express 或 HTTP Response。
 * Router 把连接关闭转换为 AbortSignal，并把这里发出的事件编码为 SSE。
 */
import {
  appendToolPlanningChoice,
  createAutoRetrieveToolCall,
  getPresetVisibleTools,
  getLatestUserContent,
  hasExplicitKnowledgeIntent,
  mergeCitations,
} from "../chat-flow-utils.js";
import {
  describeKnowledgeEvidence,
  resolveChatKnowledgeEvidence,
  shouldResolveScopedKnowledge,
} from './chat-evidence-resolver.js';
import {
  buildMemoryCandidatePrompt,
  buildMemoryContext,
  parseMemoryCandidateResponse,
  shouldSuggestMemoryCandidate,
} from "../memory-utils.js";
import { buildContext } from '../context-builder.js';
import { drainSseData } from "../sse-utils.js";
import { estimateCost, normalizeUsage, shouldRetryModelError } from "../run-utils.js";
import {
  resolvePreset,
  resolvePresetKnowledgeScope,
} from "../preset-utils.js";
import { createAppError, getErrorPayload } from '../http-utils.js';
import {
  applyTrustedToolArguments,
} from '../tool-capabilities.js';

export function createChatOrchestrator({
  qwenClient,
  mcpGateway,
  toolExecutor,
  runStore,
  presets,
  model,
  pricing,
  modelRetries = 1,
  contextWindowTokens = 32_768,
  contextSafetyReserveTokens = 2_048,
  candidateTimeoutMs = 8_000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger = console,
}) {
const config = {
  model,
  pricing,
  modelRetries,
  presets,
  contextWindowTokens,
  contextSafetyReserveTokens
};

// 不同边界对取消的表达不同：fetch 常抛 AbortError，MCP 工具返回业务 code，
// 调用方则通过 signal 传入取消状态。先统一识别，再由下一个函数统一成业务错误。
function isRequestCancellation(error, signal) {
  return Boolean(
    signal?.aborted ||
    error?.code === "REQUEST_ABORTED" ||
    error?.name === "AbortError",
  );
}

// 统一为 REQUEST_ABORTED 很重要：否则 DOMException 的数字 code（常见为 20）会进入数据库，
// 前端时间线和后续统计就无法把同一种用户行为归到同一类错误。
function normalizeRequestCancellation(error) {
  if (error?.code === "REQUEST_ABORTED") {
    return error;
  }
  return createAppError(
    "REQUEST_ABORTED",
    "请求已取消",
    "客户端已停止本次操作。",
    499,
  );
}

/**
 * 为一次聊天创建轻量 tracer，并同时承担两件事：
 * 1. 每次 span/run 更新都先写 SQLite，刷新或重启后仍可查询；
 * 2. 写完后向当前 SSE 连接发 `run` 快照，让时间线实时刷新。
 *
 * 不变量：finishRun 只能生效一次；结束 run 时必须把所有遗留 running span 一并收敛，
 * 否则 UI 会永久显示“执行中”。
 */
function createRunTracer({ conversationId, emit }) {
  const run = runStore.startRun({ conversationId, model: config.model });
  let terminal = false;
  const emitRun = () => {
    emit({ type: 'run', data: { run: runStore.getRunWithSpans(run.id) } });
  };
  emitRun();
  return {
    runId: run.id,
    start(name, kind, metadata = {}) {
      const span = runStore.startSpan(run.id, {
        name,
        kind,
        model: kind === 'model' || kind === 'retry' ? config.model : '',
        metadata
      });
      emitRun();
      return span;
    },
    finish(span, patch = {}) {
      if (!span) return null;
      const finished = runStore.finishSpan(span.id, patch);
      emitRun();
      return finished;
    },
    fail(span, error) {
      const payload = getErrorPayload(error, '执行失败');
      return this.finish(span, {
        status: 'error',
        errorCode: payload.code,
        errorMessage: payload.message
      });
    },
    cancel(span, error) {
      const payload = getErrorPayload(
        normalizeRequestCancellation(error),
        '请求已取消',
      );
      return this.finish(span, {
        status: 'cancelled',
        errorCode: payload.code,
        errorMessage: payload.message,
      });
    },
    finishRun(status = 'success', error, metadata = {}) {
      if (terminal) return runStore.getRunWithSpans(run.id);
      terminal = true;
      const payload = error ? getErrorPayload(error, '服务异常') : {};
      for (const span of runStore.listSpans(run.id).filter((item) => item.status === 'running')) {
        runStore.finishSpan(span.id, {
          status: status === 'cancelled' ? 'cancelled' : 'error',
          errorCode: payload.code || (status === 'cancelled' ? 'REQUEST_ABORTED' : 'RUN_TERMINATED'),
          errorMessage: payload.message || (status === 'cancelled' ? '请求已取消' : 'Run 提前终止')
        });
      }
      const finished = runStore.finishRun(run.id, {
        status,
        errorCode: payload.code || '',
        errorMessage: payload.message || '',
        metadata
      });
      emitRun();
      return runStore.getRunWithSpans(finished.id);
    }
  };
}

/**
 * 给一次模型尝试包裹 span，并只对瞬时错误做有限重试。
 * 非流式请求在这里即可取得 usage 并结束 span；流式请求只返回上游响应，真正的
 * generation span 要等调用方读到 `[DONE]` 后才算成功，不能在收到响应头时提前结束。
 */
async function tracedModelCall(tracer, name, body, stream, signal, metadata = {}) {
  const attempts = config.modelRetries + 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const span = tracer.start(
      name,
      attempt === 1 ? 'model' : 'retry',
      { stream, attempt, maxAttempts: attempts, ...metadata },
    );
    try {
      const result = await qwenClient.chatCompletions(body, { stream, signal });
      if (!stream) {
        const usage = normalizeUsage(result.usage);
        tracer.finish(span, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          estimatedCost: estimateCost(body.model, result.usage, config.pricing)
        });
      }
      return { result, span };
    } catch (error) {
      if (signal?.aborted || error?.code === 'REQUEST_ABORTED') {
        const payload = getErrorPayload(error, '请求已取消');
        tracer.finish(span, {
          status: 'cancelled',
          errorCode: payload.code,
          errorMessage: payload.message,
        });
      } else {
        tracer.fail(span, error);
      }
      if (attempt >= attempts || !shouldRetryModelError(error) || signal?.aborted) throw error;
      await sleep(Math.min(250 * attempt, 500));
    }
  }
  throw createAppError('MODEL_RETRY_EXHAUSTED', '模型重试已耗尽', '', 502);
}

// 适合 MCP 连接、工具发现、范围检查等普通异步步骤。
// 它把“业务代码抛异常”和“span 必须进入终态”绑定在一起，调用者无需重复记账。
async function tracedStep(
  tracer,
  name,
  kind,
  operation,
  metadata = {},
  signal,
) {
  const span = tracer.start(name, kind, metadata);
  try {
    const result = await operation();
    tracer.finish(span, { status: 'success' });
    return result;
  } catch (error) {
    if (isRequestCancellation(error, signal)) {
      const cancellation = normalizeRequestCancellation(error);
      tracer.cancel(span, cancellation);
      throw cancellation;
    }
    tracer.fail(span, error);
    throw error;
  }
}

// 把 MCP Server 暴露的工具定义转成 Qwen function calling 的 tools 格式。
// MCP 工具是真实可执行能力；Qwen tools 只是告诉模型“有哪些函数可以请求调用”。
function buildToolDefinitions(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.inputSchema || {
        type: "object",
        properties: {},
      },
    },
  }));
}

// 自动 RAG、记忆召回等后端主动动作也复用 OpenAI tool_call 形状，
// 从而与模型生成的 tool_call 共用解析、白名单、trace 和结果整理代码。
function createInternalToolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

// 注意 `undefined` 与 `[]` 语义不同：前者可以使用 preset 默认范围，后者表示用户明确
// 选择“不检索任何知识库”。因此调用者要先决定 fallback，不能在这里强行补默认库。
function normalizeKnowledgeBaseIds(value, fallback = ["kb-default"]) {
  if (!Array.isArray(value)) return [...fallback];
  return [...new Set(
    value
      .filter((id) => typeof id === "string" && id.trim())
      .map((id) => id.trim().slice(0, 160)),
  )].slice(0, 20);
}

// 模型输出属于不可信输入：arguments 虽然“应该是 JSON 字符串”，仍可能截断、为空或
// 解析成数组/标量。只有对象才能继续交给 MCP 的 zod schema 做字段级校验。
function parseToolCallArguments(toolCall) {
  const raw = toolCall.function?.arguments;
  if (!raw) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw createAppError(
      "INVALID_TOOL_ARGUMENTS",
      `工具 ${toolCall.function?.name || "unknown"} 的参数不是有效 JSON`,
      String(raw).slice(0, 500),
      400,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw createAppError(
      "INVALID_TOOL_ARGUMENTS",
      `工具 ${toolCall.function?.name || "unknown"} 的参数必须是对象`,
      String(raw).slice(0, 500),
      400,
    );
  }

  return parsed;
}

// read_knowledge_document 的单次运行读取预算：成功次数与累计字符双上限。
// 与单次 limit ≤ 12,000 组合后，最坏情况约 4 × 12,000 字进入模型上下文。
const MAX_READ_KNOWLEDGE_DOCUMENT_CALLS = 4;
const MAX_READ_KNOWLEDGE_DOCUMENT_CHARACTERS = 48_000;

function getToolPreviewArguments(toolCall) {
  try {
    return parseToolCallArguments(toolCall);
  } catch {
    return { raw: String(toolCall.function?.arguments || "").slice(0, 500) };
  }
}

// read_knowledge_document 的公开结果：只保留读取范围与分页元数据，
// 完整正文仅供 role=tool 回填模型，不进入 SSE、gatheredTools 或 tools_json。
function summarizeReadKnowledgeDocument(resultPayload) {
  if (!resultPayload || typeof resultPayload !== "object") {
    return resultPayload;
  }
  const { content, ...summary } = resultPayload;
  return summary;
}

function failedToolExecution(args, error) {
  const payload = getErrorPayload(error, "工具执行失败");
  const resultPayload = {
    code: payload.code,
    message: payload.message,
    details: payload.details,
  };
  return {
    args,
    isError: true,
    resultText: payload.details
      ? `${payload.message}\n${payload.details}`
      : payload.message,
    resultPayload,
    citations: [],
  };
}

// 自动 RAG 命中后，把检索结果整理成 system 消息注入模型上下文。
// 这条路径不走 role=tool 回填，而是直接给最终回答阶段增加知识库片段。
function buildKnowledgeContext(citations) {
  if (!citations.length) {
    return "本轮已自动检索知识库，但没有命中相关内容。请据此如实回答，不要编造知识库内容。";
  }

  return [
    "本轮 RAG 已开启，并已自动检索知识库。请优先依据以下知识库片段回答；如果片段不足，再说明不足之处。",
    ...citations.map((citation, index) =>
      [`片段 ${index + 1}：${citation.title}`, citation.snippet].join("\n"),
    ),
  ].join("\n\n");
}

const CHAT_TRANSPORT_MAX_MESSAGES = 100;
const CHAT_TRANSPORT_MAX_CHARACTERS = 200_000;

// 运输上限只防止异常请求压垮进程，不承担“模型应该看到哪些历史”的产品决策。
// 从最新消息向前保留完整消息，真正的 token 选择交给 ContextBuilder。
function normalizeIncomingMessages(value) {
  const source = (Array.isArray(value) ? value : [])
    .filter((message) => (
      message
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string'
    ))
    .slice(-CHAT_TRANSPORT_MAX_MESSAGES);
  const selected = [];
  let characters = 0;
  for (const [reverseIndex, message] of source.toReversed().entries()) {
    if (!selected.length && message.content.length > CHAT_TRANSPORT_MAX_CHARACTERS) {
      throw createAppError(
        'CHAT_CONTEXT_TRANSPORT_LIMIT',
        '当前消息超过聊天运输上限',
        `单条最新消息不能超过 ${CHAT_TRANSPORT_MAX_CHARACTERS} 个字符。`,
        413,
      );
    }
    if (characters + message.content.length > CHAT_TRANSPORT_MAX_CHARACTERS) break;
    const originalIndex = source.length - reverseIndex - 1;
    selected.push({
      id: typeof message.id === 'string' && message.id.trim()
        ? message.id.trim().slice(0, 160)
        : `transport-message-${originalIndex + 1}`,
      role: message.role,
      content: message.content
    });
    characters += message.content.length;
  }
  return selected.reverse();
}

function buildConversationTurnCandidates(messages, conversationId) {
  const turns = [];
  let current = [];
  for (const message of messages) {
    if (message.role === 'user' && current.length) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length) turns.push(current);
  return turns.map((turn, index) => ({
    id: `conversation-turn-${turn[0].id}`,
    kind: 'conversation_turn',
    sourceRef: {
      id: turn.map((message) => message.id).join(',').slice(0, 200),
      parentId: conversationId
    },
    messages: turn,
    rank: index
  }));
}

function buildFewShotCandidates(preset) {
  return (preset.fewShot || []).map((example, index) => ({
    id: `few-shot-${preset.id}-${index + 1}`,
    kind: 'few_shot',
    sourceRef: { id: `${preset.id}:${index + 1}`, parentId: preset.id },
    messages: [
      { role: 'user', content: example.user },
      { role: 'assistant', content: example.assistant }
    ],
    rank: index
  }));
}

function buildMemoryCandidates(memories) {
  return memories.map((memory, index) => ({
    id: `memory-context-${memory.id || index + 1}`,
    kind: 'memory',
    sourceRef: { id: memory.id || `memory-${index + 1}` },
    messages: [{ role: 'system', content: buildMemoryContext([memory]) }],
    rank: index
  }));
}

function buildKnowledgeCandidates(citations) {
  return citations.map((citation, index) => ({
    id: `knowledge-context-${citation.id || index + 1}`,
    kind: 'knowledge_chunk',
    sourceRef: {
      id: citation.id || `chunk-${index + 1}`,
      ...(citation.documentId ? { parentId: citation.documentId } : {})
    },
    messages: [{ role: 'system', content: buildKnowledgeContext([citation]) }],
    rank: index
  }));
}

function buildContextSummary(manifest) {
  return {
    buildId: manifest.buildId,
    purpose: manifest.purpose,
    profile: manifest.profile,
    estimatedInputTokens: manifest.estimatedInputTokens,
    summary: manifest.summary,
    warnings: manifest.warnings
  };
}

// 执行一次 Qwen 返回的 tool_call，或者后端自动构造的 tool_call。
// 真正执行工具的是 MCP Server；编排器只负责解析参数、调用 Gateway、整理返回值。
// 阅读顺序建议按五道门理解：取消预检 -> 服务端白名单 -> 参数解析与范围覆盖 -> MCP 调用
// -> 统一结果。只有真正的“取消”继续向外抛；普通工具错误会变成可展示/可回填模型的结果，
// 这样一次工具失败不必直接摧毁整段 Agent 对话。
async function executeToolCallWithMcp(executor, toolCall, options = {}) {
  const name = toolCall.function?.name || "unknown";
  const toolContext = options.toolContext || {};
  const span = options.tracer?.start(name, name.startsWith('retrieve_') ? 'retrieval' : 'tool', { args: getToolPreviewArguments(toolCall) });
  if (options.signal?.aborted) {
    const cancellation = normalizeRequestCancellation();
    options.tracer?.cancel(span, cancellation);
    throw cancellation;
  }
  let args;
  try {
    args = applyTrustedToolArguments(
      name,
      parseToolCallArguments(toolCall),
      toolContext,
    );
  } catch (error) {
    const failed = failedToolExecution(getToolPreviewArguments(toolCall), error); options.tracer?.fail(span, error); return failed;
  }
  // 这里通过 Gateway 调用 MCP Server 中注册的工具，比如 retrieve_knowledge。
  let result;
  try {
    result = await executor.callTool(
      name,
      args,
      toolContext,
      { signal: options.signal, timeout: options.timeout },
    );
  } catch (error) {
    if (isRequestCancellation(error, options.signal)) {
      const cancellation = normalizeRequestCancellation(error);
      options.tracer?.cancel(span, cancellation);
      throw cancellation;
    }
    const failed = failedToolExecution(args, error); options.tracer?.fail(span, error); return failed;
  }

  const structured = result.structured;
  const text = result.text;
  const isError = result.isError;
  const resultCancellation = structured?.code === 'REQUEST_ABORTED'
    ? createAppError(
        'REQUEST_ABORTED',
        structured?.message || '请求已取消',
        structured?.details || '',
        499,
      )
    : null;
  if (isRequestCancellation(resultCancellation, options.signal)) {
    const cancellation = normalizeRequestCancellation(resultCancellation);
    options.tracer?.cancel(span, cancellation);
    throw cancellation;
  }

  // resultText 主要给前端工具卡片展示。
  // resultPayload 主要给模型回填或作为结构化 SSE 数据。
  // citations 用于前端参考来源展示。
  const executed = {
    args, // 前端展示工具参数？
    isError, // 工具执行是否失败，前端据此展示不同状态。
    resultText: text || JSON.stringify(structured, null, 2),
    resultPayload: structured,
    citations: Array.isArray(structured?.citations) ? structured.citations : [],
  };
  options.tracer?.finish(span, { status: isError ? 'error' : 'success', errorCode: structured?.code || '', errorMessage: structured?.message || '' });
  return executed;
}

// 长期记忆召回是回答前的 best-effort 增强：普通检索失败时返回空上下文，让聊天仍可继续；
// 用户取消则不能吞掉，否则后续模型调用还会继续消耗资源。
async function retrieveMemories(executor, query, signal, tracer) {
  if (!query.trim()) {
    return [];
  }

  try {
    const executed = await executeToolCallWithMcp(
      executor,
      createInternalToolCall("auto-retrieve-memory", "retrieve_memory", {
        query: query.slice(0, 4000),
        topK: 3,
      }),
      {
        signal,
        timeout: 10_000,
        tracer,
        toolContext: { caller: 'internal', invocation: 'orchestrated' },
      },
    );
    const memories = Array.isArray(executed.resultPayload?.memories)
      ? executed.resultPayload.memories
      : [];
    return memories;
  } catch (error) {
    if (isRequestCancellation(error, signal)) {
      throw normalizeRequestCancellation(error);
    }
    logger.error?.("[memory] retrieve failed:", error);
    return [];
  }
}

/**
 * 回答完成后的“候选记忆”支线，不是保存全部聊天：
 * 先用规则判断这一轮是否包含稳定信息，再让模型输出一条结构化候选，最后经 MCP
 * 完成敏感信息过滤和去重。返回的仍是 candidate，必须由用户确认/纠正后才能参与召回。
 * 这条支线是 best-effort，失败或内部超时不应把已经生成成功的回答改成失败。
 */
async function generateMemoryCandidate({
  executor,
  userContent,
  assistantContent,
  sourceConversationId,
  sourceMessageIds,
  signal,
  tracer,
}) {
  if (!shouldSuggestMemoryCandidate({ userContent, assistantContent })) {
    return null;
  }

  try {
    const { result: completion } = await tracedModelCall(
      tracer,
      'memory_candidate_extraction',
      {
        model: config.model,
        stream: false,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: "你负责生成可由用户审查的长期记忆候选。请严格返回 JSON。",
          },
          {
            role: "user",
            content: buildMemoryCandidatePrompt({
              userContent: userContent.slice(0, 4000),
              assistantContent: assistantContent.slice(0, 3000),
            }),
          },
        ],
      },
      false,
      signal,
    );

    const content = completion.choices?.[0]?.message?.content || "";
    const candidate = parseMemoryCandidateResponse(content);
    if (!candidate) {
      return null;
    }

    const proposal = {
      ...candidate,
      sourceConversationId,
      sourceMessageIds,
      sourceExcerpt: [
        `用户：${userContent.slice(0, 4000)}`,
        `助手：${assistantContent.slice(0, 2000)}`,
      ].join("\n\n"),
    };
    const proposed = await executeToolCallWithMcp(
      executor,
      createInternalToolCall("propose-memory", "propose_memory", proposal),
      {
        signal,
        timeout: candidateTimeoutMs,
        tracer,
        toolContext: { caller: 'internal', invocation: 'orchestrated' },
      },
    );
    if (proposed.isError || proposed.resultPayload?.duplicate) return null;
    return proposed.resultPayload?.memory || null;
  } catch (error) {
    logger.error?.("[memory] candidate generation failed:", error);
    return null;
  }
}

// 聊天编排核心，可以按以下顺序阅读：
// 1. 建 run 与取消信号；2. 发现 MCP 工具；3. 解析 preset/知识范围；4. 召回已确认记忆；
// 5. 自动 RAG 或模型自主 tool loop；6. 最终流式生成；7. best-effort 记忆候选；
// 8. success/error/cancelled 统一结束 run/span。任何提前 return 都必须满足终态不变量。
async function run(request, { signal, emit }) {
  const send = (type, data) => emit({ type, data });
  const tracer = createRunTracer({
    conversationId: typeof request?.conversationId === 'string'
      ? request.conversationId
      : '',
    emit,
  });

  let generationSpan = null;
  let generationSpanFinished = false;
  let generationUsage = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
  };
  let finalContextSummary = null;

  try {
    // 先保证 MCP 可用，并读取 MCP Server 暴露的全部工具。
    await tracedStep(
      tracer,
      'mcp_connect',
      'internal',
      () => mcpGateway.connect(),
    );
    const availableTools = await tracedStep(
      tracer,
      'mcp_tool_discovery',
      'internal',
      () => mcpGateway.listTools(),
    );
    const incomingMessages = normalizeIncomingMessages(request?.messages);
    const ragEnabled = request?.ragEnabled !== false;
    const sourceConversationId =
      typeof request?.conversationId === "string" ? request.conversationId : "";
    const preset = resolvePreset(
      config.presets,
      typeof request?.presetId === 'string' ? request.presetId : 'general',
    );
    // 只有“请求中根本没有 knowledgeBaseIds”才使用 preset 默认值；显式 [] 必须保留。
    // 这是区分“尚未选择”和“用户明确关闭范围”的关键语义。
    const requestedKnowledgeBaseIds = Array.isArray(request?.knowledgeBaseIds)
      ? normalizeKnowledgeBaseIds(request.knowledgeBaseIds, [])
      : undefined;
    const knowledgeBaseIds = resolvePresetKnowledgeScope(
      preset,
      requestedKnowledgeBaseIds,
    );
    const sourceMessageIds = Array.isArray(request?.sourceMessageIds)
      ? request.sourceMessageIds
          .filter((id) => typeof id === "string" && id.trim())
          .map((id) => id.trim())
          .slice(0, 10)
      : [];
    // 三个布尔值不要合并：有范围、允许 retrieve、至少有一个知识工具是不同概念。
    // 例如 preset 只允许 list_knowledge_documents 时，模型仍能看列表工具，但不能检索。
    const knowledgeScopeEnabled = ragEnabled && knowledgeBaseIds.length > 0;
    const knowledgeRetrievalEnabled =
      knowledgeScopeEnabled && preset.toolWhitelist.includes('retrieve_knowledge');
    const modelKnowledgeToolsEnabled =
      knowledgeScopeEnabled &&
      preset.toolWhitelist.some((name) =>
        name === 'retrieve_knowledge' || name === 'list_knowledge_documents' || name === 'read_knowledge_document'
      );
    let hasReadyKnowledge = false;
    if (knowledgeRetrievalEnabled) {
      const scopedDocumentsResult = await tracedStep(
        tracer,
        'knowledge_scope_check',
        'retrieval',
        () => toolExecutor.callToolOrThrow(
          "list_knowledge_documents",
          { knowledgeBaseIds, statuses: ["ready"] },
          { caller: 'internal', invocation: 'orchestrated' },
          {
            signal,
            fallbackMessage: "检查知识库范围失败",
          },
        ),
        { knowledgeBaseIds },
        signal,
      );
      const scopedDocuments = scopedDocumentsResult.structured;
      hasReadyKnowledge = Array.isArray(scopedDocuments.documents)
        ? scopedDocuments.documents.length > 0
        : false;
    }
    // 本轮回答过程中收集到的引用和工具调用。
    // 最终会通过 done 事件一次性发给前端，前端挂到当前 assistant 消息上。
    const gatheredCitations = [];
    const gatheredTools = [];
    // read_knowledge_document 的单轮读取预算：成功次数与累计字符双上限。
    // 预算在编排层拦截，超额调用不会进入 Knowledge Service。
    let readKnowledgeSuccessfulReads = 0;
    let readKnowledgeReturnedCharacters = 0;
    // 第一层白名单：只把当前已解析 preset 允许的工具定义发给模型。
    // executeToolCallWithMcp 还会做第二层执行校验，不盲信模型返回的 tool_call。
    // 这是本轮能力范围约束，不是身份/ACL 授权：请求方可以选择任一已发布 preset。
    const toolDefinitions = buildToolDefinitions(
      getPresetVisibleTools(availableTools.tools || [], {
        knowledgeScopeEnabled,
        toolWhitelist: preset.toolWhitelist,
      }),
    );
    const modelToolNames = new Set(
      toolDefinitions.map((tool) => tool.function.name),
    );
    const latestUserQuery = getLatestUserContent(incomingMessages);
    // RAG On + 已选范围 + ready 文档代表用户授权本轮查证。此处不再依赖关键词或模型
    // 自主判断，否则“项目暗号是什么”这类项目事实会漏过知识库。
    const resolveScopedKnowledge = shouldResolveScopedKnowledge({
      retrievalEnabled: knowledgeRetrievalEnabled && modelToolNames.has('retrieve_knowledge'),
      hasReadyKnowledge,
      query: latestUserQuery,
    });
    // 知识检索已经由后端执行一次后，不再暴露给模型，避免重复调用；其他安全只读工具
    // 仍可保留在规划阶段，例如时间工具。
    const planningToolDefinitions = resolveScopedKnowledge
      ? toolDefinitions.filter((tool) => tool.function.name !== 'retrieve_knowledge')
      : toolDefinitions;
    const planningToolNames = new Set(
      planningToolDefinitions.map((tool) => tool.function.name),
    );
    const latestUserIndex = incomingMessages.findLastIndex(
      (message) => message.role === 'user'
    );
    const currentUserMessage = latestUserIndex >= 0
      ? incomingMessages[latestUserIndex]
      : { id: 'current-user-missing', role: 'user', content: '' };
    const historyMessages = latestUserIndex >= 0
      ? incomingMessages.filter((_, index) => index !== latestUserIndex)
      : incomingMessages;
    const systemCandidate = {
      id: 'system-base',
      kind: 'system_rule',
      sourceRef: { id: `preset:${preset.id}` },
      messages: [{
        role: "system",
        content: [
          "你是一个中文 Agent 助手。",
          preset.systemPrompt,
          resolveScopedKnowledge
            ? "系统会先以受控流程检查当前资料范围。"
            : modelKnowledgeToolsEnabled
            ? "你可以使用当前预设允许的只读 MCP 知识工具。"
            : "本轮未启用可用的知识库检索（可能是关闭 RAG、未选范围或预设限制）；不要访问知识库。",
          knowledgeRetrievalEnabled
            ? resolveScopedKnowledge
              ? "系统已先检查当前资料范围；若有被采纳的资料片段，请以它们为准，不要重复检索资料库。"
              : "当前资料范围内没有 ready 文档；不要声称已经查询或引用资料库。"
            : modelKnowledgeToolsEnabled
              ? "只使用当前已提供的知识工具，不要声称执行未开放的检索。"
              : "不要声称已经查询或引用知识库。",
          "最终回答需要清晰、结构化、简洁。",
          "只能调用本轮实际提供的工具；不要编造工具名称，也不要承诺稍后调用当前未提供的能力。",
        ].join("\n"),
      }]
    };
    const currentUserCandidate = {
      id: `current-user-${currentUserMessage.id}`,
      kind: 'current_user',
      sourceRef: { id: currentUserMessage.id, parentId: sourceConversationId },
      messages: [currentUserMessage]
    };
    const baseCandidates = [
      systemCandidate,
      ...buildFewShotCandidates(preset),
      ...buildConversationTurnCandidates(historyMessages, sourceConversationId),
      currentUserCandidate
    ];
    const memories = await retrieveMemories(
      toolExecutor,
      latestUserQuery,
      signal,
      tracer,
    );
    const memoryCandidates = buildMemoryCandidates(memories);
    const knowledgeCandidates = [];
    const toolExchangeCandidates = [];
    const outputReserveTokens = preset.modelParameters.maxTokens ?? 4_096;
    const contextProfile = {
      id: `${config.model || 'model'}-context`,
      contextWindowTokens: config.contextWindowTokens,
      outputReserveTokens,
      safetyReserveTokens: config.contextSafetyReserveTokens
    };
    const buildChatContext = (purpose) => buildContext({
      purpose,
      profile: contextProfile,
      candidates: [
        ...baseCandidates,
        ...memoryCandidates,
        ...knowledgeCandidates,
        ...toolExchangeCandidates
      ]
    });
    if (resolveScopedKnowledge) {
      // 受控 RAG 不等模型自己决定，而是后端直接构造一个 retrieve_knowledge tool_call。
      const toolCall = createAutoRetrieveToolCall(latestUserQuery, knowledgeBaseIds);
      const previewArgs = getToolPreviewArguments(toolCall);

      // 先告诉前端工具开始执行，UI 可以显示 running。
      send("tool", {
        id: toolCall.id,
        name: toolCall.function.name,
        args: previewArgs,
        status: "running",
      });

      // 真正执行 retrieve_knowledge。内部会走 MCP Server、embedding 和检索排序。
      const executed = await executeToolCallWithMcp(toolExecutor, toolCall, {
        tracer,
        signal,
        toolContext: {
          caller: 'chat',
          invocation: 'autonomous',
          allowedToolNames: modelToolNames,
          knowledgeScopeEnabled,
          knowledgeBaseIds,
        },
      });
      const evidence = resolveChatKnowledgeEvidence({
        citations: executed.citations,
        retrievalTrace: executed.resultPayload?.trace,
        query: latestUserQuery,
        isError: executed.isError,
      });
      const evidenceSpan = tracer.start('knowledge_evidence_gate', 'retrieval', {
        knowledgeBaseIds,
        policyVersion: evidence.trace.policyVersion,
      });
      tracer.finish(evidenceSpan, { metadata: { evidence: evidence.trace } });
      const governedPayload = {
        ...(executed.resultPayload && typeof executed.resultPayload === 'object'
          ? executed.resultPayload
          : {}),
        citations: evidence.citations,
        count: evidence.citations.length,
        trace: {
          ...(executed.resultPayload?.trace && typeof executed.resultPayload.trace === 'object'
            ? executed.resultPayload.trace
            : {}),
          chatEvidence: evidence.trace,
        },
      };

      gatheredCitations.splice(
        0,
        gatheredCitations.length,
        ...mergeCitations(gatheredCitations, evidence.citations),
      );
      gatheredTools.push({
        id: toolCall.id,
        name: toolCall.function.name,
        args: executed.args, //
        status: executed.isError ? "error" : "success",
        result: describeKnowledgeEvidence(evidence.trace),
      });

      // 再告诉前端工具执行完成。前端会用相同 id 合并 running -> success/error。
      send("tool", {
        id: toolCall.id,
        name: toolCall.function.name,
        args: executed.args,
        status: executed.isError ? "error" : "success",
        result: governedPayload,
      });

      if (evidence.citations.length) {
        send("citations", { citations: gatheredCitations });
      }

      // 只有通过证据门的片段才会进入 ContextBuilder；预算淘汰仍由 ContextBuilder 记录。
      // 这保证“召回到”不等于“可以作为回答依据”。
      if (evidence.citations.length) {
        knowledgeCandidates.push(...buildKnowledgeCandidates(evidence.citations));
      } else if (evidence.trace.status === 'evidence_gap' && hasExplicitKnowledgeIntent(latestUserQuery)) {
        // 用户明确要求“根据资料”时，给最终回答一个小而确定的边界，避免把通用知识
        // 冒充成资料结论；普通问题只保留运行诊断，不干扰正常回答。
        systemCandidate.messages[0].content += '\n已检查当前资料范围，但未找到可用证据；请明确说明资料未覆盖，勿把推测表述成资料结论。';
      }

    }

    // 资料检索已由上方确定性完成；其余可用工具仍由模型决定。最多 4 轮，避免
    // 反复要求调用工具导致死循环。若范围内只有资料工具，这里自然不会再发规划请求。
    for (let round = 0; planningToolDefinitions.length && round < 4; round += 1) {
      const planningContext = buildChatContext('tool_planning');
      // 工具规划阶段使用非流式请求：这里要先拿到完整 tool_calls，再执行工具。
      const { result: completion } = await tracedModelCall(tracer, 'tool_planning', {
          model: config.model,
          stream: false,
          temperature: preset.modelParameters.temperature,
          ...(preset.modelParameters.topP !== undefined
            ? { top_p: preset.modelParameters.topP }
            : {}),
          max_tokens: outputReserveTokens,
          messages: planningContext.messages,
          tools: planningToolDefinitions,
          tool_choice: "auto",
        }, false, signal, { contextManifest: planningContext.manifest });

      const choice = completion.choices?.[0]?.message;
      const toolCalls = choice?.tool_calls || [];

      // 没有 tool_calls，说明模型暂时不需要工具，跳出规划循环，进入最终回答。
      if (!toolCalls.length) {
        break;
      }

      // 把模型这次“要求调用工具”的 assistant 消息与后续结果收进同一语义单元。
      // OpenAI-Compatible function calling 协议要求后续 role=tool 结果能对应到这条 assistant/tool_calls。
      const toolExchangeMessages = [];
      appendToolPlanningChoice(toolExchangeMessages, choice, toolCalls);

      for (const toolCall of toolCalls) {
        const previewArgs = getToolPreviewArguments(toolCall);
        // 通知前端：某个工具开始执行。
        send("tool", {
          id: toolCall.id,
          name: toolCall.function?.name,
          args: previewArgs,
          status: "running",
        });

        // 根据模型返回的 tool_call，调用 MCP Server 执行真实工具。
        let executed;
        if (
          toolCall.function?.name === 'read_knowledge_document'
          && (readKnowledgeSuccessfulReads >= MAX_READ_KNOWLEDGE_DOCUMENT_CALLS
            || readKnowledgeReturnedCharacters >= MAX_READ_KNOWLEDGE_DOCUMENT_CHARACTERS)
        ) {
          // 读取预算在编排层拦截：超额调用不进入 Service，但必须按 function-calling
          // 协议回填结构化错误，让模型基于已读取内容继续回答。
          executed = failedToolExecution(
            getToolPreviewArguments(toolCall),
            createAppError(
              'READ_KNOWLEDGE_BUDGET_EXCEEDED',
              '本次回答的文档正文读取额度已用尽；请基于已读取的内容继续回答，不要承诺继续读取。',
              `已成功读取 ${readKnowledgeSuccessfulReads} 次，累计 ${readKnowledgeReturnedCharacters} 字。`,
              429
            ),
          );
        } else {
          executed = await executeToolCallWithMcp(toolExecutor, toolCall, {
            tracer,
            signal,
            toolContext: {
              caller: 'chat',
              invocation: 'autonomous',
              allowedToolNames: planningToolNames,
              knowledgeScopeEnabled,
              knowledgeBaseIds,
            },
          });
          if (toolCall.function?.name === 'read_knowledge_document' && !executed.isError) {
            readKnowledgeSuccessfulReads += 1;
            readKnowledgeReturnedCharacters += Number(executed.resultPayload?.returnedCharacters || 0);
          }
        }

        // 完整正文只进入 role=tool 回填；前端工具卡片、gatheredTools 与持久化
        // tools_json 只保留读取摘要，避免长文档重复占用消息与上下文。
        const publicToolResult = toolCall.function?.name === 'read_knowledge_document' && !executed.isError
          ? summarizeReadKnowledgeDocument(executed.resultPayload)
          : executed.resultPayload;

        gatheredCitations.splice(
          0,
          gatheredCitations.length,
          ...mergeCitations(gatheredCitations, executed.citations),
        );
        gatheredTools.push({
          id: toolCall.id,
          name: toolCall.function?.name,
          args: executed.args,
          status: executed.isError ? "error" : "success",
          result: toolCall.function?.name === 'read_knowledge_document' && !executed.isError
            ? publicToolResult
            : executed.resultText,
        });

        // 通知前端：工具执行结束。
        send("tool", {
          id: toolCall.id,
          name: toolCall.function?.name,
          args: executed.args,
          status: executed.isError ? "error" : "success",
          result: publicToolResult,
        });

        if (executed.citations.length) {
          send("citations", { citations: gatheredCitations });
        }

        // 这是 function calling 最关键的一步：把工具执行结果回填给模型。
        // 没有 role=tool 消息，模型不知道刚才工具返回了什么，也无法基于结果继续回答。
        toolExchangeMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(executed.resultPayload),
        });
      }
      toolExchangeCandidates.push({
        id: `tool-exchange-${round + 1}`,
        kind: 'tool_exchange',
        sourceRef: {
          id: toolCalls.map((toolCall) => toolCall.id).join(',').slice(0, 200),
          parentId: tracer.runId
        },
        messages: toolExchangeMessages,
        rank: round
      });
    }

    // 工具规划和工具执行结束后，请求 Qwen 生成最终回答。
    // 这次使用 stream=true，因为要把模型输出实时转发给前端。
    const generationContext = buildChatContext('answer_generation');
    finalContextSummary = buildContextSummary(generationContext.manifest);
    const tracedGeneration = await tracedModelCall(tracer, 'generation', {
        model: config.model,
        stream: true,
        temperature: preset.modelParameters.temperature,
        ...(preset.modelParameters.topP !== undefined
          ? { top_p: preset.modelParameters.topP }
          : {}),
        max_tokens: outputReserveTokens,
        stream_options: { include_usage: true },
        messages: generationContext.messages,
      }, true, signal, { contextManifest: generationContext.manifest });
    const streamResponse = tracedGeneration.result;
    generationSpan = tracedGeneration.span;

    // 读取 Qwen 返回的 SSE 流，再转换成项目自己的前端 SSE 格式。
    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let upstreamDone = false;
    // 完整回答会在流结束后与用户问题一起交给模型，萃取待用户审查的长期记忆候选。
    let assistantContent = "";

    // 上游 Qwen SSE 与本项目 SSE 不是同一协议层：这里先解析上游 data payload，
    // 再把 token/usage 转成项目自己的事件。usage 只暂存，不能据此提前把 span 标成功，
    // 因为供应商可能先发 usage、随后连接却在 `[DONE]` 前断开。
    function processUpstreamPayloads(payloads) {
      let sawDone = false;
      for (const raw of payloads) {
        if (raw === "[DONE]") {
          sawDone = true;
          continue;
        }

        try {
          const json = JSON.parse(raw);
          const token = json.choices?.[0]?.delta?.content;
          if (json.usage) {
            const usage = normalizeUsage(json.usage);
            generationUsage = {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              estimatedCost: estimateCost(config.model, json.usage, config.pricing),
            };
          }
          if (token) {
            assistantContent += token;
            send("token", { token });
          }
        } catch {
          // 上游偶发无效 chunk 时忽略，避免单个脏 chunk 中断整次输出。
        }
      }
      return sawDone;
    }

    // 只有确认收到 `[DONE]` 才进入这里。generation 先独立成功，随后候选记忆作为
    // best-effort 支线运行；因此用户在候选阶段取消时，generation 可以保持 success，
    // 但整个 run 会按请求生命周期收敛为 cancelled。
    async function finalizeChatStream() {
      tracer.finish(generationSpan, {
        status: 'success',
        ...generationUsage,
      });
      generationSpanFinished = true;
      // 候选萃取最多等待 8 秒，不能让回答已结束后 UI 长时间卡在 streaming。
      const candidateSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(candidateTimeoutMs),
      ]);
      const candidate = await generateMemoryCandidate({
        executor: toolExecutor,
        userContent: latestUserQuery,
        assistantContent,
        sourceConversationId,
        sourceMessageIds,
        signal: candidateSignal,
        tracer,
      });
      if (candidate) {
        send("memory_candidate", { candidate });
      }
      if (signal?.aborted) {
        throw createAppError(
          'REQUEST_ABORTED',
          '请求已取消',
          '客户端在回答生成后、记忆候选处理期间断开了连接。',
          499,
        );
      }
      const finishedRun = tracer.finishRun(
        'success',
        undefined,
        finalContextSummary ? { contextSummary: finalContextSummary } : {}
      );
      send("done", {
        citations: gatheredCitations,
        tools: gatheredTools,
        run: finishedRun,
      });
      return { status: 'success', run: finishedRun };
    }

    // ReadableStream 的 chunk 边界不等于 SSE 事件边界：一次 read 可能拿到半个事件，
    // 也可能拿到多个事件。因此必须把 remainder 带到下一轮，不能直接按 chunk JSON.parse。
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const drained = drainSseData(buffer);
      buffer = drained.remainder;
      if (processUpstreamPayloads(drained.data)) {
        upstreamDone = true;
        return await finalizeChatStream();
      }
    }

    // 上游若没有以空行结尾，也要处理最后一个 token/[DONE] 事件。
    buffer += decoder.decode();
    const finalDrain = drainSseData(buffer, { flush: true });
    upstreamDone = processUpstreamPayloads(finalDrain.data) || upstreamDone;
    if (!upstreamDone) {
      throw createAppError(
        'UPSTREAM_STREAM_INCOMPLETE',
        '模型流提前结束',
        '上游连接未发送完成标记，本次回答可能不完整，请重试。',
        502,
      );
    }
    return await finalizeChatStream();
  } catch (error) {
    // catch 是整条聊天流水线的唯一失败出口。先把各种底层取消归一化，再补齐仍未结束的
    // generation span，最后 finishRun 会兜底结束其他 running span，避免产生“僵尸时间线”。
    const requestCancelled = signal?.aborted || error?.code === 'REQUEST_ABORTED';
    const terminalError = requestCancelled
      ? normalizeRequestCancellation(error)
      : error;
    if (generationSpan && !generationSpanFinished) {
      const payload = getErrorPayload(
        terminalError,
        requestCancelled ? '请求已取消' : '生成失败',
      );
      tracer.finish(generationSpan, {
        status: requestCancelled ? 'cancelled' : 'error',
        errorCode: payload.code,
        errorMessage: payload.message,
        ...generationUsage,
      });
      generationSpanFinished = true;
    }
    const finishedRun = tracer.finishRun(
      requestCancelled ? 'cancelled' : 'error',
      terminalError,
      finalContextSummary ? { contextSummary: finalContextSummary } : {},
    );
    if (requestCancelled) {
      return { status: 'cancelled', run: finishedRun };
    }
    // 流已开始后，错误也要转成领域事件交给协议适配层发送。
    const payload = getErrorPayload(terminalError, "服务异常");
    send("error", {
      code: payload.code,
      message: payload.message,
      details: payload.details,
    });
    return { status: 'error', run: finishedRun, error: payload };
  }
}

return { run };
}
