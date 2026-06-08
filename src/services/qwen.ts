import type { ApiErrorPayload, BackendStreamEvent, QwenMessage, ServerDocumentResponse } from '@/types/chat';

// chat.ts 调用 streamAgentChat 时传入的额外控制信息。
// 这两个字段不是模型消息本身，而是给 Express 后端判断是否需要自动 RAG 检索用的。
interface StreamAgentChatOptions {
  hasKnowledge: boolean;
  ragEnabled: boolean;
}

// 后端接口失败时通常会返回 { error, details }。
// 这个函数把后端错误对象统一整理成一段字符串，方便 chat.ts 直接显示在 UI 上。
function formatApiError(payload: Partial<ApiErrorPayload>, fallback: string) {
  const message = payload.error || fallback;
  return payload.details ? `${message}\n${payload.details}` : message;
}

// 解析一个完整的 SSE 事件块。
// 后端发来的单个 SSE 事件通常长这样：
// event: token
// data: {"token":"你好"}
//
// 注意：这个函数只负责解析“一个完整事件块”，不负责从网络流里读取数据。
function parseSseChunk(chunk: string) {
  const lines = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
  const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
  const data = lines.find((line) => line.startsWith('data:'))?.slice(5).trim() || '{}';
  return { event, data };
}

// 发起聊天流式请求。
// 这个函数不会直接返回完整回答，而是持续读取后端 SSE 流，
// 每解析出一个 token/tool/citations/done/error 事件，就通过 onEvent 回调交给 chat.ts 更新状态。
export async function streamAgentChat(
  messages: QwenMessage[],
  onEvent: (event: BackendStreamEvent) => void,
  signal?: AbortSignal,
  options?: StreamAgentChatOptions
) {
  // 前端请求的是本地 Express 后端，不是直接请求 Qwen 官方 API。
  // 真正的大模型调用、MCP 工具调用、RAG 编排都在后端完成。
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages,
      // options 可能没传，所以这里给默认值：
      // - 默认认为没有知识库文档
      // - 默认开启 RAG
      hasKnowledge: options?.hasKnowledge ?? false,
      ragEnabled: options?.ragEnabled ?? true
    }),
    // signal 来自 chat.ts 里的 AbortController，用于“停止输出”。
    signal
  });

  // 流式响应必须满足两个条件：
  // 1. HTTP 状态码成功
  // 2. response.body 存在，因为后面要通过 getReader() 一段段读取
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `请求失败：${response.status}`);
  }

  // reader 负责从 ReadableStream 里读取二进制数据。
  // decoder 负责把二进制 Uint8Array 解码成字符串。
  // buffer 用来缓存“不完整的 SSE 事件块”。
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  // 持续读取后端流，直到：
  // - 后端结束响应
  // - 用户主动 abort
  // - 解析过程中抛出异常
  while (true) {
    // 如果用户点击“停止输出”，chat.ts 会调用 abortController.abort()。
    // 这里检测到 signal.aborted 后，取消 reader 并跳出循环。
    if (signal?.aborted) {
      await reader.cancel();
      break;
    }

    // read() 每次读到的是一小块二进制数据，不保证刚好是一个完整 SSE 事件。
    const { value, done } = await reader.read();
    if (done) break;

    // 把当前读到的数据追加到 buffer。
    // { stream: true } 表示这是一段连续文本流，TextDecoder 会保留跨 chunk 的解码状态。
    buffer += decoder.decode(value, { stream: true });
    // SSE 事件之间用空行分隔，所以这里用 \n\n 拆分。
    const segments = buffer.split('\n\n');
    // 最后一段可能是不完整的事件，先放回 buffer，等下一次 reader.read() 拼完整再解析。
    buffer = segments.pop() ?? '';

    // segments 中剩下的都是当前已经凑完整的 SSE 事件块。
    for (const segment of segments) {
      const { event, data } = parseSseChunk(segment);
      // 后端约定 data 是 JSON 字符串。
      // 如果这里 JSON.parse 失败，streamAgentChat 会抛错，最终由 chat.ts 的 catch 处理成错误消息。
      const payload = JSON.parse(data);

      // token 事件：模型流式输出的一小段文本。
      // chat.ts 收到后会追加到 assistantMessage.content。
      if (event === 'token') {
        onEvent({ type: 'token', token: payload.token });
      }

      // tool 事件：后端/MCP 工具调用状态。
      // 这里把后端 payload 整理成前端统一的 ToolInvocation 结构。
      if (event === 'tool') {
        onEvent({
          type: 'tool',
          tool: {
            id: payload.id,
            name: payload.name,
            args: payload.args || {},
            status: payload.status,
            // ToolInvocation.result 在前端类型里是 string。
            // 如果后端返回对象/数组，这里格式化成缩进 JSON 字符串，方便 UI 展示。
            result:
              typeof payload.result === 'string'
                ? payload.result
                : payload.result
                  ? JSON.stringify(payload.result, null, 2)
                  : undefined
          }
        });
      }

      // citations 事件：RAG 命中的参考来源。
      // chat.ts 收到后会挂到当前 assistant 消息的 citations 上。
      if (event === 'citations') {
        onEvent({ type: 'citations', citations: payload.citations || [] });
      }

      // error 事件：后端通过 SSE 主动告知本次流式请求失败。
      // 这里不 throw，而是交给 chat.ts 把当前 assistant 消息标记为 error。
      if (event === 'error') {
        onEvent({
          type: 'error',
          message: payload.message || '请求失败',
          details: payload.details,
          code: payload.code
        });
      }

      // done 事件：一次流式响应结束。
      // 后端可能在 done 里附带最终版 citations/tools，chat.ts 会用它们覆盖当前 assistant 消息上的旧数据。
      if (event === 'done') {
        onEvent({ type: 'done', citations: payload.citations || [], tools: payload.tools || [] });
      }
    }
  }
}

// 拉取当前后端知识库里的文档列表。
// 返回值只包含文档元信息，不包含真实文档内容、分块或向量索引。
export async function fetchKnowledgeDocuments(): Promise<ServerDocumentResponse[]> {
  const response = await fetch('/api/knowledge');
  const data = await response.json();

  if (!response.ok) {
    throw new Error(formatApiError(data, '加载知识库失败'));
  }

  return data.documents || [];
}

// 上传知识库文件。
// files 可能来自 input.files(FileList)，也可能是普通 File[]，所以先统一 Array.from。
export async function uploadKnowledgeDocuments(files: FileList | File[]): Promise<ServerDocumentResponse[]> {
  const formData = new FormData();
  // 字段名必须和后端上传接口约定一致，这里统一叫 files。
  Array.from(files).forEach((file) => formData.append('files', file));

  // 使用 FormData 上传文件时不要手动设置 Content-Type。
  // 浏览器会自动带上 multipart/form-data 和 boundary。
  const response = await fetch('/api/knowledge/upload', {
    method: 'POST',
    body: formData
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(formatApiError(data, '上传失败'));
  }

  return data.documents || [];
}

// 删除单个知识库文档。
// 成功时这个函数不返回数据；调用方通过“没有抛错”判断删除成功。
export async function deleteKnowledgeDocument(id: string) {
  const response = await fetch(`/api/knowledge/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    let data: Partial<ApiErrorPayload> = {};
    try {
      // DELETE 失败时后端可能有 JSON 错误体，也可能没有，所以这里用 try/catch 兜底。
      data = await response.json();
    } catch {
      data = {};
    }
    throw new Error(formatApiError(data, '删除失败'));
  }
}

// 清空知识库。
// 和删除单个文档一样，成功时不返回数据；失败时抛出格式化后的错误。
export async function clearKnowledgeDocuments() {
  const response = await fetch('/api/knowledge', { method: 'DELETE' });
  if (!response.ok) {
    let data: Partial<ApiErrorPayload> = {};
    try {
      // 清空失败时也尽量读取后端错误体；如果没有 JSON，就使用默认错误文案。
      data = await response.json();
    } catch {
      data = {};
    }
    throw new Error(formatApiError(data, '清空失败'));
  }
}
