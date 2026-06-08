import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  appendToolPlanningChoice,
  createAutoRetrieveToolCall,
  getLatestUserContent,
  shouldAutoRetrieveKnowledge,
} from "./chat-flow-utils.js";

// 优先读取 .env.local，再读取 .env。
// 这样本地开发时可以把 QWEN_API_KEY 等私密配置放在 .env.local 中。
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

// ES Module 中没有 CommonJS 的 __dirname，所以这里手动从 import.meta.url 还原。
// 后面启动 MCP Server 子进程、托管 dist 静态资源都需要用到当前文件所在目录。
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
// 知识库上传接口使用内存存储，文件不会先落盘，而是以 buffer 形式出现在 req.files 里。
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "4mb" }));

// Express 编排层所需配置。
// 注意：这里的 baseUrl 是 Qwen OpenAI-Compatible API 地址，不是前端地址。
const config = {
  apiKey: process.env.QWEN_API_KEY,
  baseUrl: (
    process.env.QWEN_BASE_URL ||
    "https://dashscope.aliyuncs.com/compatible-mode/v1"
  ).replace(/\/$/, ""),
  model: process.env.QWEN_MODEL || "qwen-plus",
  port: Number(process.env.PORT || process.env.SERVER_PORT || 8787),
  host: process.env.HOST || "127.0.0.1",
};

// 创建带 code/details/status 的业务错误。
// 这样普通 JSON 接口和 SSE 接口都可以用统一格式向前端返回错误。
function createAppError(code, message, details = "", status = 500) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}

// 把任意异常整理成统一错误 payload。
// 普通知识库接口会把它转成 JSON；聊天流接口会把它转成 SSE error 事件。
function getErrorPayload(error, fallbackMessage) {
  if (error && typeof error === "object" && "message" in error) {
    return {
      code: error.code || "UNKNOWN_ERROR",
      message: error.message || fallbackMessage,
      details: error.details || "",
      status: error.status || 500,
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    message: fallbackMessage,
    details: "",
    status: 500,
  };
}

// 请求 Qwen OpenAI-Compatible API 的统一封装。
// stream=false 时返回 JSON；stream=true 时返回原始 Response，让调用方继续读取 response.body。
async function qwenFetch(endpoint, body, stream = false) {
  if (!config.apiKey) {
    throw createAppError(
      "MISSING_API_KEY",
      "缺少 Qwen API Key",
      "请检查服务端 `.env.local` 中的 `QWEN_API_KEY` 配置。",
      500,
    );
  }

  let response;
  try {
    // 这里是真正请求 Qwen 的地方。
    // endpoint 可能是 /chat/completions，也可能是其他 OpenAI-Compatible endpoint。
    response = await fetch(`${config.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // fetch 抛错通常是网络层问题：DNS、代理、VPN、防火墙、服务不可达等。
    throw createAppError(
      "NETWORK_UNREACHABLE",
      "无法连接到 Qwen 服务",
      "当前运行环境访问 DashScope 失败。请检查网络、代理、VPN 或防火墙设置。",
      502,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // 这里把常见上游错误转成更适合前端展示的中文错误。
    if (response.status === 401) {
      throw createAppError(
        "INVALID_API_KEY",
        "Qwen API Key 无效或已过期",
        text || "请检查 `QWEN_API_KEY` 是否正确。",
        401,
      );
    }

    if (response.status === 429) {
      throw createAppError(
        "RATE_LIMITED",
        "Qwen 请求过于频繁",
        text || "请稍后重试，或检查账户配额是否充足。",
        429,
      );
    }

    throw createAppError(
      "QWEN_HTTP_ERROR",
      `Qwen 请求失败（${response.status}）`,
      text || "上游模型服务返回异常响应。",
      502,
    );
  }

  // 流式请求不能 response.json()，否则会等完整响应结束。
  // 这里直接返回 Response，让 /api/chat/stream 自己读取 Qwen SSE。
  if (stream) {
    return response;
  }

  return response.json();
}

// 向前端发送 SSE 事件。
// 前端 qwen.ts 会按 event/data 格式解析这些事件。
function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// 缓存 MCP 会话 promise，避免每个请求都重新启动一个 MCP Server 子进程。
let mcpSessionPromise = null;

// 创建或复用 MCP 会话。
// Express 在这里扮演 MCP Client，通过 stdio transport 启动并连接 server/mcp-server.js。
async function createMcpSession() {
  if (mcpSessionPromise) {
    return mcpSessionPromise;
  }

  mcpSessionPromise = (async () => {
    // 这个 client 是编排层身份，后续用它 listTools / callTool。
    const client = new McpClient({
      name: "yuan-agent-chat-orchestrator",
      version: "1.0.0",
    });

    // 使用当前 Node 可执行文件启动 mcp-server.js。
    // 这意味着 MCP Server 是一个独立 Node 子进程，不是普通函数调用。
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(__dirname, "./mcp-server.js")],
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || "development",
      },
      stderr: "pipe",
    });

    // MCP Server 的日志会从 stderr 输出，这里转发到主服务控制台，方便排查。
    if (transport.stderr) {
      transport.stderr.on("data", (chunk) => {
        const message = chunk.toString().trim();
        if (message) {
          console.error(`[mcp-server] ${message}`);
        }
      });
    }

    // 建立 MCP 协议连接。连接成功后，client 才能 listTools / callTool。
    await client.connect(transport);

    const session = {
      client,
      transport,
      async close() {
        // close 时清掉缓存，后续请求可以重新创建新会话。
        mcpSessionPromise = null;
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
      },
    };

    return session;
  })().catch((error) => {
    // 如果连接失败，必须清掉缓存，否则后续会一直复用失败的 promise。
    mcpSessionPromise = null;
    throw error;
  });

  return mcpSessionPromise;
}

// MCP SDK 的工具结果可能放在 structuredContent，也可能兼容旧字段 toolResult。
// 这里统一拿出结构化结果，供 Express 路由继续处理。
function normalizeStructuredContent(result) {
  if (
    result &&
    typeof result === "object" &&
    "structuredContent" in result &&
    result.structuredContent
  ) {
    return result.structuredContent;
  }
  if (result && typeof result === "object" && "toolResult" in result) {
    return result.toolResult;
  }
  return {};
}

// MCP 工具结果还会带 content 数组，通常用于人类可读文本展示。
// 前端工具调用卡片里展示的 resultText 就优先来自这里。
function contentToText(result) {
  if (
    !result ||
    typeof result !== "object" ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    return "";
  }

  return result.content
    .filter((item) => item && typeof item === "object" && item.type === "text")
    .map((item) => item.text || "")
    .join("\n")
    .trim();
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

// 执行一次 Qwen 返回的 tool_call，或者后端自动构造的 tool_call。
// 真正执行工具的是 MCP Server；Express 只负责解析参数、调用 client.callTool、整理返回值。
async function executeToolCallWithMcp(client, toolCall) {
  const name = toolCall.function?.name || "unknown";
  const args = toolCall.function?.arguments
    ? JSON.parse(toolCall.function.arguments)
    : {};
  // 这里通过 MCP Client 调用 MCP Server 中注册的工具，比如 retrieve_knowledge。
  const result = await client.callTool({
    name,
    arguments: args,
  });

  const structured = normalizeStructuredContent(result);
  const text = contentToText(result);
  const isError = !!(
    result &&
    typeof result === "object" &&
    "isError" in result &&
    result.isError
  );

  // resultText 主要给前端工具卡片展示。
  // resultPayload 主要给模型回填或作为结构化 SSE 数据。
  // citations 用于前端参考来源展示。
  return {
    args, // 前端展示工具参数？
    isError, // 工具执行是否失败，前端据此展示不同状态。
    resultText: text || JSON.stringify(structured, null, 2),
    resultPayload: structured,
    citations: Array.isArray(structured?.citations) ? structured.citations : [],
  };
}

// 健康检查：不仅检查 Express 是否启动，也验证 MCP Server 能否被连接并调用工具。
app.get("/api/health", async (_, res) => {
  try {
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: "list_knowledge_documents",
      arguments: {},
    });

    const structured = normalizeStructuredContent(result);
    res.json({
      ok: true,
      documents: Array.isArray(structured.documents)
        ? structured.documents.length
        : 0,
      mcp: true,
    });
  } catch (error) {
    const payload = getErrorPayload(error, "MCP 健康检查失败");
    res.status(payload.status).json({
      ok: false,
      code: payload.code,
      error: payload.message,
      details: payload.details,
    });
  }
});

// 查询知识库文档列表。
// Express 不直接读知识库状态，而是通过 MCP 工具 list_knowledge_documents 获取。
app.get("/api/knowledge", async (_, res) => {
  try {
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: "list_knowledge_documents",
      arguments: {},
    });

    const structured = normalizeStructuredContent(result);
    res.json({
      documents: structured.documents || [],
    });
  } catch (error) {
    const payload = getErrorPayload(error, "加载知识库失败");
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details,
    });
  }
});

// 上传知识库文件。
// 前端传 FormData(files)，multer 把文件读入内存，Express 再把文件名和文本内容交给 MCP 工具导入。
app.post("/api/knowledge/upload", upload.array("files"), async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: "ingest_knowledge_documents",
      arguments: {
        // file.buffer 是 multer memoryStorage 提供的 Buffer。
        // 当前项目按 UTF-8 文本读取，适合 md/txt/json 这类知识文件。
        documents: files.map((file) => ({
          name: file.originalname,
          content: file.buffer.toString("utf-8"),
        })),
      },
    });

    const structured = normalizeStructuredContent(result);
    // MCP 工具返回 isError 时，HTTP 层也应该返回失败，让前端进入 catch。
    if (result.isError) {
      throw createAppError(
        structured.code || "MCP_TOOL_ERROR",
        structured.message || "知识库导入失败",
        structured.details || "",
        400,
      );
    }

    res.json({
      documents: structured.documents || [],
      message: structured.message || "上传成功",
    });
  } catch (error) {
    const payload = getErrorPayload(error, "知识库导入失败");
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details,
    });
  }
});

// 删除单个知识库文档。
// 删除逻辑在 MCP Server 内部完成：同时删除 document 和对应 chunks。
app.delete("/api/knowledge/:id", async (req, res) => {
  try {
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: "delete_knowledge_document",
      arguments: { id: req.params.id },
    });

    const structured = normalizeStructuredContent(result);
    // 例如文档不存在时，MCP 工具会以 isError 返回，这里转成 HTTP 错误。
    if (result.isError) {
      throw createAppError(
        structured.code || "MCP_TOOL_ERROR",
        structured.message || "删除失败",
        structured.details || "",
        400,
      );
    }

    res.json({ ok: true });
  } catch (error) {
    const payload = getErrorPayload(error, "删除失败");
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details,
    });
  }
});

// 清空知识库。
// 同样通过 MCP 工具执行，Express 自己不维护 documents/chunks。
app.delete("/api/knowledge", async (_, res) => {
  try {
    const session = await createMcpSession();
    const result = await session.client.callTool({
      name: "clear_knowledge_documents",
      arguments: {},
    });

    const structured = normalizeStructuredContent(result);
    if (result.isError) {
      throw createAppError(
        structured.code || "MCP_TOOL_ERROR",
        structured.message || "清空失败",
        structured.details || "",
        400,
      );
    }

    res.json({ ok: true });
  } catch (error) {
    const payload = getErrorPayload(error, "清空失败");
    res.status(payload.status).json({
      error: payload.message,
      code: payload.code,
      details: payload.details,
    });
  }
});

// 聊天主接口：前端通过 qwen.ts 请求这里，并期待拿到 SSE 流。
// 这个路由是后端 Agent 编排核心：连接 MCP、决定是否检索、执行工具、请求 Qwen、转发 token。
app.post("/api/chat/stream", async (req, res) => {
  // 告诉浏览器这是 SSE 响应，前端可以边接收边渲染。
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  try {
    // 先保证 MCP 可用，并读取 MCP Server 暴露的全部工具。
    const session = await createMcpSession();
    const availableTools = await session.client.listTools();
    const incomingMessages = Array.isArray(req.body?.messages)
      ? req.body.messages
      : [];
    // 给模型补一条系统提示，再拼接前端传来的对话上下文。
    const messages = [
      {
        role: "system",
        content: [
          "你是一个中文 Agent 助手。",
          "你可以通过 MCP 工具检索知识库、查看文档列表、导入或删除文档、获取当前时间。",
          "当用户的问题依赖知识库内容时，优先调用 retrieve_knowledge。",
          "最终回答需要清晰、结构化、简洁。",
        ].join("\n"),
      },
      ...incomingMessages,
    ];

    // 本轮回答过程中收集到的引用和工具调用。
    // 最终会通过 done 事件一次性发给前端，前端挂到当前 assistant 消息上。
    const gatheredCitations = [];
    const gatheredTools = [];
    const toolDefinitions = buildToolDefinitions(availableTools.tools || []);
    const latestUserQuery = getLatestUserContent(incomingMessages);
    // 自动 RAG 由后端判断：只要前端开启 RAG、有知识库文档、用户问题非空，就先检索一次。
    const autoRetrieve = shouldAutoRetrieveKnowledge({
      ragEnabled: req.body?.ragEnabled !== false,
      hasKnowledge: req.body?.hasKnowledge === true,
      query: latestUserQuery,
    });

    if (autoRetrieve) {
      // 自动 RAG 不等模型自己决定，而是后端直接构造一个 retrieve_knowledge tool_call。
      const toolCall = createAutoRetrieveToolCall(latestUserQuery);
      const previewArgs = JSON.parse(toolCall.function.arguments);

      // 先告诉前端工具开始执行，UI 可以显示 running。
      sendSse(res, "tool", {
        id: toolCall.id,
        name: toolCall.function.name,
        args: previewArgs,
        status: "running",
      });

      // 真正执行 retrieve_knowledge。内部会走 MCP Server、embedding 和检索排序。
      const executed = await executeToolCallWithMcp(session.client, toolCall);
      gatheredCitations.push(...executed.citations);
      gatheredTools.push({
        id: toolCall.id,
        name: toolCall.function.name,
        args: executed.args, //
        status: executed.isError ? "error" : "success",
        result: executed.resultText,
      });

      // 再告诉前端工具执行完成。前端会用相同 id 合并 running -> success/error。
      sendSse(res, "tool", {
        id: toolCall.id,
        name: toolCall.function.name,
        args: executed.args,
        status: executed.isError ? "error" : "success",
        result: executed.resultPayload,
      });

      if (executed.citations.length) {
        sendSse(res, "citations", { citations: executed.citations });
      }

      // 自动 RAG 分支把检索结果作为 system 上下文加入 messages，
      // 让最终流式回答可以直接依据这些片段生成。
      messages.push({
        role: "system",
        content: buildKnowledgeContext(executed.citations),
      });
    }

    // 如果没有走自动 RAG，就让 Qwen 自己通过 tool_choice=auto 判断是否需要工具。
    // 最多 4 轮，避免模型反复要求调用工具导致死循环。
    for (let round = 0; !autoRetrieve && round < 4; round += 1) {
      // 工具规划阶段使用非流式请求：这里要先拿到完整 tool_calls，再执行工具。
      const completion = await qwenFetch("/chat/completions", {
        model: config.model,
        stream: false,
        temperature: 0.4,
        messages,
        tools: toolDefinitions,
        tool_choice: "auto",
      });

      const choice = completion.choices?.[0]?.message;
      const toolCalls = choice?.tool_calls || [];

      // 没有 tool_calls，说明模型暂时不需要工具，跳出规划循环，进入最终回答。
      if (!toolCalls.length) {
        break;
      }

      // 把模型这次“要求调用工具”的 assistant 消息放回 messages。
      // OpenAI-Compatible function calling 协议要求后续 role=tool 结果能对应到这条 assistant/tool_calls。
      appendToolPlanningChoice(messages, choice, toolCalls);

      for (const toolCall of toolCalls) {
        const previewArgs = toolCall.function?.arguments
          ? JSON.parse(toolCall.function.arguments)
          : {};
        // 通知前端：某个工具开始执行。
        sendSse(res, "tool", {
          id: toolCall.id,
          name: toolCall.function?.name,
          args: previewArgs,
          status: "running",
        });

        // Express 根据模型返回的 tool_call，调用 MCP Server 执行真实工具。
        const executed = await executeToolCallWithMcp(session.client, toolCall);

        gatheredCitations.push(...executed.citations);
        gatheredTools.push({
          id: toolCall.id,
          name: toolCall.function?.name,
          args: executed.args,
          status: executed.isError ? "error" : "success",
          result: executed.resultText,
        });

        // 通知前端：工具执行结束。
        sendSse(res, "tool", {
          id: toolCall.id,
          name: toolCall.function?.name,
          args: executed.args,
          status: executed.isError ? "error" : "success",
          result: executed.resultPayload,
        });

        if (executed.citations.length) {
          sendSse(res, "citations", { citations: executed.citations });
        }

        // 这是 function calling 最关键的一步：把工具执行结果回填给模型。
        // 没有 role=tool 消息，模型不知道刚才工具返回了什么，也无法基于结果继续回答。
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(executed.resultPayload),
        });
      }
    }

    // 工具规划和工具执行结束后，请求 Qwen 生成最终回答。
    // 这次使用 stream=true，因为要把模型输出实时转发给前端。
    const streamResponse = await qwenFetch(
      "/chat/completions",
      {
        model: config.model,
        stream: true,
        temperature: 0.4,
        messages,
      },
      true,
    );

    // 读取 Qwen 返回的 SSE 流，再转换成项目自己的前端 SSE 格式。
    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Qwen SSE 同样以空行分隔事件。
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        const lines = event
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          // Qwen 用 [DONE] 表示流式响应结束。
          // 此时把本轮收集到的 citations/tools 一起通过 done 发给前端。
          if (raw === "[DONE]") {
            sendSse(res, "done", {
              citations: gatheredCitations,
              tools: gatheredTools,
            });
            res.end();
            return;
          }

          try {
            /*
            Qwen: data: {"choices":[{"delta":{"content":"你好"}}]}
            Express: event: token / data: {"token":"你好"}
            */
            const json = JSON.parse(raw);
            const token = json.choices?.[0]?.delta?.content;
            // 只转发文本 token。工具调用已经在前面的非流式规划阶段处理过了。
            if (token) {
              sendSse(res, "token", { token });
            }
          } catch {
            // 上游偶发无效 chunk 时忽略，避免单个脏 chunk 中断整次输出。
            // ignore invalid chunks
          }
        }
      }
    }

    // 如果 reader 正常结束但没有遇到 [DONE]，这里仍然发 done 兜底收尾。
    sendSse(res, "done", {
      citations: gatheredCitations,
      tools: gatheredTools,
    });
    res.end();
  } catch (error) {
    // 聊天接口已经开始以 SSE 响应，所以错误也要用 SSE error 事件返回，而不是 res.status().json()。
    const payload = getErrorPayload(error, "服务异常");
    sendSse(res, "error", {
      code: payload.code,
      message: payload.message,
      details: payload.details,
    });
    res.end();
  }
});

// 生产构建后，Express 同时托管前端 dist。
app.use(express.static(path.resolve(__dirname, "../dist")));
app.get("*", (_, res) => {
  // SPA history fallback：前端路由刷新时返回 index.html。
  res.sendFile(path.resolve(__dirname, "../dist/index.html"));
});

app.listen(config.port, config.host, () => {
  console.log(`Server running at http://${config.host}:${config.port}`);
});
