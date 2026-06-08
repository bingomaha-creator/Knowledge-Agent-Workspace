import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  clearKnowledgeDocuments,
  deleteKnowledgeDocument,
  fetchKnowledgeDocuments,
  streamAgentChat,
  uploadKnowledgeDocuments,
} from "@/services/qwen";
import type {
  ChatMessage,
  ChatSession,
  KnowledgeDocument,
  QwenMessage,
  ToolInvocation,
} from "@/types/chat";

const SESSION_STORAGE_KEY = "yuan-agent-chat-sessions-v2";
const ACTIVE_SESSION_KEY = "yuan-agent-active-session-id-v2";

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function createMessage(
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  return {
    id: uid(role),
    role,
    content,
    createdAt: Date.now(),
    status: "idle",
  };
}

function createInitialAssistantMessage(content: string) {
  const message = createMessage("assistant", content);
  message.status = "done";
  return message;
}

function createSession(title = "新对话"): ChatSession {
  const now = Date.now();
  return {
    id: uid("session"),
    title,
    createdAt: now,
    updatedAt: now,
    messages: [
      createInitialAssistantMessage(
        "你好，我是你的 yuan-agent 助手。你可以直接提问，也可以先上传资料，让我通过后端向量检索结合工具调用来回答。",
      ),
    ],
  };
}

// 把前端消息转成模型上下文，主要是为了控制传给后端的消息数量，避免一次性传太多历史消息导致请求过大
function toConversationMessages(messages: ChatMessage[]): QwenMessage[] {
  return messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .slice(-12)
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    }));
}

// 合并工具调用结果，后端可能会多次返回同一个工具的更新状态，这时需要合并到当前消息的工具列表中，而不是追加
// 第一个参数是当前消息的工具列表，第二个参数是后端返回的最新工具状态，如果工具列表中已经有这个工具了，就更新它，否则就追加一个新的工具
function mergeTool(tools: ToolInvocation[], nextTool: ToolInvocation) {
  const current = tools.find((item) => item.id === nextTool.id);
  if (current) {
    // 覆盖为 nextTool
    Object.assign(current, nextTool);
    return;
  }

  tools.push(nextTool);
}

function buildSessionTitle(messages: ChatMessage[]) {
  const userMessage = messages.find(
    (message) => message.role === "user" && message.content.trim(),
  );
  if (!userMessage) {
    return "新对话";
  }

  return userMessage.content.trim().slice(0, 24) || "新对话";
}

// 把会话写入 localStorage，每次修改会话数据后都调用这个函数来保持数据持久化
function serializeSessions(sessions: ChatSession[]) {
  if (typeof window === "undefined") {
    return;
  }

  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
}

function deserializeSessions() {
  if (typeof window === "undefined") {
    return { sessions: [createSession()], activeSessionId: "" };
  }

  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  const activeSessionId = localStorage.getItem(ACTIVE_SESSION_KEY) || "";

  if (!raw) {
    const session = createSession();
    return { sessions: [session], activeSessionId: session.id };
  }

  try {
    // 如果解析失败或者数据格式不对，就创建一个新的会话，避免因为数据问题导致整个应用无法使用
    const parsed = JSON.parse(raw) as ChatSession[];
    if (!Array.isArray(parsed) || !parsed.length) {
      const session = createSession();
      return { sessions: [session], activeSessionId: session.id };
    }

    // 校验和兜底
    const normalized = parsed.map((session) => {
      const title =
        typeof session.title === "string" && session.title.trim()
          ? session.title
          : "新对话";
      const messages =
        Array.isArray(session.messages) && session.messages.length
          ? session.messages
          : [createInitialAssistantMessage("你好，我是你的 yuan-agent 助手。")];

      return {
        ...session,
        title,
        messages,
        updatedAt:
          typeof session.updatedAt === "number"
            ? session.updatedAt
            : Date.now(),
        createdAt:
          typeof session.createdAt === "number"
            ? session.createdAt
            : Date.now(),
      };
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
    const session = createSession();
    return { sessions: [session], activeSessionId: session.id };
  }
}

// 初始状态从 localStorage 读取，如果没有或者读取失败就创建一个新的会话
const initialState = deserializeSessions();

export const useChatStore = defineStore("chat", () => {
  const sessions = ref<ChatSession[]>(initialState.sessions);
  const activeConversationId = ref(
    initialState.activeSessionId || initialState.sessions[0].id,
  );
  const input = ref("");
  const isResponding = ref(false);
  const documents = ref<KnowledgeDocument[]>([]);
  const ragEnabled = ref(true);
  const errorMessage = ref("");
  const noticeMessage = ref("");
  const sidebarOpen = ref(false);
  const abortController = ref<AbortController | null>(null);

  const activeSession = computed(() => {
    return (
      sessions.value.find(
        (session) => session.id === activeConversationId.value,
      ) || sessions.value[0]
    );
  });
  const messages = computed(() => activeSession.value.messages);
  const messageCount = computed(() => activeSession.value.messages.length);
  const documentCount = computed(() => documents.value.length);
  const sessionList = computed(() =>
    [...sessions.value].sort((a, b) => b.updatedAt - a.updatedAt),
  );

  // 会话持久化，包括保存会话列表和当前活跃会话的 ID，每次修改会话数据后都调用这个函数来保持数据持久化
  function persistSessions() {
    serializeSessions(sessions.value);
    if (typeof window !== "undefined") {
      localStorage.setItem(ACTIVE_SESSION_KEY, activeConversationId.value);
    }
  }

  function touchActiveSession() {
    activeSession.value.updatedAt = Date.now();
    activeSession.value.title = buildSessionTitle(activeSession.value.messages);
    persistSessions();
  }

  // 以下四个都是知识库相关的接口调用，成功后会刷新知识库列表，失败则显示错误信息
  async function refreshDocuments() {
    try {
      documents.value = await fetchKnowledgeDocuments();
      errorMessage.value = "";
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : "加载知识库失败";
    }
  }

  async function uploadKnowledge(files: FileList | File[]) {
    noticeMessage.value = "";
    try {
      const uploaded = await uploadKnowledgeDocuments(files);
      documents.value = [...documents.value, ...uploaded];
      errorMessage.value = "";
      noticeMessage.value = uploaded.length
        ? `已成功导入 ${uploaded.length} 份知识文件。`
        : "";
      sidebarOpen.value = true;
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : "上传知识库失败";
    }
  }

  async function removeDocument(id: string) {
    noticeMessage.value = "";
    try {
      await deleteKnowledgeDocument(id);
      documents.value = documents.value.filter((item) => item.id !== id);
      errorMessage.value = "";
      noticeMessage.value = "知识文件已移除。";
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : "删除知识库失败";
    }
  }

  async function clearKnowledge() {
    noticeMessage.value = "";
    try {
      await clearKnowledgeDocuments();
      documents.value = [];
      errorMessage.value = "";
      noticeMessage.value = "知识库已清空。";
    } catch (error) {
      errorMessage.value =
        error instanceof Error ? error.message : "清空知识库失败";
    }
  }

  function appendInput(text: string) {
    input.value = text;
  }

  // 切换会话，切换前会检查是否正在生成回答，如果是则不允许切换；切换后会清空输入框和错误提示，并关闭侧边栏
  function switchSession(sessionId: string) {
    if (sessionId === activeConversationId.value || isResponding.value) {
      return;
    }

    activeConversationId.value = sessionId;
    input.value = "";
    errorMessage.value = "";
    noticeMessage.value = "";
    persistSessions();
    closeSidebar();
  }

  function createNewSession() {
    // 如果正在生成回答，则不允许创建新会话，避免用户误操作导致当前回答被中断
    if (isResponding.value) {
      return;
    }

    const session = createSession();
    sessions.value = [
      session,
      ...sessions.value.filter((item) => item.id !== session.id),
    ];
    activeConversationId.value = session.id;
    input.value = "";
    errorMessage.value = "";
    noticeMessage.value = "已创建新的对话。";
    persistSessions();
    closeSidebar();
  }

  function deleteSession(sessionId: string) {
    if (isResponding.value || sessions.value.length === 1) {
      return;
    }

    const nextSessions = sessions.value.filter(
      (session) => session.id !== sessionId,
    );
    // 只剩一个不能删除
    if (!nextSessions.length) {
      return;
    }

    sessions.value = nextSessions;
    if (activeConversationId.value === sessionId) {
      activeConversationId.value = nextSessions[0].id;
    }
    noticeMessage.value = "会话已删除。";
    errorMessage.value = "";
    persistSessions();
  }

  // 这个好像没用到？
  function clearMessages() {
    if (isResponding.value) {
      return;
    }

    activeSession.value.messages = [
      createInitialAssistantMessage(
        "新的会话已开始。你可以继续提问，或者上传文件后让我使用向量知识库来辅助回答。",
      ),
    ];
    activeSession.value.updatedAt = Date.now();
    activeSession.value.title = "新对话";
    input.value = "";
    errorMessage.value = "";
    noticeMessage.value = "当前会话已清空。";
    persistSessions();
  }

  // 这个好像也没用到
  function startFreshConversation() {
    createNewSession();
  }

  function toggleRag() {
    ragEnabled.value = !ragEnabled.value;
    noticeMessage.value = ragEnabled.value
      ? "已启用 RAG 检索。"
      : "已关闭 RAG 检索。";
  }

  // 有bug 后续我自己来修改
  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value;
  }

  function closeSidebar() {
    sidebarOpen.value = false;
  }

  function stopStreaming() {
    abortController.value?.abort();
    abortController.value = null;
    isResponding.value = false;

    // 如果已经输出过内容，就把它当作一条已完成的部分回答。如果一点内容都没有，就标成 error
    const assistantMessage = [...activeSession.value.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" && message.status === "streaming",
      );
    if (assistantMessage) {
      assistantMessage.status = assistantMessage.content.trim()
        ? "done"
        : "error";
      if (!assistantMessage.content.trim()) {
        assistantMessage.content = "已停止本次输出。";
      }
    }

    noticeMessage.value = "已停止生成。";
    touchActiveSession();
  }

  async function sendMessage(raw?: string) {
    const content = (raw ?? input.value).trim();
    if (!content || isResponding.value) {
      return;
    }

    errorMessage.value = "";
    noticeMessage.value = "";

    const userMessage = createMessage("user", content);
    activeSession.value.messages.push(userMessage);
    input.value = "";
    isResponding.value = true;
    touchActiveSession();

    // 提前创建一个状态为 streaming 的 assistant 消息占位，等后端返回内容后再更新这个消息，这样可以实现边生成边显示的效果
    const assistantMessageDraft: ChatMessage = {
      id: uid("assistant"),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      status: "streaming",
      citations: [],
      tools: [],
    };

    activeSession.value.messages.push(assistantMessageDraft);
    // assistantMessage 不是复制出来的一份消息，而是指向 messages 数组中的那个消息对象
    const assistantMessage = activeSession.value.messages[
      activeSession.value.messages.length - 1
    ] as ChatMessage;
    touchActiveSession();

    const controller = new AbortController();
    abortController.value = controller;

    try {
      await streamAgentChat(
        [
          ...(ragEnabled.value
            ? []
            : [
                {
                  role: "user" as const,
                  content:
                    "请注意：本轮对话用户关闭了 RAG，如果不是必须，不要调用 retrieve_knowledge。",
                },
              ]),
          // 不包含新创建的 assistant 消息
          ...toConversationMessages(activeSession.value.messages.slice(0, -1)),
        ],
        (event) => {
          // 处理 token 事件，把新 token 追加到 assistantMessage.content 上，这样界面上就会边生成边显示
          if (event.type === "token" && event.token) {
            assistantMessage.content += event.token;
            touchActiveSession();
          }

          // 处理工具调用事件，后端可能会多次返回同一个工具的更新状态，这时需要合并到当前消息的工具列表中，而不是追加新的工具
          if (event.type === "tool" && event.tool) {
            mergeTool(
              assistantMessage.tools ?? (assistantMessage.tools = []),
              event.tool,
            );
            touchActiveSession();
          }

          // 处理参考来源
          if (event.type === "citations" && event.citations) {
            assistantMessage.citations = event.citations;
            touchActiveSession();
          }

          if (event.type === "error") {
            assistantMessage.status = "error";
            assistantMessage.content = event.details
              ? `${event.message || "请求失败"}\n${event.details}`
              : event.message || "请求失败";
            errorMessage.value = assistantMessage.content;
            touchActiveSession();
          }

          // done 是一次流式请求的结束事件。它可能带最终版 citations/tools，所以这里会覆盖一次。如果消息之前没有进入 error 状态，就标记为 done
          if (event.type === "done") {
            if (event.citations?.length) {
              assistantMessage.citations = event.citations;
            }
            if (event.tools?.length) {
              assistantMessage.tools = event.tools;
            }
            if (assistantMessage.status !== "error") {
              assistantMessage.status = "done";
            }
            touchActiveSession();
          }
        },
        // 传给后端 options 参数，包含是否启用 RAG 和知识库里是否有文档，这样后端可以根据这些信息来决定是否调用向量检索和工具调用
        controller.signal,
        {
          hasKnowledge: documentCount.value > 0,
          ragEnabled: ragEnabled.value,
        },
      );

      // 即使没有收到 done 事件，只要请求没有被 abort，且没有 error，也把消息设为 done
      if (!controller.signal.aborted && assistantMessage.status !== "error") {
        assistantMessage.status = "done";
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      // 如果不是 abort，比如网络错误、后端错误，就把当前 assistant 消息改成 error
      assistantMessage.status = "error";
      assistantMessage.content =
        error instanceof Error ? error.message : "请求失败，请稍后重试。";
      errorMessage.value = assistantMessage.content;
    } finally {
      if (abortController.value === controller) {
        abortController.value = null;
      }
      isResponding.value = false;
      touchActiveSession();
    }
  }

  return {
    activeConversationId,
    activeSession,
    appendInput,
    clearKnowledge,
    clearMessages,
    closeSidebar,
    createNewSession,
    deleteSession,
    documentCount,
    documents,
    errorMessage,
    input,
    isResponding,
    messageCount,
    messages,
    noticeMessage,
    ragEnabled,
    refreshDocuments,
    removeDocument,
    sendMessage,
    sessionList,
    sidebarOpen,
    startFreshConversation,
    stopStreaming,
    switchSession,
    toggleRag,
    toggleSidebar,
    uploadKnowledge,
  };
});
