import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { chatHttpTransport } from './api';
import { persistChatSessions, restoreChatSessions } from './session-persistence';
import { reduceStreamEvent } from './stream-event-reducer';
import type { MemoryRecord } from '@/features/memory/types';
import type {
  AgentPreset,
  ChatMessage,
  ChatSession,
  ChatTransport,
  QwenMessage
} from './types';

const DEFAULT_KNOWLEDGE_BASE_ID = 'kb-default';
const CHAT_TRANSPORT_MAX_MESSAGES = 100;
const CHAT_TRANSPORT_MAX_CHARACTERS = 200_000;

const FALLBACK_PRESETS: AgentPreset[] = [{
  id: 'general',
  name: '通用助手',
  description: '适合日常问答与通用协作。',
  systemPrompt: '',
  modelParameters: { temperature: 0.4 },
  toolWhitelist: [],
  defaultKnowledgeBaseIds: [DEFAULT_KNOWLEDGE_BASE_ID],
  fewShot: []
}, {
  id: 'documents',
  name: '资料助手',
  description: '优先在选定知识库中查证和引用。',
  systemPrompt: '',
  modelParameters: { temperature: 0.2 },
  toolWhitelist: [],
  defaultKnowledgeBaseIds: [DEFAULT_KNOWLEDGE_BASE_ID],
  fewShot: []
}, {
  id: 'code',
  name: '代码助手',
  description: '关注可执行实现、边界和验证。',
  systemPrompt: '',
  modelParameters: { temperature: 0.2 },
  toolWhitelist: [],
  defaultKnowledgeBaseIds: [],
  fewShot: []
}, {
  id: 'research',
  name: '研究助手',
  description: '拆分问题、组织证据并标记推断。',
  systemPrompt: '',
  modelParameters: { temperature: 0.3 },
  toolWhitelist: [],
  defaultKnowledgeBaseIds: [DEFAULT_KNOWLEDGE_BASE_ID],
  fewShot: []
}];

type ChatStorage = Pick<Storage, 'getItem' | 'setItem'>;

interface ChatStoreOptions {
  storeId?: string;
  storage?: ChatStorage;
  createId?: (prefix: string) => string;
  now?: () => number;
  persistDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function createChatStore(
  transport: ChatTransport,
  options: ChatStoreOptions = {}
) {
  const storeId = options.storeId || 'chat';
  const now = options.now || Date.now;
  const persistDelayMs = options.persistDelayMs ?? 250;
  const sleep = options.sleep || ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const createId = options.createId || ((prefix: string) => `${prefix}-${crypto.randomUUID()}`);

  return defineStore(storeId, () => {
    function createMessage(role: ChatMessage['role'], content: string): ChatMessage {
      return {
        id: createId(role),
        role,
        content,
        createdAt: now(),
        status: 'idle'
      };
    }

    function createInitialAssistantMessage(content: string) {
      const message = createMessage('assistant', content);
      message.status = 'done';
      return message;
    }

    function createSession(
      title = '新对话',
      presetId = 'general',
      knowledgeBaseIds = [DEFAULT_KNOWLEDGE_BASE_ID]
    ): ChatSession {
      const timestamp = now();
      return {
        id: createId('session'),
        title,
        createdAt: timestamp,
        updatedAt: timestamp,
        knowledgeBaseIds: [...knowledgeBaseIds],
        presetId,
        messages: [
          createInitialAssistantMessage(
            "你好，我是 Matthew's Workspace 助手。你可以直接提问，也可以先上传资料，让我通过后端向量检索结合工具调用来回答。"
          )
        ]
      };
    }

    const restored = restoreChatSessions({
      storage: options.storage,
      createSession,
      createInitialAssistantMessage,
      now
    });
    const sessions = ref<ChatSession[]>(restored.sessions);
    const activeSessionId = ref(restored.activeSessionId || restored.sessions[0].id);
    const presets = ref<AgentPreset[]>(FALLBACK_PRESETS);
    const errorMessage = ref('');
    const noticeMessage = ref('');
    const input = ref('');
    const isResponding = ref(false);
    const ragEnabled = ref(true);
    let activeController: AbortController | null = null;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    const activeSession = computed(() =>
      sessions.value.find((session) => session.id === activeSessionId.value)
      || sessions.value[0]
    );
    const messages = computed(() => activeSession.value.messages);
    const messageCount = computed(() => messages.value.length);
    const selectedKnowledgeBaseIds = computed(() => activeSession.value.knowledgeBaseIds);
    const sessionList = computed(() =>
      [...sessions.value].sort((left, right) => right.updatedAt - left.updatedAt)
    );

    async function initialize() {
      errorMessage.value = '';
      try {
        const nextPresets = await transport.listPresets();
        presets.value = nextPresets.length ? nextPresets : FALLBACK_PRESETS;
        const validPresetIds = new Set(presets.value.map((preset) => preset.id));
        const fallbackPresetId = validPresetIds.has('general')
          ? 'general'
          : presets.value[0]?.id || 'general';
        let changed = false;
        for (const session of sessions.value) {
          if (!session.presetId || !validPresetIds.has(session.presetId)) {
            session.presetId = fallbackPresetId;
            changed = true;
          }
        }
        if (changed) persist();
        return true;
      } catch (error) {
        presets.value = FALLBACK_PRESETS;
        errorMessage.value = error instanceof Error ? error.message : '加载角色预设失败';
        return false;
      }
    }

    function persist() {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      persistChatSessions({
        sessions: sessions.value,
        activeSessionId: activeSessionId.value,
        storage: options.storage
      });
    }

    function schedulePersist() {
      if (persistDelayMs === 0) {
        persist();
        return;
      }
      if (persistTimer) return;
      persistTimer = setTimeout(persist, persistDelayMs);
    }

    function touchActiveSession(deferred = false) {
      activeSession.value.updatedAt = now();
      const firstUserMessage = activeSession.value.messages.find(
        (message) => message.role === 'user' && message.content.trim()
      );
      activeSession.value.title = firstUserMessage?.content.trim().slice(0, 24) || '新对话';
      if (deferred) schedulePersist();
      else persist();
    }

    function toConversationMessages(source: ChatMessage[]): QwenMessage[] {
      const eligible = source
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .slice(-CHAT_TRANSPORT_MAX_MESSAGES);
      const selected: QwenMessage[] = [];
      let characters = 0;
      for (const message of [...eligible].reverse()) {
        if (selected.length && characters + message.content.length > CHAT_TRANSPORT_MAX_CHARACTERS) {
          break;
        }
        selected.push({
          id: message.id,
          role: message.role,
          content: message.content
        });
        characters += message.content.length;
      }
      return selected.reverse();
    }

    function presetKnowledgeBaseIds(preset: AgentPreset, validIds?: string[]) {
      if (!validIds) return [...preset.defaultKnowledgeBaseIds];
      const valid = new Set(validIds);
      return preset.defaultKnowledgeBaseIds.filter((id) => valid.has(id));
    }

    function setPreset(id: string, validKnowledgeBaseIds?: string[]) {
      if (isResponding.value) return false;
      const preset = presets.value.find((candidate) => candidate.id === id);
      if (!preset) {
        errorMessage.value = '未知的角色预设。';
        return false;
      }
      activeSession.value.presetId = preset.id;
      activeSession.value.knowledgeBaseIds = presetKnowledgeBaseIds(
        preset,
        validKnowledgeBaseIds
      );
      activeSession.value.updatedAt = now();
      noticeMessage.value = `已切换为“${preset.name}”，并应用其默认知识库范围。`;
      errorMessage.value = '';
      persist();
      return true;
    }

    function startSession(validKnowledgeBaseIds?: string[]) {
      if (isResponding.value) return false;
      const currentPreset = presets.value.find(
        (preset) => preset.id === activeSession.value.presetId
      ) || presets.value[0] || FALLBACK_PRESETS[0];
      const session = createSession(
        '新对话',
        currentPreset.id,
        presetKnowledgeBaseIds(currentPreset, validKnowledgeBaseIds)
      );
      sessions.value = [session, ...sessions.value];
      activeSessionId.value = session.id;
      input.value = '';
      noticeMessage.value = '已创建新的对话。';
      errorMessage.value = '';
      persist();
      return true;
    }

    function syncKnowledgeCatalog(
      validIds: string[],
      options: { includeInActiveSession?: string } = {}
    ) {
      const valid = new Set(validIds);
      let changed = false;
      for (const session of sessions.value) {
        const nextIds = session.knowledgeBaseIds.filter((id) => valid.has(id));
        if (
          nextIds.length !== session.knowledgeBaseIds.length
          || nextIds.some((id, index) => id !== session.knowledgeBaseIds[index])
        ) {
          session.knowledgeBaseIds = nextIds;
          changed = true;
        }
      }
      const includeId = options.includeInActiveSession?.trim();
      if (
        includeId
        && valid.has(includeId)
        && !activeSession.value.knowledgeBaseIds.includes(includeId)
      ) {
        activeSession.value.knowledgeBaseIds = [
          ...activeSession.value.knowledgeBaseIds,
          includeId
        ];
        changed = true;
      }
      if (changed) persist();
    }

    function toggleKnowledgeBase(id: string, selected: boolean) {
      const current = new Set(activeSession.value.knowledgeBaseIds);
      if (selected) current.add(id);
      else current.delete(id);
      activeSession.value.knowledgeBaseIds = [...current];
      activeSession.value.updatedAt = now();
      persist();
    }

    function stop() {
      activeController?.abort();
      const assistantMessage = [...activeSession.value.messages]
        .reverse()
        .find((message) =>
          message.role === 'assistant' && message.status === 'streaming'
        );
      if (assistantMessage) {
        assistantMessage.status = assistantMessage.content.trim() ? 'done' : 'error';
        if (!assistantMessage.content.trim()) {
          assistantMessage.content = '已停止本次输出。';
        }
      }
      noticeMessage.value = '已停止生成。';
      touchActiveSession();
    }

    function syncMemoryProjections(records: MemoryRecord[]) {
      const memoriesById = new Map(records.map((memory) => [memory.id, memory]));
      let changed = false;
      for (const session of sessions.value) {
        for (const message of session.messages) {
          const id = message.memoryCandidate?.id;
          if (!id) continue;
          const memory = memoriesById.get(id);
          if (memory) {
            message.memoryCandidate = memory;
            message.memoryStatus = memory.status;
          } else {
            delete message.memoryCandidate;
            delete message.memoryStatus;
          }
          changed = true;
        }
      }
      if (changed) persist();
    }

    function selectSession(id: string) {
      if (isResponding.value) return false;
      if (!sessions.value.some((session) => session.id === id)) return false;
      activeSessionId.value = id;
      input.value = '';
      errorMessage.value = '';
      noticeMessage.value = '';
      persist();
      return true;
    }

    function deleteSession(id: string) {
      if (isResponding.value || sessions.value.length <= 1) return false;
      const nextSessions = sessions.value.filter((session) => session.id !== id);
      if (nextSessions.length === sessions.value.length || !nextSessions.length) return false;
      sessions.value = nextSessions;
      if (activeSessionId.value === id) {
        activeSessionId.value = nextSessions[0].id;
      }
      noticeMessage.value = '会话已删除。';
      errorMessage.value = '';
      persist();
      return true;
    }

    function setDraft(value: string) {
      input.value = value;
    }

    function toggleRag() {
      ragEnabled.value = !ragEnabled.value;
      noticeMessage.value = ragEnabled.value
        ? '已启用 RAG 检索。'
        : '已关闭 RAG 检索。';
    }

    function dispose() {
      if (activeController) stop();
      persist();
    }

    async function send(raw?: string) {
      const content = (raw ?? input.value).trim();
      if (!content || isResponding.value) {
        return { memoryCandidates: [] as MemoryRecord[] };
      }

      errorMessage.value = '';
      noticeMessage.value = '';
      const producedMemoryCandidates: MemoryRecord[] = [];
      const userMessage = createMessage('user', content);
      activeSession.value.messages.push(userMessage);
      input.value = '';
      isResponding.value = true;
      touchActiveSession();

      const assistantMessageSeed = createMessage('assistant', '');
      assistantMessageSeed.status = 'streaming';
      assistantMessageSeed.citations = [];
      assistantMessageSeed.tools = [];
      activeSession.value.messages.push(assistantMessageSeed);
      const assistantMessage =
        activeSession.value.messages[activeSession.value.messages.length - 1];
      touchActiveSession();

      const controller = new AbortController();
      activeController = controller;
      let streamFailed = false;
      try {
        const request = {
          messages: toConversationMessages(activeSession.value.messages.slice(0, -1)),
          hasKnowledge: selectedKnowledgeBaseIds.value.length > 0,
          ragEnabled: ragEnabled.value,
          knowledgeBaseIds: [...selectedKnowledgeBaseIds.value],
          conversationId: activeSessionId.value,
          sourceMessageIds: [userMessage.id, assistantMessage.id],
          presetId: activeSession.value.presetId || 'general'
        };
        for await (const event of transport.stream(request, controller.signal)) {
          if (controller.signal.aborted || activeController !== controller) break;
          const reduction = reduceStreamEvent({
            message: assistantMessage,
            event,
            errorMessage: errorMessage.value
          });
          if (reduction.persistence === 'none') continue;
          Object.assign(assistantMessage, reduction.message);
          streamFailed ||= reduction.message.status === 'error';
          if (reduction.memoryCandidate) {
            const existing = producedMemoryCandidates.findIndex(
              (memory) => memory.id === reduction.memoryCandidate?.id
            );
            if (existing < 0) producedMemoryCandidates.push(reduction.memoryCandidate);
            else producedMemoryCandidates[existing] = reduction.memoryCandidate;
          }
          errorMessage.value = reduction.errorMessage;
          touchActiveSession(reduction.persistence === 'deferred');
        }
        if (!controller.signal.aborted && !streamFailed) {
          assistantMessage.status = 'done';
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          assistantMessage.status = 'error';
          assistantMessage.content = error instanceof Error
            ? error.message
            : '请求失败，请稍后重试。';
          errorMessage.value = assistantMessage.content;
        }
      } finally {
        if (assistantMessage.run?.id && assistantMessage.run.status === 'running') {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const run = await transport.getRun(assistantMessage.run.id);
              assistantMessage.run = run;
              if (run.status !== 'running') break;
            } catch {
              break;
            }
            await sleep(75);
          }
        }
        if (activeController === controller) {
          activeController = null;
          isResponding.value = false;
        }
        touchActiveSession();
      }
      return { memoryCandidates: producedMemoryCandidates };
    }

    return {
      sessions,
      activeSessionId,
      activeSession,
      messages,
      messageCount,
      selectedKnowledgeBaseIds,
      sessionList,
      presets,
      errorMessage,
      noticeMessage,
      input,
      isResponding,
      ragEnabled,
      initialize,
      setPreset,
      startSession,
      syncKnowledgeCatalog,
      toggleKnowledgeBase,
      send,
      stop,
      syncMemoryProjections,
      selectSession,
      deleteSession,
      setDraft,
      toggleRag,
      dispose
    };
  });
}

export const useChatStore = createChatStore(chatHttpTransport);
