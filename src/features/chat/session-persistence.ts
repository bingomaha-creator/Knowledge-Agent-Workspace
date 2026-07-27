import type { ChatMessage, ChatSession } from './types';

export const SESSION_STORAGE_KEY = "yuan-agent-chat-sessions-v2";
export const ACTIVE_SESSION_KEY = "yuan-agent-active-session-id-v2";

type SessionStorage = Pick<Storage, "getItem" | "setItem">;

interface RestoreChatSessionsOptions {
  storage?: SessionStorage;
  createSession: () => ChatSession;
  createInitialAssistantMessage: (content: string) => ChatMessage;
  now?: () => number;
  warn?: (message: string, error: unknown) => void;
}

interface PersistChatSessionsOptions {
  sessions: ChatSession[];
  activeSessionId: string;
  storage?: SessionStorage;
  warn?: (message: string, error: unknown) => void;
}

function browserStorage(): SessionStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function fallbackState(
  createSession: () => ChatSession,
  exposeActiveId = true,
) {
  const session = createSession();
  return {
    sessions: [session],
    activeSessionId: exposeActiveId ? session.id : "",
  };
}

/**
 * 从版本化 localStorage 快照恢复会话，并在一个边界内完成旧字段迁移。
 * 未识别的会话字段会原样保留，显式空 knowledgeBaseIds 也不会被误补成默认库。
 */
export function restoreChatSessions({
  storage = browserStorage(),
  createSession,
  createInitialAssistantMessage,
  now = Date.now,
  warn = console.warn,
}: RestoreChatSessionsOptions): {
  sessions: ChatSession[];
  activeSessionId: string;
} {
  if (!storage) return fallbackState(createSession, false);

  let raw: string | null = null;
  let activeSessionId = "";
  try {
    raw = storage.getItem(SESSION_STORAGE_KEY);
  } catch (error) {
    warn("[chat] 会话本地读取失败", error);
  }
  try {
    activeSessionId = storage.getItem(ACTIVE_SESSION_KEY) || "";
  } catch (error) {
    warn("[chat] 当前会话 ID 读取失败", error);
  }

  if (!raw) return fallbackState(createSession);

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) {
      return fallbackState(createSession);
    }

    const sessionIds = new Set<string>();
    const normalized = parsed.map((value) => {
      if (!value || typeof value !== "object") {
        throw new TypeError("会话快照不是对象");
      }
      const session = value as Partial<ChatSession> & Record<string, unknown>;
      if (
        typeof session.id !== 'string'
        || !session.id.trim()
        || sessionIds.has(session.id)
      ) {
        throw new TypeError('会话快照缺少唯一 ID');
      }
      sessionIds.add(session.id);
      const title =
        typeof session.title === "string" && session.title.trim()
          ? session.title
          : "新对话";
      const messages =
        Array.isArray(session.messages) && session.messages.length
          ? session.messages
          : [createInitialAssistantMessage("你好，我是 Matthew's Workspace 助手。")];

      return {
        ...session,
        title,
        messages,
        knowledgeBaseIds: Array.isArray(session.knowledgeBaseIds)
          ? session.knowledgeBaseIds
          : ["kb-default"],
        presetId:
          typeof session.presetId === "string" && session.presetId.trim()
            ? session.presetId
            : "general",
        updatedAt:
          typeof session.updatedAt === "number" ? session.updatedAt : now(),
        createdAt:
          typeof session.createdAt === "number" ? session.createdAt : now(),
      } as ChatSession;
    });

    return {
      sessions: normalized,
      activeSessionId: normalized.some(
        (session) => session.id === activeSessionId,
      )
        ? activeSessionId
        : normalized[0].id,
    };
  } catch {
    return fallbackState(createSession);
  }
}

/**
 * 会话快照与活动指针分别写入：其中一次失败不会阻止另一次尝试，
 * 也不会让 localStorage 配额问题打断正在进行的聊天流。
 */
export function persistChatSessions({
  sessions,
  activeSessionId,
  storage = browserStorage(),
  warn = console.warn,
}: PersistChatSessionsOptions): {
  sessions: boolean;
  activeSession: boolean;
} {
  if (!storage) return { sessions: true, activeSession: true };

  let sessionsPersisted = true;
  let activeSessionPersisted = true;
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
  } catch (error) {
    sessionsPersisted = false;
    warn("[chat] 会话本地持久化失败", error);
  }
  try {
    storage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  } catch (error) {
    activeSessionPersisted = false;
    warn("[chat] 当前会话 ID 持久化失败", error);
  }

  return {
    sessions: sessionsPersisted,
    activeSession: activeSessionPersisted,
  };
}
