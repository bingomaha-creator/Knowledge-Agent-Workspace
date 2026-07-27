import type {
  BackendStreamEvent,
  ChatMessage,
  ToolInvocation,
} from './types';
import type { MemoryRecord } from "@/features/memory/types";

export type StreamPersistence = "none" | "deferred" | "immediate";

export interface StreamEventReduction {
  message: ChatMessage;
  memoryCandidate?: MemoryRecord;
  errorMessage: string;
  persistence: StreamPersistence;
}

interface ReduceStreamEventInput {
  message: ChatMessage;
  event: BackendStreamEvent;
  errorMessage: string;
}

function upsertTool(
  tools: ToolInvocation[] | undefined,
  nextTool: ToolInvocation,
) {
  const nextTools = (tools || []).map((tool) => ({ ...tool }));
  const index = nextTools.findIndex((tool) => tool.id === nextTool.id);
  if (index >= 0) nextTools[index] = { ...nextTool };
  else nextTools.push({ ...nextTool });
  return nextTools;
}

/**
 * 将一个后端流事件归并为新的消息快照。函数不修改输入对象；调用 Pinia 的一层
 * 负责把结果合并回原响应式消息，从而兼顾可测试性和组件引用稳定性。
 */
export function reduceStreamEvent({
  message,
  event,
  errorMessage,
}: ReduceStreamEventInput): StreamEventReduction {
  const unchanged = (): StreamEventReduction => ({
    message,
    errorMessage,
    persistence: "none",
  });

  if (event.type === "token") {
    if (!event.token) return unchanged();
    return {
      message: { ...message, content: message.content + event.token },
      errorMessage,
      persistence: "deferred",
    };
  }

  if (event.type === "tool") {
    if (!event.tool) return unchanged();
    return {
      message: { ...message, tools: upsertTool(message.tools, event.tool) },
      errorMessage,
      persistence: "immediate",
    };
  }

  if (event.type === "citations") {
    if (!event.citations) return unchanged();
    return {
      message: { ...message, citations: [...event.citations] },
      errorMessage,
      persistence: "immediate",
    };
  }

  if (event.type === "memory_candidate") {
    if (!event.memoryCandidate) return unchanged();
    return {
      message: {
        ...message,
        memoryCandidate: event.memoryCandidate,
        memoryStatus: "candidate",
      },
      memoryCandidate: event.memoryCandidate,
      errorMessage,
      persistence: "immediate",
    };
  }

  if (event.type === "run") {
    if (!event.run) return unchanged();
    return {
      message: { ...message, run: event.run },
      errorMessage,
      persistence: "deferred",
    };
  }

  if (event.type === "error") {
    const nextErrorMessage = event.details
      ? `${event.message || "请求失败"}\n${event.details}`
      : event.message || "请求失败";
    return {
      message: {
        ...message,
        status: "error",
        content: nextErrorMessage,
      },
      errorMessage: nextErrorMessage,
      persistence: "immediate",
    };
  }

  if (event.type === "done") {
    const nextMessage = { ...message };
    if (event.citations?.length) nextMessage.citations = [...event.citations];
    if (event.tools?.length) nextMessage.tools = event.tools.map((tool) => ({ ...tool }));
    if (event.run) nextMessage.run = event.run;
    if (nextMessage.status !== "error") nextMessage.status = "done";
    return {
      message: nextMessage,
      errorMessage,
      persistence: "immediate",
    };
  }

  return unchanged();
}
