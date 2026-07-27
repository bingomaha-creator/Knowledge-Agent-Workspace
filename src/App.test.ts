// @vitest-environment happy-dom

import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';

const chatStore = vi.hoisted(() => ({
  isResponding: false,
  activeSessionId: 'session-1',
  sessionList: [],
  selectedKnowledgeBaseIds: ['kb-1'],
  memoryBusyIds: [],
  memories: [],
  messageCount: 2,
  ragEnabled: true,
  activeSession: { presetId: 'general' },
  presets: [],
  messages: [],
  noticeMessage: '',
  errorMessage: '',
  input: '',
  startSession: vi.fn(),
  deleteSession: vi.fn(),
  selectSession: vi.fn(() => true),
  toggleKnowledgeBase: vi.fn(),
  editMemory: vi.fn(),
  openMemorySource: vi.fn(),
  removeMemory: vi.fn(),
  reviewMemory: vi.fn(),
  stop: vi.fn(),
  toggleRag: vi.fn(),
  setPreset: vi.fn(),
  send: vi.fn(),
  setDraft: vi.fn(),
  initialize: vi.fn(),
  syncKnowledgeCatalog: vi.fn(),
  syncMemoryProjections: vi.fn(),
  dispose: vi.fn()
}));

const memoryStore = vi.hoisted(() => {
  const record = {
    id: 'memory-1',
    type: 'fact',
    title: '项目事实',
    content: '使用 Vue',
    details: {},
    confidence: 0.8,
    status: 'candidate',
    sourceConversationId: 'session-1',
    sourceMessageIds: [],
    sourceExcerpt: '',
    createdAt: 1,
    updatedAt: 1
  };
  return {
    memories: [record],
    busyIds: [],
    failedIds: [],
    creating: false,
    noticeMessage: '',
    errorMessage: '',
    initialize: vi.fn(async () => true),
    ingest: vi.fn(),
    create: vi.fn(),
    review: vi.fn(),
    correct: vi.fn(),
    remove: vi.fn(),
    refresh: vi.fn()
  };
});

const knowledgeStore = vi.hoisted(() => ({
  activeKnowledgeBaseId: 'kb-1',
  documents: [],
  knowledgeBases: [{ id: 'kb-1', name: '默认知识库', isDefault: true, documentCount: 0, publishedDocumentCount: 0, draftDocumentCount: 0, createdAt: 1, updatedAt: 1 }],
  selectedPreview: null,
  busyDocumentIds: [],
  noticeMessage: '',
  errorMessage: '',
  initialize: vi.fn(async () => true),
  createBase: vi.fn(),
  deleteBase: vi.fn(),
  selectBase: vi.fn(),
  uploadDocuments: vi.fn(),
  removeDocument: vi.fn(),
  clearDocuments: vi.fn(),
  previewDocument: vi.fn(),
  closePreview: vi.fn(),
  publishDocument: vi.fn(),
  withdrawDocument: vi.fn(),
  dispose: vi.fn()
}));

const researchStore = vi.hoisted(() => ({
  activeTaskCount: 0,
  startDraft: vi.fn(),
  initialize: vi.fn(),
  dispose: vi.fn()
}));

const bugInvestigationStore = vi.hoisted(() => ({
  startDraft: vi.fn()
}));

vi.mock('@/features/chat/store', () => ({ useChatStore: () => chatStore }));
vi.mock('@/features/knowledge/store', () => ({ useKnowledgeStore: () => knowledgeStore }));
vi.mock('@/features/memory/store', () => ({ useMemoryStore: () => memoryStore }));
vi.mock('@/features/research/store', () => ({ useResearchStore: () => researchStore }));
vi.mock('@/features/bug-knowledge/investigation-store', () => ({
  useBugInvestigationStore: () => bugInvestigationStore
}));
vi.mock('@/composables/useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({
    error: { value: '' },
    status: { value: 'idle' },
    supported: { value: false },
    start: vi.fn(),
    stop: vi.fn()
  })
}));

import App from './App.vue';
import { createWorkspaceRouter } from './router';

describe('Workspace composition seams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    knowledgeStore.initialize.mockResolvedValue(true);
    memoryStore.initialize.mockResolvedValue(true);
  });

  it('owns the mobile sidebar lifecycle and closes it when navigating workspaces', async () => {
    const router = createWorkspaceRouter(createMemoryHistory());
    await router.push('/chat');
    await router.isReady();
    const TopBarStub = defineComponent({
      emits: ['menu', 'workspace'],
      template: `
        <button data-testid="open-sidebar" @click="$emit('menu')">menu</button>
        <button data-testid="open-bugs" @click="$emit('workspace', 'bugs')">bugs</button>
      `
    });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          AsyncChatPanel: true,
          BugKnowledgePanel: true,
          ComposerPanel: true,
          KnowledgePanel: true,
          MemoryPanel: true,
          ResearchWorkspace: true,
          SessionPanel: true,
          TopBar: TopBarStub
        }
      }
    });

    expect(wrapper.find('.mobile-mask').exists()).toBe(false);
    expect(wrapper.get('.sidebar-shell').classes()).not.toContain('sidebar-open');

    await wrapper.get('[data-testid="open-sidebar"]').trigger('click');
    expect(wrapper.find('.mobile-mask').exists()).toBe(true);
    expect(wrapper.get('.sidebar-shell').classes()).toContain('sidebar-open');

    await wrapper.get('.mobile-mask').trigger('click');
    expect(wrapper.find('.mobile-mask').exists()).toBe(false);

    await wrapper.get('[data-testid="open-sidebar"]').trigger('click');
    await wrapper.get('[data-testid="open-bugs"]').trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.fullPath).toBe('/bugs');
    expect(wrapper.find('.mobile-mask').exists()).toBe(false);
    expect(wrapper.get('.sidebar-shell').classes()).not.toContain('sidebar-open');
  });

  it('turns a Chat message intent into a Research Draft and navigates to Research', async () => {
    const router = createWorkspaceRouter(createMemoryHistory());
    await router.push('/chat');
    await router.isReady();
    const ChatStub = defineComponent({
      emits: ['research'],
      template: '<button data-testid="chat-research-seed" @click="$emit(\'research\', { question: \'架构问题\', sourceMessageId: \'message-1\' })">研究</button>'
    });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          AsyncChatPanel: ChatStub,
          BugKnowledgePanel: true,
          ComposerPanel: true,
          KnowledgePanel: true,
          MemoryPanel: true,
          ResearchWorkspace: true,
          SessionPanel: true,
          TopBar: true
        }
      }
    });

    await wrapper.get('[data-testid="chat-research-seed"]').trigger('click');
    await flushPromises();

    expect(researchStore.startDraft).toHaveBeenCalledWith({
      question: '架构问题',
      sourceMessageId: 'message-1',
      sourceSessionId: 'session-1',
      knowledgeBaseIds: ['kb-1']
    });
    expect(router.currentRoute.value.fullPath).toBe('/research');
  });

  it('turns an explicit Chat intent into an editable Bug investigation draft', async () => {
    const router = createWorkspaceRouter(createMemoryHistory());
    await router.push('/chat');
    await router.isReady();
    const ChatStub = defineComponent({
      emits: ['bug-investigation'],
      template: '<button data-testid="chat-bug-seed" @click="$emit(\'bug-investigation\', { content: \'TypeError: failed to fetch\', sourceMessageId: \'message-2\' })">调查</button>'
    });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          AsyncChatPanel: ChatStub,
          BugKnowledgePanel: true,
          ComposerPanel: true,
          KnowledgePanel: true,
          MemoryPanel: true,
          ResearchWorkspace: true,
          SessionPanel: true,
          TopBar: true
        }
      }
    });

    await wrapper.get('[data-testid="chat-bug-seed"]').trigger('click');
    await flushPromises();

    expect(bugInvestigationStore.startDraft).toHaveBeenCalledWith({
      evidence: {
        type: 'error',
        content: 'TypeError: failed to fetch',
        metadata: {}
      },
      sourceMessageId: 'message-2',
      sourceSessionId: 'session-1'
    });
    expect(router.currentRoute.value.fullPath).toBe('/bugs');
  });

  it('reconciles Chat scopes from the authoritative Knowledge catalog on startup', async () => {
    const router = createWorkspaceRouter(createMemoryHistory());
    await router.push('/chat');
    await router.isReady();
    mount(App, {
      global: {
        plugins: [router],
        stubs: {
          AsyncChatPanel: true,
          BugKnowledgePanel: true,
          ComposerPanel: true,
          KnowledgePanel: true,
          MemoryPanel: true,
          ResearchWorkspace: true,
          SessionPanel: true,
          TopBar: true
        }
      }
    });

    await flushPromises();
    expect(knowledgeStore.initialize).toHaveBeenCalledOnce();
    expect(chatStore.syncKnowledgeCatalog).toHaveBeenCalledWith(['kb-1']);
  });

  it('initializes Memory independently and reconciles Chat projections only on success', async () => {
    const router = createWorkspaceRouter(createMemoryHistory());
    await router.push('/chat');
    await router.isReady();
    mount(App, {
      global: {
        plugins: [router],
        stubs: {
          AsyncChatPanel: true,
          BugKnowledgePanel: true,
          ComposerPanel: true,
          KnowledgePanel: true,
          MemoryPanel: true,
          ResearchWorkspace: true,
          SessionPanel: true,
          TopBar: true
        }
      }
    });

    await flushPromises();
    expect(memoryStore.initialize).toHaveBeenCalledOnce();
    expect(chatStore.syncMemoryProjections).toHaveBeenCalledWith(memoryStore.memories);
  });

  it('composes Knowledge create and delete results into Chat session IDs', async () => {
    const projectBase = {
      id: 'kb-project',
      name: '项目资料',
      isDefault: false,
      documentCount: 0,
      publishedDocumentCount: 0,
      draftDocumentCount: 0,
      createdAt: 2,
      updatedAt: 2
    };
    knowledgeStore.createBase.mockResolvedValue(projectBase);
    knowledgeStore.deleteBase.mockResolvedValue(true);
    knowledgeStore.knowledgeBases = [knowledgeStore.knowledgeBases[0], projectBase];
    Object.defineProperty(window, 'confirm', {
      configurable: true,
      value: vi.fn(() => true)
    });

    const router = createWorkspaceRouter(createMemoryHistory());
    await router.push('/knowledge');
    await router.isReady();
    const KnowledgeStub = defineComponent({
      emits: ['create-base', 'delete-base'],
      template: `
        <section data-testid="knowledge-workspace">
          <button data-testid="create-base" @click="$emit('create-base', '项目资料')">创建</button>
          <button data-testid="delete-base" @click="$emit('delete-base', 'kb-project')">删除</button>
        </section>
      `
    });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          AsyncChatPanel: true,
          BugKnowledgePanel: true,
          ComposerPanel: true,
          KnowledgePanel: KnowledgeStub,
          MemoryPanel: true,
          ResearchWorkspace: true,
          SessionPanel: true,
          TopBar: true
        }
      }
    });

    expect(wrapper.find('.main-content-frame [data-testid="knowledge-workspace"]').exists()).toBe(true);
    expect(wrapper.find('.sidebar-shell [data-testid="knowledge-workspace"]').exists()).toBe(false);

    await wrapper.get('[data-testid="create-base"]').trigger('click');
    await flushPromises();
    expect(knowledgeStore.createBase).toHaveBeenCalledWith('项目资料');
    expect(chatStore.syncKnowledgeCatalog).toHaveBeenCalledWith(
      ['kb-1', 'kb-project'],
      { includeInActiveSession: 'kb-project' }
    );

    await wrapper.get('[data-testid="delete-base"]').trigger('click');
    await flushPromises();
    expect(knowledgeStore.deleteBase).toHaveBeenCalledWith('kb-project');
    expect(chatStore.syncKnowledgeCatalog).toHaveBeenCalledWith(['kb-1']);
  });

  it('composes Memory creation, review, correction, deletion, and source navigation with Chat projections', async () => {
    const created = {
      ...memoryStore.memories[0],
      id: 'memory-created',
      status: 'confirmed',
      updatedAt: 2
    };
    const confirmed = { ...memoryStore.memories[0], status: 'confirmed', updatedAt: 2 };
    const corrected = { ...memoryStore.memories[0], status: 'corrected', updatedAt: 3 };
    memoryStore.create.mockResolvedValue(created);
    memoryStore.review.mockResolvedValue(confirmed);
    memoryStore.correct.mockResolvedValue(corrected);
    memoryStore.remove.mockResolvedValue(true);

    const router = createWorkspaceRouter(createMemoryHistory());
    await router.push('/memory');
    await router.isReady();
    const MemoryStub = defineComponent({
      emits: ['create', 'review', 'edit', 'remove', 'open-source'],
      setup(_props, { emit }) {
        const record = memoryStore.memories[0];
        return { emit, record };
      },
      template: `
        <section data-testid="memory-workspace">
          <button data-testid="create-memory" @click="emit('create', { type: 'fact', title: '项目事实', content: '使用 Vue' })">create</button>
          <button data-testid="review-memory" @click="emit('review', 'memory-1', 'confirmed')">review</button>
          <button data-testid="correct-memory" @click="emit('edit', 'memory-1', { title: '纠正' })">correct</button>
          <button data-testid="remove-memory" @click="emit('remove', 'memory-1')">remove</button>
          <button data-testid="open-memory-source" @click="emit('open-source', record)">source</button>
        </section>
      `
    });
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          AsyncChatPanel: true,
          BugKnowledgePanel: true,
          ComposerPanel: true,
          KnowledgePanel: true,
          MemoryPanel: MemoryStub,
          ResearchWorkspace: true,
          SessionPanel: true,
          TopBar: true
        }
      }
    });

    expect(wrapper.find('.main-content-frame [data-testid="memory-workspace"]').exists()).toBe(true);
    expect(wrapper.find('.sidebar-shell [data-testid="memory-workspace"]').exists()).toBe(false);

    await wrapper.get('[data-testid="create-memory"]').trigger('click');
    await flushPromises();
    expect(memoryStore.create).toHaveBeenCalledWith({
      type: 'fact',
      title: '项目事实',
      content: '使用 Vue'
    });
    expect(chatStore.syncMemoryProjections).toHaveBeenCalledWith(memoryStore.memories);

    await wrapper.get('[data-testid="review-memory"]').trigger('click');
    await flushPromises();
    expect(memoryStore.review).toHaveBeenCalledWith('memory-1', 'confirmed');
    expect(chatStore.syncMemoryProjections).toHaveBeenCalledWith(memoryStore.memories);

    await wrapper.get('[data-testid="correct-memory"]').trigger('click');
    await flushPromises();
    expect(memoryStore.correct).toHaveBeenCalledWith('memory-1', { title: '纠正' });
    expect(chatStore.syncMemoryProjections).toHaveBeenCalledWith(memoryStore.memories);

    await wrapper.get('[data-testid="remove-memory"]').trigger('click');
    await flushPromises();
    expect(memoryStore.remove).toHaveBeenCalledWith('memory-1');
    expect(chatStore.syncMemoryProjections).toHaveBeenCalledWith(memoryStore.memories);

    await wrapper.get('[data-testid="open-memory-source"]').trigger('click');
    await flushPromises();
    expect(chatStore.selectSession).toHaveBeenCalledWith('session-1');
    expect(router.currentRoute.value.fullPath).toBe('/chat');
  });

  it('routes message review intents to Memory and ingests candidates returned by Chat', async () => {
    const confirmed = { ...memoryStore.memories[0], status: 'confirmed', updatedAt: 4 };
    const corrected = {
      ...memoryStore.memories[0],
      type: 'preference',
      status: 'corrected',
      updatedAt: 5
    };
    memoryStore.review.mockResolvedValue(confirmed);
    memoryStore.correct.mockResolvedValue(corrected);
    chatStore.send.mockResolvedValue({ memoryCandidates: memoryStore.memories });
    const ChatStub = defineComponent({
      emits: ['correct-memory', 'review-memory'],
      template: `
        <button data-testid="message-memory-review" @click="$emit('review-memory', 'memory-1', 'confirmed')">review</button>
        <button
          data-testid="message-memory-correct"
          @click="$emit('correct-memory', 'memory-1', { type: 'preference', title: '回答风格', content: '先给结论。' })"
        >correct</button>
      `
    });
    const ComposerStub = defineComponent({
      emits: ['submit'],
      template: '<button data-testid="send-chat" @click="$emit(\'submit\')">send</button>'
    });
    const router = createWorkspaceRouter(createMemoryHistory());
    await router.push('/chat');
    await router.isReady();
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          AsyncChatPanel: ChatStub,
          BugKnowledgePanel: true,
          ComposerPanel: ComposerStub,
          KnowledgePanel: true,
          MemoryPanel: true,
          ResearchWorkspace: true,
          SessionPanel: true,
          TopBar: true
        }
      }
    });

    await wrapper.get('[data-testid="message-memory-review"]').trigger('click');
    await flushPromises();
    expect(memoryStore.review).toHaveBeenCalledWith('memory-1', 'confirmed');
    expect(chatStore.syncMemoryProjections).toHaveBeenCalledWith(memoryStore.memories);

    await wrapper.get('[data-testid="message-memory-correct"]').trigger('click');
    await flushPromises();
    expect(memoryStore.correct).toHaveBeenCalledWith('memory-1', {
      type: 'preference',
      title: '回答风格',
      content: '先给结论。'
    });

    await wrapper.get('[data-testid="send-chat"]').trigger('click');
    await flushPromises();
    expect(chatStore.send).toHaveBeenCalledOnce();
    expect(memoryStore.ingest).toHaveBeenCalledWith(memoryStore.memories);
  });

});
