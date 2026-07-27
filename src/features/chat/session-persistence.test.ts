import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession } from './types';
import {
  ACTIVE_SESSION_KEY,
  SESSION_STORAGE_KEY,
  persistChatSessions,
  restoreChatSessions,
} from "./session-persistence";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function assistant(content: string): ChatMessage {
  return {
    id: `assistant-${content}`,
    role: "assistant",
    content,
    createdAt: 10,
    status: "done",
  };
}

function fallbackSession(): ChatSession {
  return {
    id: "session-fallback",
    title: "新对话",
    createdAt: 50,
    updatedAt: 50,
    knowledgeBaseIds: ["kb-default"],
    presetId: "general",
    messages: [assistant("默认问候")],
  };
}

const dependencies = {
  createSession: fallbackSession,
  createInitialAssistantMessage: assistant,
  now: () => 99,
};

describe("restoreChatSessions", () => {
  it("creates one usable default session when storage is empty", () => {
    const restored = restoreChatSessions({
      ...dependencies,
      storage: new MemoryStorage(),
    });

    expect(restored.sessions).toEqual([fallbackSession()]);
    expect(restored.activeSessionId).toBe("session-fallback");
  });

  it("migrates old sessions without dropping unknown fields or an explicit empty scope", () => {
    const storage = new MemoryStorage();
    const legacyMessage = {
      ...assistant("旧消息"),
      pitfallCandidate: { title: "旧候选" },
      pitfallStatus: "pending",
    };
    storage.values.set(
      SESSION_STORAGE_KEY,
      JSON.stringify([
        {
          id: "old-a",
          title: "",
          messages: [],
          extensionField: { keep: true },
        },
        {
          id: "old-b",
          title: "保留标题",
          messages: [legacyMessage],
          knowledgeBaseIds: [],
          presetId: "code",
          createdAt: 12,
          updatedAt: 13,
        },
      ]),
    );
    storage.values.set(ACTIVE_SESSION_KEY, "old-b");

    const restored = restoreChatSessions({ ...dependencies, storage });

    expect(restored.activeSessionId).toBe("old-b");
    expect(restored.sessions[0]).toMatchObject({
      id: "old-a",
      title: "新对话",
      knowledgeBaseIds: ["kb-default"],
      presetId: "general",
      createdAt: 99,
      updatedAt: 99,
      extensionField: { keep: true },
    });
    expect(restored.sessions[0].messages).toEqual([assistant("你好，我是 Matthew's Workspace 助手。")]);
    expect(restored.sessions[1].knowledgeBaseIds).toEqual([]);
    expect(restored.sessions[1].messages).toEqual([legacyMessage]);
  });

  it.each(["{broken", "{}", "[]"])(
    "falls back safely for invalid persisted data: %s",
    (raw) => {
      const storage = new MemoryStorage();
      storage.values.set(SESSION_STORAGE_KEY, raw);

      expect(
        restoreChatSessions({ ...dependencies, storage }),
      ).toEqual({
        sessions: [fallbackSession()],
        activeSessionId: "session-fallback",
      });
    },
  );

  it('falls back safely when a partial session has no stable id', () => {
    const storage = new MemoryStorage();
    storage.values.set(
      SESSION_STORAGE_KEY,
      JSON.stringify([{ title: '缺少 ID', messages: [assistant('旧消息')] }])
    );

    expect(restoreChatSessions({ ...dependencies, storage })).toEqual({
      sessions: [fallbackSession()],
      activeSessionId: 'session-fallback'
    });
  });

  it("falls back to the first session when the active id is stale", () => {
    const storage = new MemoryStorage();
    storage.values.set(
      SESSION_STORAGE_KEY,
      JSON.stringify([{ ...fallbackSession(), id: "session-live" }]),
    );
    storage.values.set(ACTIVE_SESSION_KEY, "session-deleted");

    const restored = restoreChatSessions({ ...dependencies, storage });

    expect(restored.activeSessionId).toBe("session-live");
  });
});

describe("persistChatSessions", () => {
  it("writes the session snapshot and active pointer", () => {
    const storage = new MemoryStorage();

    const result = persistChatSessions({
      sessions: [fallbackSession()],
      activeSessionId: "session-fallback",
      storage,
    });

    expect(result).toEqual({ sessions: true, activeSession: true });
    expect(JSON.parse(storage.values.get(SESSION_STORAGE_KEY) || "[]")).toEqual([
      fallbackSession(),
    ]);
    expect(storage.values.get(ACTIVE_SESSION_KEY)).toBe("session-fallback");
  });

  it("attempts the active pointer even when serializing sessions fails", () => {
    const warn = vi.fn();
    const values = new Map<string, string>();
    const storage: Pick<Storage, "getItem" | "setItem"> = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (key === SESSION_STORAGE_KEY) throw new Error("quota");
        values.set(key, value);
      },
    };

    const result = persistChatSessions({
      sessions: [fallbackSession()],
      activeSessionId: "session-fallback",
      storage,
      warn,
    });

    expect(result).toEqual({ sessions: false, activeSession: true });
    expect(values.get(ACTIVE_SESSION_KEY)).toBe("session-fallback");
    expect(warn).toHaveBeenCalledOnce();
  });
});
