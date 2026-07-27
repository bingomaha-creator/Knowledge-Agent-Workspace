<template>
  <main class="yuan-agent-page">
    <div v-if="sidebarOpen" class="mobile-mask" @click="closeSidebar"></div>

    <section class="app-layout">
      <aside class="sidebar-shell" :class="{ 'sidebar-open': sidebarOpen }">
        <div class="sidebar-topbar mobile-only">
          <button class="nav-icon-button" @click="closeSidebar">✕</button>
          <span>菜单</span>
        </div>

        <div class="sidebar-branding">
          <div class="logo-glyph" aria-hidden="true">
            <span class="logo-core">✦</span>
            <span class="logo-orbit logo-orbit-a"></span>
            <span class="logo-orbit logo-orbit-b"></span>
          </div>
          <div class="brand-copy">
            <p class="sidebar-overline">Matthew's AI workspace</p>
            <h2>Matthew's Workspace</h2>
            <span class="brand-subline">你的 AI 知识协作台</span>
          </div>
        </div>

        <nav class="sidebar-nav">
          <button class="nav-entry nav-entry-primary" :disabled="chatStore.isResponding" @click="startFreshConversation">
            发起新对话
          </button>
        </nav>

        <SessionPanel
          :active-session-id="chatStore.activeSessionId"
          :disabled="chatStore.isResponding"
          :sessions="chatStore.sessionList"
          @delete-session="chatStore.deleteSession"
          @new-session="startFreshConversation"
          @switch-session="switchConversation"
        />

        <KnowledgeSidebarSummary
          :base-count="knowledgeStore.knowledgeBases.length"
          :selected-document-count="selectedDocumentCount"
          @navigate="navigateWorkspace('knowledge')"
        />

        <MemorySidebarSummary
          :candidate-count="memoryCandidateCount"
          :total-count="memoryStore.memories.length"
          @navigate="navigateWorkspace('memory')"
        />
        <div class="sidebar-footer">
          <button class="nav-entry">设置和帮助</button>
        </div>
      </aside>

      <section class="main-shell">
        <div class="main-content-frame">
          <TopBar
            :active-workspace="activeWorkspace"
            :conversation-id="chatStore.activeSessionId"
            :document-count="selectedDocumentCount"
            :message-count="chatStore.messageCount"
            @menu="toggleSidebar"
            @workspace="navigateWorkspace"
          />

          <KnowledgePanel
            v-if="activeWorkspace === 'knowledge'"
            :active-knowledge-base-id="knowledgeStore.activeKnowledgeBaseId"
            :busy-document-ids="knowledgeStore.busyDocumentIds"
            :documents="knowledgeStore.documents"
            :error-message="knowledgeStore.errorMessage"
            :knowledge-bases="knowledgeStore.knowledgeBases"
            :notice-message="knowledgeStore.noticeMessage"
            :selected-preview="knowledgeStore.selectedPreview"
            :selected-knowledge-base-ids="chatStore.selectedKnowledgeBaseIds"
            @clear="knowledgeStore.clearDocuments"
            @create-base="createKnowledgeBase"
            @delete-base="deleteKnowledgeBase"
            @close-preview="knowledgeStore.closePreview"
            @preview="knowledgeStore.previewDocument"
            @publish="knowledgeStore.publishDocument"
            @remove="knowledgeStore.removeDocument"
            @select-base="knowledgeStore.selectBase"
            @toggle-retrieval="chatStore.toggleKnowledgeBase"
            @upload="knowledgeStore.uploadDocuments"
            @withdraw="knowledgeStore.withdrawDocument"
          />

          <MemoryPanel
            v-else-if="activeWorkspace === 'memory'"
            :busy-ids="memoryStore.busyIds"
            :creating="memoryStore.creating"
            :error-message="memoryStore.errorMessage"
            :failed-ids="memoryStore.failedIds"
            :memories="memoryStore.memories"
            :notice-message="memoryStore.noticeMessage"
            @create="createMemory"
            @edit="correctMemory"
            @open-source="openMemorySource"
            @remove="removeMemory"
            @review="reviewMemory"
          />

          <BugKnowledgePanel v-else-if="activeWorkspace === 'bugs'" />

          <ResearchWorkspace
            v-else-if="activeWorkspace === 'research' && researchReady"
            :default-knowledge-base-ids="chatStore.selectedKnowledgeBaseIds"
            :knowledge-bases="knowledgeStore.knowledgeBases"
          />

          <section v-else-if="activeWorkspace === 'research'" class="research-workspace-loading">
            正在同步研究任务…
          </section>

          <template v-else>
            <AsyncChatPanel
              :memory-busy-ids="memoryStore.busyIds"
              :memory-failed-ids="memoryStore.failedIds"
              :messages="chatStore.messages"
              @bug-investigation="beginBugInvestigationFromChat"
              @correct-memory="correctMemory"
              @research="beginResearchFromChat"
              @review-memory="reviewMemory"
            />

            <div v-if="chatStore.noticeMessage" class="notice-banner">{{ chatStore.noticeMessage }}</div>
            <div v-if="chatStore.errorMessage" class="error-banner">{{ chatStore.errorMessage }}</div>

            <ComposerPanel
              v-model="chatStore.input"
              :disabled="chatStore.isResponding"
              :document-count="selectedDocumentCount"
              :knowledge-bases="knowledgeStore.knowledgeBases"
              :is-responding="chatStore.isResponding"
              :preset-id="chatStore.activeSession.presetId || 'general'"
              :presets="chatStore.presets"
              :rag-enabled="chatStore.ragEnabled"
              :selected-knowledge-base-ids="chatStore.selectedKnowledgeBaseIds"
              :voice-error="speech.error.value"
              :voice-status="speech.status.value"
              :voice-supported="speech.supported.value"
              @submit="sendMessage"
              @preset="setPreset"
              @stop="chatStore.stop"
              @toggle-knowledge-base="toggleKnowledgeScope"
              @toggle-rag="chatStore.toggleRag"
              @voice="handleVoice"
            />
          </template>
        </div>
      </section>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ComposerPanel from '@/components/ComposerPanel.vue';
import KnowledgePanel from '@/components/KnowledgePanel.vue';
import KnowledgeSidebarSummary from '@/features/knowledge/components/KnowledgeSidebarSummary.vue';
import MemoryPanel from '@/features/memory/components/MemoryPanel.vue';
import MemorySidebarSummary from '@/features/memory/components/MemorySidebarSummary.vue';
import SessionPanel from '@/components/SessionPanel.vue';
import TopBar from '@/components/TopBar.vue';
import BugKnowledgePanel from '@/features/bug-knowledge/components/BugKnowledgePanel.vue';
import { useKnowledgeStore } from '@/features/knowledge/store';
import { useMemoryStore } from '@/features/memory/store';
import type { MemoryCreateInput } from '@/features/memory/types';
import ResearchWorkspace from '@/features/research/components/ResearchWorkspace.vue';
import { useResearchStore } from '@/features/research/store';
import { useBugInvestigationStore } from '@/features/bug-knowledge/investigation-store';
import { useSpeechRecognition } from '@/composables/useSpeechRecognition';
import { useChatStore } from '@/features/chat/store';

/**
 * App.vue 是前端的“组装层”：它不复制业务状态，只把 Pinia store 的源状态向下传给各面板，
 * 再把子组件的 emit 事件连回 store action。因此数据流是单向的：
 *
 *   store 状态 -> props -> 子组件渲染
 *   用户操作 -> emits -> store action -> store 状态更新 -> 重新渲染
 *
 * 学习时可以把 App.vue 当作“功能地图”，顺着每个 @event 追踪到对应 feature Store 的 action。
 */

// 聊天列表可能包含较多 Markdown、引用和 run timeline，所以拆成异步 chunk；
// 首屏其他控件仍可先渲染，加载完成后 Vue 会自动替换占位内容。
const AsyncChatPanel = defineAsyncComponent(() => import('@/components/ChatPanel.vue'));
const route = useRoute();
const router = useRouter();
type WorkspaceId = 'chat' | 'knowledge' | 'memory' | 'bugs' | 'research';
const activeWorkspace = computed<WorkspaceId>(() => {
  if (route.name === 'knowledge') return 'knowledge';
  if (route.name === 'memory') return 'memory';
  if (route.name === 'bugs') return 'bugs';
  if (route.name === 'research' || route.name === 'research-task') return 'research';
  return 'chat';
});

// 各领域 module 拥有自己的真相源；Workspace 只组合稳定 ID 与用户意图。
const chatStore = useChatStore();
const knowledgeStore = useKnowledgeStore();
const memoryStore = useMemoryStore();
const researchStore = useResearchStore();
const bugInvestigationStore = useBugInvestigationStore();
const researchReady = ref(false);
const sidebarOpen = ref(false);
const selectedDocumentCount = computed(() =>
  knowledgeStore.knowledgeBases
    .filter((base) => chatStore.selectedKnowledgeBaseIds.includes(base.id))
    .reduce((sum, base) => sum + base.publishedDocumentCount, 0)
);
const memoryCandidateCount = computed(
  () => memoryStore.memories.filter((memory) => memory.status === 'candidate').length
);
// 语音识别的回调只把识别文本填入编辑框，不会自动发送；用户仍有最后确认权。
const speech = useSpeechRecognition((text) => {
  chatStore.setDraft(text);
});

// 各 module 独立恢复；Knowledge 与 Research 可并行，Chat/Memory 不阻塞工作区首屏。
onMounted(async () => {
  void chatStore.initialize();
  const [knowledgeReady, memoryReady] = await Promise.all([
    knowledgeStore.initialize(),
    memoryStore.initialize(),
    researchStore.initialize()
  ]);
  if (knowledgeReady) {
    chatStore.syncKnowledgeCatalog(
      knowledgeStore.knowledgeBases.map((base) => base.id)
    );
  }
  if (memoryReady) {
    chatStore.syncMemoryProjections(memoryStore.memories);
  }
  researchReady.value = true;
});

onBeforeUnmount(() => {
  chatStore.dispose();
  knowledgeStore.dispose();
  researchStore.dispose();
});

function navigateWorkspace(workspace: WorkspaceId) {
  closeSidebar();
  void router.push(`/${workspace}`);
}

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value;
}

function closeSidebar() {
  sidebarOpen.value = false;
}

function startFreshConversation() {
  chatStore.startSession(knowledgeStore.knowledgeBases.map((base) => base.id));
  navigateWorkspace('chat');
}

function switchConversation(id: string) {
  chatStore.selectSession(id);
  navigateWorkspace('chat');
}

function setPreset(id: string) {
  chatStore.setPreset(id, knowledgeStore.knowledgeBases.map((base) => base.id));
}

function toggleKnowledgeScope(id: string) {
  chatStore.toggleKnowledgeBase(id, !chatStore.selectedKnowledgeBaseIds.includes(id));
}

async function createKnowledgeBase(name: string) {
  const created = await knowledgeStore.createBase(name);
  if (created) {
    chatStore.syncKnowledgeCatalog(
      knowledgeStore.knowledgeBases.map((base) => base.id),
      { includeInActiveSession: created.id }
    );
  }
}

async function deleteKnowledgeBase(id: string) {
  const base = knowledgeStore.knowledgeBases.find((item) => item.id === id);
  if (!base || base.isDefault) return;
  if (
    typeof window !== 'undefined'
    && !window.confirm(`删除资料库“${base.name}”及其全部文档？此操作不可撤销。`)
  ) return;
  if (await knowledgeStore.deleteBase(id)) {
    chatStore.syncKnowledgeCatalog(
      knowledgeStore.knowledgeBases
        .map((item) => item.id)
        .filter((knowledgeBaseId) => knowledgeBaseId !== id)
    );
  }
}

async function reviewMemory(id: string, decision: 'confirmed' | 'rejected') {
  const updated = await memoryStore.review(id, decision);
  if (updated) chatStore.syncMemoryProjections(memoryStore.memories);
}

async function createMemory(input: MemoryCreateInput) {
  const created = await memoryStore.create(input);
  if (created) chatStore.syncMemoryProjections(memoryStore.memories);
}

async function correctMemory(id: string, patch: Parameters<typeof memoryStore.correct>[1]) {
  const updated = await memoryStore.correct(id, patch);
  if (updated) chatStore.syncMemoryProjections(memoryStore.memories);
}

async function removeMemory(id: string) {
  if (await memoryStore.remove(id)) chatStore.syncMemoryProjections(memoryStore.memories);
}

async function sendMessage() {
  const result = await chatStore.send();
  if (result?.memoryCandidates.length) {
    memoryStore.ingest(result.memoryCandidates);
  }
}

function openMemorySource(memory: { sourceConversationId: string }) {
  if (!memory.sourceConversationId) return;
  if (chatStore.selectSession(memory.sourceConversationId)) navigateWorkspace('chat');
}

function beginResearchFromChat(seed: { question: string; sourceMessageId: string }) {
  researchStore.startDraft({
    ...seed,
    knowledgeBaseIds: [...chatStore.selectedKnowledgeBaseIds],
    sourceSessionId: chatStore.activeSessionId
  });
  navigateWorkspace('research');
}

function beginBugInvestigationFromChat(seed: { content: string; sourceMessageId: string }) {
  bugInvestigationStore.startDraft({
    evidence: {
      type: 'error',
      content: seed.content,
      metadata: {}
    },
    sourceMessageId: seed.sourceMessageId,
    sourceSessionId: chatStore.activeSessionId
  });
  navigateWorkspace('bugs');
}

// 同一按钮根据当前语音状态在“开始”和“停止”之间切换；
// 中间态不做处理，避免并发启动多个识别任务。
function handleVoice() {
  if (speech.status.value === 'recording') {
    speech.stop();
    return;
  }

  if (speech.status.value === 'idle') {
    speech.start();
  }
}
</script>
