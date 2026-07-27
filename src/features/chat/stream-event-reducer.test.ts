import { describe, expect, it } from "vitest";
import type {
  AgentRun,
  BackendStreamEvent,
  ChatMessage,
} from './types';
import type { MemoryRecord } from "@/features/memory/types";
import { reduceStreamEvent } from "./stream-event-reducer";

function message(patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "",
    createdAt: 1,
    status: "streaming",
    citations: [],
    tools: [],
    ...patch,
  };
}

function memory(id = "memory-1"): MemoryRecord {
  return {
    id,
    type: "fact",
    title: "项目事实",
    content: "使用 Vue",
    details: {},
    confidence: 0.8,
    status: "candidate",
    sourceConversationId: "session-1",
    sourceMessageIds: ["user-1", "assistant-1"],
    sourceExcerpt: "使用 Vue",
    createdAt: 1,
    updatedAt: 1,
  };
}

function run(status: AgentRun["status"] = "running"): AgentRun {
  return {
    id: "run-1",
    conversationId: "session-1",
    status,
    model: "qwen-plus",
    inputTokens: 12,
    outputTokens: 8,
    estimatedCost: 0.01,
    createdAt: 1,
    updatedAt: 2,
    spans: [],
  };
}

function reduce(
  currentMessage: ChatMessage,
  event: BackendStreamEvent,
  errorMessage = "",
) {
  return reduceStreamEvent({
    message: currentMessage,
    event,
    errorMessage,
  });
}

describe("reduceStreamEvent", () => {
  it("appends token text without mutating the input and defers persistence", () => {
    const original = message({ content: "你" });

    const result = reduce(original, { type: "token", token: "好" });

    expect(result.message.content).toBe("你好");
    expect(original.content).toBe("你");
    expect(result.persistence).toBe("deferred");
  });

  it("upserts tool snapshots by id", () => {
    const original = message({
      tools: [{ id: "tool-1", name: "search", args: {}, status: "running" }],
    });

    const result = reduce(original, {
      type: "tool",
      tool: {
        id: "tool-1",
        name: "search",
        args: { query: "Vue" },
        status: "success",
        result: "ok",
      },
    });

    expect(result.message.tools).toEqual([
      {
        id: "tool-1",
        name: "search",
        args: { query: "Vue" },
        status: "success",
        result: "ok",
      },
    ]);
    expect(original.tools?.[0].status).toBe("running");
    expect(result.persistence).toBe("immediate");
  });

  it("replaces citations, including an explicit empty snapshot", () => {
    const original = message({
      citations: [{ id: "c1", title: "旧", snippet: "旧", source: "old" }],
    });

    const result = reduce(original, { type: "citations", citations: [] });

    expect(result.message.citations).toEqual([]);
    expect(result.persistence).toBe("immediate");
  });

  it("attaches a candidate while returning only the produced Memory record", () => {
    const candidate = memory();
    const first = reduce(message(), {
      type: "memory_candidate",
      memoryCandidate: candidate,
    });

    expect(first.message.memoryStatus).toBe("candidate");
    expect(first.memoryCandidate).toEqual(candidate);
    expect(first).not.toHaveProperty("memories");
  });

  it("replaces run snapshots and keeps usage inside the run", () => {
    const currentRun = run();
    const result = reduce(message(), { type: "run", run: currentRun });

    expect(result.message.run).toEqual(currentRun);
    expect(result.message.run?.inputTokens).toBe(12);
    expect(result.persistence).toBe("deferred");
  });

  it("applies non-empty done snapshots and marks a streaming message done", () => {
    const finalRun = run("success");
    const result = reduce(message({ content: "完成" }), {
      type: "done",
      citations: [{ id: "c2", title: "新", snippet: "证据", source: "kb" }],
      tools: [{ id: "tool-2", name: "search", args: {}, status: "success" }],
      run: finalRun,
    });

    expect(result.message).toMatchObject({
      status: "done",
      run: finalRun,
      citations: [{ id: "c2" }],
      tools: [{ id: "tool-2" }],
    });
    expect(result.persistence).toBe("immediate");
  });

  it("does not let done overwrite an existing error or erase snapshots with empty arrays", () => {
    const failed = reduce(message(), {
      type: "error",
      message: "请求失败",
      details: "上游提前结束",
      code: "UPSTREAM_STREAM_INCOMPLETE",
    });
    const existing = {
      ...failed.message,
      citations: [{ id: "c1", title: "证据", snippet: "内容", source: "kb" }],
      tools: [{ id: "tool-1", name: "search", args: {}, status: "error" as const }],
    };

    const finished = reduce(existing, {
      type: "done",
      citations: [],
      tools: [],
      run: run("error"),
    }, failed.errorMessage);

    expect(failed.errorMessage).toBe("请求失败\n上游提前结束");
    expect(finished.message.status).toBe("error");
    expect(finished.message.content).toBe("请求失败\n上游提前结束");
    expect(finished.message.citations).toHaveLength(1);
    expect(finished.message.tools).toHaveLength(1);
    expect(finished.message.run?.status).toBe("error");
  });

  it("ignores missing payloads and cannot mutate an unrelated session message", () => {
    const target = message({ id: "assistant-target" });
    const unrelated = message({ id: "assistant-other", content: "不要修改" });

    const noOp = reduce(target, { type: "token" });
    const updated = reduce(target, { type: "token", token: "目标" });

    expect(noOp.message).toBe(target);
    expect(noOp.persistence).toBe("none");
    expect(updated.message.id).toBe("assistant-target");
    expect(unrelated.content).toBe("不要修改");
  });
});
