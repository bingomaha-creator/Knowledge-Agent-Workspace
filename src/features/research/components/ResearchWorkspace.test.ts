// @vitest-environment happy-dom

import { createPinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';

const api = vi.hoisted(() => ({
  getCapabilities: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  getSession: vi.fn(),
  createTask: vi.fn(),
  continueTask: vi.fn(),
  cancelTask: vi.fn(),
  retryTask: vi.fn()
}));

vi.mock('../api', () => ({ researchApi: api }));

import { createWorkspaceRouter } from '@/router';
import { useResearchStore } from '../store';
import ResearchWorkspace from './ResearchWorkspace.vue';

const completedTask = {
  id: 'research-1',
  question: '如何设计 Research Workspace？',
  status: 'completed' as const,
  stage: 'completed' as const,
  progress: 100,
  report: '# 结论\n<img src=x onerror="window.pwned=true"> **安全内容**',
  citations: [
    { id: 'unsafe', title: '危险来源', snippet: '不可点击', source: 'web', url: 'javascript:alert(1)' },
    { id: 'safe', title: '安全来源', snippet: '可以核对', source: 'docs', url: 'https://example.com/source' }
  ],
  knowledgeBaseIds: ['kb-1'],
  searchMode: 'hybrid' as const,
  webSearchStatus: 'available' as const,
  resultQuality: 'limited' as const,
  limitations: [{ code: 'public_search_partial', message: '公开一手资料搜索仅部分成功。' }],
  attempt: 1,
  sessionId: 'research-1',
  parentTaskId: '',
  turnIndex: 1,
  artifacts: {
    plan: {
      objective: '如何设计 Research Workspace？',
      planner: 'model',
      subquestions: [{
        id: 'q1',
        question: 'Research Workspace 如何独立恢复任务？',
        searchQuery: 'Research Workspace 任务恢复',
        intent: 'implementation',
        rationale: '确认后台任务的恢复边界。'
      }]
    },
    evidencePack: {
      candidateCount: 5,
      acceptedCount: 3,
      excludedCount: 2,
      includedCount: 3,
      exclusionReasons: ['low_relevance']
    }
  },
  createdAt: 1,
  updatedAt: 2
};

describe('ResearchWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCapabilities.mockResolvedValue({
      localKnowledge: true,
      publicPrimarySearch: { available: true, role: 'supplemental' }
    });
    api.listTasks.mockResolvedValue([completedTask]);
    api.getTask.mockRejectedValue(new Error('研究任务不存在'));
    api.getSession.mockImplementation(async (id: string) => {
      if (id === 'missing') throw new Error('研究任务不存在');
      return [completedTask];
    });
    api.createTask.mockImplementation(async (input) => ({
      task: {
        ...completedTask,
        ...input,
        id: 'research-created',
        status: 'queued',
        stage: 'planning',
        progress: 0,
        report: undefined,
        citations: [],
        resultQuality: 'pending',
        limitations: []
      }
    }));
    api.cancelTask.mockResolvedValue({ ...completedTask, status: 'cancelled' });
    api.retryTask.mockResolvedValue({ ...completedTask, status: 'queued', stage: 'planning' });
    api.continueTask.mockImplementation(async (_id: string, input: { question: string }) => ({
      task: {
        ...completedTask,
        id: 'research-follow-up',
        question: input.question,
        status: 'queued',
        stage: 'planning',
        progress: 0,
        report: undefined,
        citations: [],
        resultQuality: 'pending',
        limitations: [],
        parentTaskId: 'research-1',
        turnIndex: 2
      },
      notice: '已创建第 2 轮研究'
    }));
  });

  async function mountWorkspace(path = '/research/research-1') {
    const pinia = createPinia();
    const router = createWorkspaceRouter(createMemoryHistory());
    await router.push(path);
    await router.isReady();
    await useResearchStore(pinia).initialize();
    const wrapper = mount(ResearchWorkspace, {
      props: {
        knowledgeBases: [{ id: 'kb-1', name: '默认知识库' }],
        defaultKnowledgeBaseIds: ['kb-1']
      },
      global: { plugins: [pinia, router] }
    });
    await flushPromises();
    return { wrapper, router };
  }

  it('renders list-detail safely and keeps unsafe citations non-clickable', async () => {
    const { wrapper } = await mountWorkspace();

    expect(wrapper.text()).toContain('如何设计 Research Workspace？');
    expect(wrapper.text()).toContain('安全内容');
    expect(wrapper.findAll('[data-testid="research-stage"]')).toHaveLength(7);
    expect(wrapper.find('.research-report-body img').exists()).toBe(false);
    expect(wrapper.find('a[href^="javascript:"]').exists()).toBe(false);
    expect(wrapper.get('a[href="https://example.com/source"]').text()).toContain('安全来源');
    expect(wrapper.text()).toContain('危险来源');
    expect(wrapper.text()).toContain('证据质量：证据受限');
    expect(wrapper.text()).toContain('公开一手资料搜索仅部分成功。');
    expect(wrapper.text()).toContain('本次准备查什么');
    expect(wrapper.text()).toContain('证据如何进入报告');
    expect(wrapper.text()).toContain('候选5');
    expect(wrapper.text()).toContain('通过筛选3');
  });

  it('filters task status without mutating the authoritative task list', async () => {
    const { wrapper } = await mountWorkspace('/research');
    expect(wrapper.findAll('.research-task-card')).toHaveLength(1);

    await wrapper.get('[data-testid="research-status-filter"]').setValue('active');
    expect(wrapper.findAll('.research-task-card')).toHaveLength(0);

    await wrapper.get('[data-testid="research-status-filter"]').setValue('all');
    expect(wrapper.findAll('.research-task-card')).toHaveLength(1);
  });

  it('uses one editable draft flow and navigates to the authoritative created task', async () => {
    const { wrapper, router } = await mountWorkspace('/research');

    await wrapper.get('[data-testid="research-new-draft"]').trigger('click');
    await wrapper.get('[data-testid="research-question"]').setValue('新的研究问题');
    await wrapper.get('[data-testid="research-mode"]').setValue('hybrid');
    await wrapper.get('[data-testid="research-draft-form"]').trigger('submit');
    await flushPromises();

    expect(api.createTask).toHaveBeenCalledWith({
      question: '新的研究问题',
      searchMode: 'hybrid',
      knowledgeBaseIds: ['kb-1']
    });
    expect(router.currentRoute.value.fullPath).toBe('/research/research-created');

    await router.push('/research');
    await flushPromises();
    expect(wrapper.find('[data-testid="research-draft-form"]').exists()).toBe(false);
  });

  it('shows a Research-local error for an unknown task id', async () => {
    const { wrapper } = await mountWorkspace('/research/missing');
    expect(wrapper.get('[role="alert"]').text()).toContain('研究任务不存在');
    expect(wrapper.text()).toContain('返回任务列表');
  });

  it('lets a mobile draft return to the task list without submitting', async () => {
    const { wrapper } = await mountWorkspace('/research');
    await wrapper.get('[data-testid="research-new-draft"]').trigger('click');
    expect(wrapper.find('[data-testid="research-draft-form"]').exists()).toBe(true);

    await wrapper.get('[data-testid="research-back"]').trigger('click');

    expect(wrapper.find('[data-testid="research-draft-form"]').exists()).toBe(false);
    expect(wrapper.get('.research-workspace-grid').classes()).not.toContain('research-draft-open');
  });

  it('creates a follow-up run from the completed report and keeps it in the same session', async () => {
    const { wrapper, router } = await mountWorkspace();

    await wrapper.get('[data-testid="research-follow-up-question"]').setValue('只比较三个项目的 Agent Loop');
    await wrapper.get('[data-testid="research-follow-up-form"]').trigger('submit');
    await flushPromises();

    expect(api.continueTask).toHaveBeenCalledWith('research-1', {
      question: '只比较三个项目的 Agent Loop'
    });
    expect(router.currentRoute.value.fullPath).toBe('/research/research-follow-up');
  });

  it('restores the task-list scroll position after returning from a detail', async () => {
    const { wrapper } = await mountWorkspace('/research');
    const list = wrapper.get('[data-testid="research-list-pane"]');
    Object.defineProperty(list.element, 'scrollTop', { configurable: true, writable: true, value: 140 });

    await wrapper.get('.research-task-card').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="research-back"]').trigger('click');
    await flushPromises();

    expect((list.element as HTMLElement).scrollTop).toBe(140);
  });

});
