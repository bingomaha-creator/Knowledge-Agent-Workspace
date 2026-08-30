import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  groupResearchSessions,
  researchQualityLabel,
  researchStageLabel
} from './researchPresentation';
import { researchQueryKeys } from './researchQueries';
import { resolveResearchSearchMode } from './researchViewState';
import { ResearchWorkspace } from './ResearchWorkspace';
import type { ResearchSessionSnapshot, ResearchTask } from '@/services/researchApi';
import type { ResearchWorkspaceLocation } from './researchViewState';

function researchTask(overrides: Record<string, unknown> = {}): ResearchTask {
  return {
    id: 'research-1',
    question: '对比 X 与 Y 的推理性能',
    status: 'completed',
    stage: 'completed',
    progress: 100,
    error: '',
    report: '# 结论\n\nX 快于 Y [1]。\n\n## 参考资料\n\n- [1] 来源甲',
    citations: [{ id: 'c-1', title: '来源甲', snippet: '关键证据', source: '项目资料', kind: 'local', knowledgeBaseId: 'kb-1' }],
    searchMode: 'local',
    webSearchStatus: 'not_requested',
    resultQuality: 'limited',
    limitations: [{ code: 'coverage', message: '证据覆盖范围有限，请结合引用核对。' }],
    failedStage: '',
    attempt: 1,
    cancelRequested: false,
    sessionId: 's-1',
    parentTaskId: '',
    turnIndex: 1,
    continuationContext: null,
    knowledgeBaseIds: ['kb-1'],
    artifacts: {
      plan: {
        planner: 'model',
        objective: '对比两者性能',
        subquestions: [{ id: 'sq-1', question: 'X 的基准指标', intent: 'comparison', searchQuery: 'X benchmark', rationale: '对比基础' }]
      },
      evidencePack: {
        candidateCount: 10, acceptedCount: 4, excludedCount: 6, includedCount: 4,
        citationCount: 1, readSourceCount: 4, passageCount: 9, totalCharacters: 12000, snippetFallbackCount: 0
      },
      evidence: [{ citationId: 'c-1', citationNumber: 1, claim: 'X 快于 Y', snippet: '关键证据' }]
    },
    createdAt: 1,
    updatedAt: 20,
    startedAt: 1,
    finishedAt: 2,
    ...overrides
  } as ResearchTask;
}

function knowledgeBasesPayload() {
  return {
    knowledgeBases: [{
      id: 'kb-1', name: '项目资料', isDefault: true, documentCount: 3,
      publishedDocumentCount: 2, draftDocumentCount: 1, createdAt: 1, updatedAt: 1
    }]
  };
}

function baseFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/research/capabilities') {
      return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
    }
    if (url === '/api/research') {
      if (init?.method === 'POST') {
        return Response.json({ task: researchTask({ id: 'research-new', status: 'queued', stage: 'planning', progress: 0, report: '' }) }, { status: 202 });
      }
      return Response.json({ tasks: [researchTask()] });
    }
    if (url === '/api/research/research-1') {
      return Response.json({ task: researchTask() });
    }
    if (url === '/api/research/research-1/session') {
      return Response.json({ sessionId: 's-1', runs: [researchTask()] });
    }
    if (url === '/api/research/research-1/follow-ups' && init?.method === 'POST') {
      return Response.json({
        task: researchTask({ id: 'research-new', turnIndex: 2, status: 'queued', stage: 'planning', progress: 0, report: '', resultQuality: 'pending' }),
        notice: '已创建第 2 轮研究'
      }, { status: 202 });
    }
    if (url === '/api/knowledge-bases') {
      return Response.json(knowledgeBasesPayload());
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

function renderWorkspace(overrides: Partial<Parameters<typeof ResearchWorkspace>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const onLocationChange = vi.fn();
  const props: Parameters<typeof ResearchWorkspace>[0] = {
    location: { view: 'list', status: 'all' },
    onLocationChange,
    ...overrides
  };
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspace {...props} />
    </QueryClientProvider>
  );
  // 同一次 Workspace 生命周期内的 rerender：保留 queryClient 与回调实例。
  const rerenderWith = (next: Partial<Parameters<typeof ResearchWorkspace>[0]> = {}) => {
    utils.rerender(
      <QueryClientProvider client={queryClient}>
        <ResearchWorkspace
          location={{ view: 'list', status: 'all' }}
          onLocationChange={onLocationChange}
          {...next}
        />
      </QueryClientProvider>
    );
  };
  return { ...utils, props, queryClient, rerenderWith };
}

beforeEach(() => {
  vi.stubGlobal('fetch', baseFetchMock());
});

describe('ResearchWorkspace', () => {
  it('shows the welcome state without auto-selecting a session and opens one on click', async () => {
    const { props } = renderWorkspace();

    expect(screen.getByRole('heading', { level: 1, name: '深度研究' })).toBeInTheDocument();
    expect(await screen.findByText('从一个问题开始')).toBeInTheDocument();
    expect(await screen.findByText('对比 X 与 Y 的推理性能')).toBeInTheDocument();

    fireEvent.click(screen.getByText('对比 X 与 Y 的推理性能'));
    expect(props.onLocationChange).toHaveBeenCalledWith({ view: 'task', taskId: 'research-1', status: 'all' });
  });

  it('separates an empty database from an empty filter result', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: false, role: 'supplemental' } } });
      }
      if (url === '/api/research') return Response.json({ tasks: [] });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { rerender } = renderWorkspace();

    expect(await screen.findByText('还没有研究任务，从一个问题开始。')).toBeInTheDocument();

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ResearchWorkspace location={{ view: 'list', status: 'completed' }} onLocationChange={vi.fn()} />
      </QueryClientProvider>
    );
    expect(await screen.findByText('还没有研究任务，从一个问题开始。')).toBeInTheDocument();
  });

  it('renders a running task with progress, stages and cancel action', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/research/research-1') {
        return Response.json({ task: researchTask({ status: 'running', stage: 'retrieving', progress: 35, report: '', resultQuality: 'pending', finishedAt: null }) });
      }
      if (url === '/api/research/research-1/session') {
        return Response.json({ sessionId: 's-1', runs: [researchTask({ status: 'running', stage: 'retrieving', progress: 35, report: '', resultQuality: 'pending', finishedAt: null })] });
      }
      if (url === '/api/research/research-1/cancel' && init?.method === 'POST') {
        return Response.json({ task: researchTask({ status: 'cancelled' }) });
      }
      if (url === '/api/research') return Response.json({ tasks: [] });
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { props } = renderWorkspace({ location: { view: 'task', taskId: 'research-1', status: 'all' } });

    expect(await screen.findByRole('progressbar', { name: '研究进度' })).toHaveAttribute('aria-valuenow', '35');
    expect(screen.getAllByText(researchStageLabel('retrieving')).length).toBeGreaterThan(0);
    const cancelButton = await screen.findByRole('button', { name: '取消任务' });
    fireEvent.click(cancelButton);

    await waitFor(() => {
      const cancelCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === '/api/research/research-1/cancel');
      expect(cancelCall).toBeTruthy();
    });
    expect(props.onLocationChange).not.toHaveBeenCalled();
  });

  it('renders quality and limitations before the report and keeps diagnostics collapsed', async () => {
    const { container } = renderWorkspace({ location: { view: 'task', taskId: 'research-1', status: 'all' } });

    await screen.findByText('证据质量：证据有限');
    const text = container.textContent || '';
    expect(text.indexOf('证据质量：证据有限')).toBeLessThan(text.indexOf('最终报告'));
    expect(text).toContain('证据覆盖范围有限');
    expect(screen.getByText(researchQualityLabel('limited'))).toBeInTheDocument();
    expect(screen.getByText('X 的基准指标')).toBeInTheDocument();

    const diagnostics = screen.getByText('执行详情').closest('details');
    expect(diagnostics).not.toBeNull();
    expect(diagnostics).not.toHaveAttribute('open');

    // 报告正文渲染，且不再重复渲染底部引用列表。
    expect((await screen.findAllByText(/X 快于 Y/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^引用来源/)).not.toBeInTheDocument();
    expect(container.querySelectorAll('script')).toHaveLength(0);
  });

  it('shows a local not-found state for missing deep links', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: false, role: 'supplemental' } } });
      }
      if (url === '/api/research/missing') return Response.json({ error: '研究任务不存在' }, { status: 404 });
      if (url === '/api/research') return Response.json({ tasks: [] });
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderWorkspace({ location: { view: 'task', taskId: 'missing', status: 'all' } });

    expect(await screen.findByRole('heading', { name: '研究任务不存在' })).toBeInTheDocument();
  });

  it('creates local research with a replace navigation and no source ids', async () => {
    const { props } = renderWorkspace({ location: { view: 'draft', status: 'all' } });

    const submit = await screen.findByRole('button', { name: '创建研究任务' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('研究问题'), { target: { value: '对比 X 与 Y 的推理性能' } });
    fireEvent.click(screen.getByLabelText('选择资料库 项目资料'));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(props.onLocationChange).toHaveBeenCalledWith(
      { view: 'task', taskId: 'research-new', status: 'all' },
      { replace: true }
    ));
    const createCall = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === '/api/research' && init?.method === 'POST');
    expect(createCall).toBeTruthy();
    const body = JSON.parse(String(createCall?.[1]?.body));
    expect(body).toEqual({ question: '对比 X 与 Y 的推理性能', searchMode: 'local', knowledgeBaseIds: ['kb-1'] });
    expect(JSON.stringify(body)).not.toContain('sourceMessageId');
  });

  it('keeps the draft on create failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/research' && init?.method === 'POST') {
        return Response.json({ error: '研究范围包含不存在的知识库' }, { status: 400 });
      }
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: false, role: 'supplemental' } } });
      }
      if (url === '/api/research') return Response.json({ tasks: [] });
      if (url === '/api/knowledge-bases') return Response.json(knowledgeBasesPayload());
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderWorkspace({ location: { view: 'draft', status: 'all' } });

    fireEvent.change(await screen.findByLabelText('研究问题'), { target: { value: '保留草稿的问题' } });
    fireEvent.click(screen.getByLabelText('选择资料库 项目资料'));
    fireEvent.click(screen.getByRole('button', { name: '创建研究任务' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('研究范围包含不存在的知识库');
    expect(screen.getByLabelText('研究问题')).toHaveValue('保留草稿的问题');
  });

  it('seeds an editable draft from chat without auto-submitting', async () => {
    renderWorkspace({
      location: { view: 'draft', status: 'all' },
      draftSeed: { question: '来自对话的问题', knowledgeBaseIds: ['kb-1'], sourceMessageId: 'm-1' }
    });

    expect(await screen.findByText('内容来自对话，可在提交前修改。')).toBeInTheDocument();
    expect(screen.getByLabelText('研究问题')).toHaveValue('来自对话的问题');
    expect(await screen.findByLabelText('选择资料库 项目资料')).toBeChecked();

    const createCalls = vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === '/api/research' && init?.method === 'POST');
    expect(createCalls).toHaveLength(0);
  });

  it('creates a follow-up run in the same session with inherited scope', async () => {
    const { props } = renderWorkspace({ location: { view: 'follow-up', taskId: 'research-1', status: 'all' } });

    expect(await screen.findByText('沿用原研究的资料范围与研究上下文。')).toBeInTheDocument();
    expect(screen.getByLabelText('选择资料库 项目资料')).toBeChecked();
    expect(screen.getByLabelText('研究问题')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('研究问题'), { target: { value: '补充能耗对比' } });
    fireEvent.click(screen.getByRole('button', { name: '开始下一轮研究' }));

    await waitFor(() => expect(props.onLocationChange).toHaveBeenCalledWith(
      { view: 'task', taskId: 'research-new', status: 'all' },
      { replace: true }
    ));
    const followUpCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === '/api/research/research-1/follow-ups');
    expect(followUpCall).toBeTruthy();
  });
});

describe('research presentation rules', () => {
  it('maps knowledge scope, external search and capability gates to search modes', () => {
    const withInternal = { externalSearchAllowed: true, hasRetrievableInternalSource: true };
    const withoutInternal = { externalSearchAllowed: true, hasRetrievableInternalSource: false };
    const capabilityOff = { hasRetrievableInternalSource: true, externalSearchAllowed: false };

    expect(resolveResearchSearchMode({ knowledgeBaseIds: ['kb-1'], externalSearch: false }, withInternal)).toBe('local');
    expect(resolveResearchSearchMode({ knowledgeBaseIds: ['kb-1'], externalSearch: true }, withInternal)).toBe('hybrid');
    expect(resolveResearchSearchMode({ knowledgeBaseIds: [], externalSearch: true }, withoutInternal)).toBe('web');
    expect(resolveResearchSearchMode({ knowledgeBaseIds: [], externalSearch: false }, withoutInternal)).toBeNull();
    expect(resolveResearchSearchMode({ knowledgeBaseIds: ['kb-empty'], externalSearch: false }, withoutInternal)).toBeNull();
    expect(resolveResearchSearchMode({ knowledgeBaseIds: ['kb-empty'], externalSearch: true }, withoutInternal)).toBe('web');
    expect(resolveResearchSearchMode({ knowledgeBaseIds: ['kb-1'], externalSearch: true }, capabilityOff)).toBe('local');
    expect(resolveResearchSearchMode({ knowledgeBaseIds: [], externalSearch: true }, { hasRetrievableInternalSource: false, externalSearchAllowed: false })).toBeNull();
  });

  it('groups sessions active-first with ordered runs', () => {
    const sessions = groupResearchSessions([
      researchTask({ id: 'r-old', sessionId: 's-done', status: 'completed', turnIndex: 1, updatedAt: 5 }),
      researchTask({ id: 'r-new', sessionId: 's-active', status: 'running', turnIndex: 1, updatedAt: 3 })
    ]);

    expect(sessions.map((session) => session.id)).toEqual(['s-active', 's-done']);
    expect(sessions[0].active).toBe(true);
    expect(sessions[1].runs.map((run) => run.id)).toEqual(['r-old']);
  });
});

describe('Research workspace regressions', () => {
  it('allows a second creation after a successful submit', async () => {
    const { props, rerenderWith } = renderWorkspace({ location: { view: 'draft', status: 'all' } });

    fireEvent.change(await screen.findByLabelText('研究问题'), { target: { value: '第一次研究' } });
    fireEvent.click(await screen.findByLabelText('选择资料库 项目资料'));
    fireEvent.click(screen.getByRole('button', { name: '创建研究任务' }));
    await waitFor(() => expect(props.onLocationChange).toHaveBeenCalledWith(
      { view: 'task', taskId: 'research-new', status: 'all' },
      { replace: true }
    ));

    rerenderWith({ location: { view: 'draft', status: 'all' } });
    const secondQuestion = screen.getByLabelText('研究问题');
    expect(secondQuestion).toHaveValue('');
    fireEvent.change(secondQuestion, { target: { value: '第二次研究' } });
    fireEvent.click(screen.getByLabelText('选择资料库 项目资料'));

    const submit = screen.getByRole('button', { name: '创建研究任务' });
    expect(submit).toBeEnabled();
    expect(submit).toHaveTextContent('创建研究任务');
    fireEvent.click(submit);

    await waitFor(() => {
      const posts = vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === '/api/research' && init?.method === 'POST');
      expect(posts).toHaveLength(2);
    });
  });

  it('keeps the unsubmitted draft when leaving and returning to the draft view', async () => {
    const { rerenderWith } = renderWorkspace({ location: { view: 'draft', status: 'all' } });

    fireEvent.change(await screen.findByLabelText('研究问题'), { target: { value: '未提交的问题' } });
    fireEvent.click(await screen.findByLabelText('选择资料库 项目资料'));

    rerenderWith({ location: { view: 'list', status: 'all' } });
    rerenderWith({ location: { view: 'draft', status: 'all' } });

    expect(screen.getByLabelText('研究问题')).toHaveValue('未提交的问题');
    expect(screen.getByLabelText('选择资料库 项目资料')).toBeChecked();
  });

  it('fails closed on unavailable capabilities, including inherited external switches', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: false, role: 'supplemental' } } });
      }
      if (url === '/api/research/research-1') {
        return Response.json({ task: researchTask({ searchMode: 'hybrid', webSearchStatus: 'available', resultQuality: 'sufficient', limitations: [] }) });
      }
      if (url === '/api/research/research-1/session') {
        return Response.json({ sessionId: 's-1', runs: [researchTask({ searchMode: 'hybrid', webSearchStatus: 'available', resultQuality: 'sufficient', limitations: [] })] });
      }
      if (url === '/api/research/research-1/follow-ups' && init?.method === 'POST') {
        return Response.json({ task: researchTask({ id: 'research-new', turnIndex: 2, status: 'queued', report: '', resultQuality: 'pending' }) }, { status: 202 });
      }
      if (url === '/api/research') return Response.json({ tasks: [] });
      if (url === '/api/knowledge-bases') return Response.json(knowledgeBasesPayload());
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderWorkspace({ location: { view: 'follow-up', taskId: 'research-1', status: 'all' } });

    const external = await screen.findByLabelText('使用外部检索补充验证');
    expect(external).toBeDisabled();
    expect(external).not.toBeChecked();

    fireEvent.change(screen.getByLabelText('研究问题'), { target: { value: '继续研究的问题' } });
    fireEvent.click(screen.getByRole('button', { name: '开始下一轮研究' }));

    await waitFor(() => {
      const post = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === '/api/research/research-1/follow-ups');
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body)).searchMode).toBe('local');
    });
  });

  it('blocks local submission when the selected base has no retrievable documents', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
      }
      if (url === '/api/research' && init?.method === 'POST') {
        return Response.json({ task: researchTask({ id: 'research-new', status: 'queued', report: '', resultQuality: 'pending' }) }, { status: 202 });
      }
      if (url === '/api/research') return Response.json({ tasks: [] });
      if (url === '/api/knowledge-bases') {
        return Response.json({ knowledgeBases: [{ id: 'kb-empty', name: '空资料库', isDefault: false, documentCount: 2, publishedDocumentCount: 0, draftDocumentCount: 2, createdAt: 1, updatedAt: 1 }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderWorkspace({ location: { view: 'draft', status: 'all' } });

    fireEvent.change(await screen.findByLabelText('研究问题'), { target: { value: '只选了空资料库' } });
    fireEvent.click(await screen.findByLabelText('选择资料库 空资料库'));

    expect(screen.getByRole('button', { name: '创建研究任务' })).toBeDisabled();
    expect(screen.getByText(/无法提交/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('使用外部检索补充验证'));
    const submit = screen.getByRole('button', { name: '创建研究任务' });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => {
      const post = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === '/api/research' && init?.method === 'POST');
      expect(JSON.parse(String(post?.[1]?.body)).searchMode).toBe('web');
    });
  });

  it('converges the session timeline for a non-first run and unlocks follow-up', async () => {
    const parent = researchTask({ id: 'research-1', status: 'completed', sessionId: 's-1', turnIndex: 1 });
    let follow = researchTask({
      id: 'research-2', status: 'running', stage: 'writing', progress: 60, sessionId: 's-1',
      parentTaskId: 'research-1', turnIndex: 2, resultQuality: 'pending', report: '', finishedAt: null, updatedAt: 30
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/research/research-2') return Response.json({ task: follow });
      if (url === '/api/research/research-2/session') return Response.json({ sessionId: 's-1', runs: [parent, follow] });
      if (url === '/api/research') return Response.json({ tasks: [parent, follow] });
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { queryClient } = renderWorkspace({ location: { view: 'task', taskId: 'research-2', status: 'all' } });

    await screen.findByText('研究轮次');
    expect(screen.queryByRole('button', { name: '继续研究' })).not.toBeInTheDocument();

    follow = { ...follow, status: 'completed', stage: 'completed', progress: 100, resultQuality: 'sufficient', report: '# 新报告', finishedAt: 99, updatedAt: 40 };
    await queryClient.refetchQueries({ queryKey: researchQueryKeys.task('research-2') });

    await waitFor(() => {
      const snapshot = queryClient.getQueryData<ResearchSessionSnapshot>(researchQueryKeys.session('research-2'));
      expect(snapshot?.runs.find((run) => run.id === 'research-2')?.status).toBe('completed');
    });
    expect(await screen.findByRole('button', { name: '继续研究' })).toBeInTheDocument();
  });

  it('keeps the cancelled snapshot when a stale poll lands late', async () => {
    const running = researchTask({
      id: 'research-1', status: 'running', stage: 'writing', progress: 70,
      resultQuality: 'pending', report: '', finishedAt: null, updatedAt: 100
    });
    const cancelled = researchTask({ id: 'research-1', status: 'cancelled', updatedAt: 200, finishedAt: 250 });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/research/research-1' && (!init?.method || init.method === 'GET')) return Response.json({ task: running });
      if (url === '/api/research/research-1/cancel' && init?.method === 'POST') return Response.json({ task: cancelled });
      if (url === '/api/research/research-1/session') return Response.json({ sessionId: 's-1', runs: [running] });
      if (url === '/api/research') return Response.json({ tasks: [running] });
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { queryClient } = renderWorkspace({ location: { view: 'task', taskId: 'research-1', status: 'all' } });

    fireEvent.click(await screen.findByRole('button', { name: '取消任务' }));
    await waitFor(() => expect(queryClient.getQueryData<ResearchTask>(researchQueryKeys.task('research-1'))?.status).toBe('cancelled'));

    // 模拟取消请求期间启动、晚到的旧轮询（仍是 running 快照）
    await queryClient.refetchQueries({ queryKey: researchQueryKeys.task('research-1') });

    expect(queryClient.getQueryData<ResearchTask>(researchQueryKeys.task('research-1'))?.status).toBe('cancelled');
    expect(await screen.findByText('任务已取消')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新研究' })).toBeInTheDocument();
  });

  it('shows a retryable list failure instead of the empty state', async () => {
    let listFailures = 1;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
      }
      if (url === '/api/research') {
        if (listFailures > 0) {
          listFailures -= 1;
          return Response.json({ error: '服务器繁忙' }, { status: 500 });
        }
        return Response.json({ tasks: [researchTask()] });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { queryClient } = renderWorkspace();

    expect(await screen.findByText(/加载研究记录失败/)).toBeInTheDocument();
    expect(screen.queryByText('还没有研究任务，从一个问题开始。')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('对比 X 与 Y 的推理性能')).toBeInTheDocument();

    listFailures = 1;
    await queryClient.refetchQueries({ queryKey: researchQueryKeys.tasks() });
    expect(await screen.findByText('研究记录同步失败，正在显示上一次成功结果。')).toBeInTheDocument();
    expect(screen.getByText('对比 X 与 Y 的推理性能')).toBeInTheDocument();
  });

  it('shows a retryable error when the follow-up parent cannot load', async () => {
    let parentFails = 3;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
      }
      if (url === '/api/research/research-1') {
        if (parentFails > 0) {
          parentFails -= 1;
          return Response.json({ error: '服务器繁忙' }, { status: 500 });
        }
        return Response.json({ task: researchTask() });
      }
      if (url === '/api/research') return Response.json({ tasks: [] });
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderWorkspace({ location: { view: 'follow-up', taskId: 'research-1', status: 'all' } });

    // queryFn 对非 404 最多重试两次，等全部尝试失败后的终态错误
    expect(await screen.findByRole('heading', { name: '暂时无法打开原研究' }, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.queryByLabelText('研究问题')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByLabelText('研究问题')).toBeInTheDocument();
  });

  it('does not regress the session timeline when a stale session response lands late', async () => {
    const running = researchTask({
      id: 'research-1', status: 'running', stage: 'writing', progress: 70,
      resultQuality: 'pending', report: '', finishedAt: null, updatedAt: 100
    });
    const cancelled = researchTask({ id: 'research-1', status: 'cancelled', updatedAt: 200, finishedAt: 250 });
    let releaseSession: ((value: Response) => void) | undefined;
    const sessionResponse = new Promise<Response>((resolve) => { releaseSession = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/research/research-1' && (!init?.method || init.method === 'GET')) return Response.json({ task: cancelled });
      if (url === '/api/research/research-1/session') return sessionResponse;
      if (url === '/api/research') return Response.json({ tasks: [running] });
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { queryClient } = renderWorkspace({ location: { view: 'task', taskId: 'research-1', status: 'all' } });

    // 任务先完成取消，Session 请求仍被挂起
    await waitFor(() => expect(queryClient.getQueryData<ResearchTask>(researchQueryKeys.task('research-1'))?.status).toBe('cancelled'));

    // 释放晚到的旧 Session 响应（仍是 running）
    releaseSession?.(Response.json({ sessionId: 's-1', runs: [running] }));
    await waitFor(() => {
      const snapshot = queryClient.getQueryData<ResearchSessionSnapshot>(researchQueryKeys.session('research-1'));
      expect(snapshot?.runs.find((run) => run.id === 'research-1')?.status).toBe('cancelled');
    });

    // 时间线与 busy 状态不回退
    expect(await screen.findByText('任务已取消')).toBeInTheDocument();
    expect(screen.queryByText('当前会话已有进行中的研究轮次')).not.toBeInTheDocument();
  });

  it('fails closed on capability refresh failure even when cached capabilities allowed external search', async () => {
    let capabilityFailures = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/research/capabilities') {
        if (capabilityFailures > 0) {
          capabilityFailures -= 1;
          return Response.json({ error: '服务器繁忙' }, { status: 500 });
        }
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
      }
      if (url === '/api/research' && init?.method === 'POST') {
        return Response.json({ task: researchTask({ id: 'research-new', status: 'queued', report: '', resultQuality: 'pending' }) }, { status: 202 });
      }
      if (url === '/api/research') return Response.json({ tasks: [] });
      if (url === '/api/knowledge-bases') return Response.json(knowledgeBasesPayload());
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { queryClient } = renderWorkspace({ location: { view: 'draft', status: 'all' } });

    fireEvent.change(await screen.findByLabelText('研究问题'), { target: { value: '能力失败后降级' } });
    fireEvent.click(await screen.findByLabelText('选择资料库 项目资料'));
    fireEvent.click(screen.getByLabelText('使用外部检索补充验证'));
    expect(await screen.findByText('提交后将使用：项目资料 + 外部检索')).toBeInTheDocument();

    capabilityFailures = 1;
    await queryClient.refetchQueries({ queryKey: researchQueryKeys.capabilities() });

    expect(await screen.findByText('暂时无法确认外部检索能力，已停用外部检索。')).toBeInTheDocument();
    expect(screen.getByLabelText('使用外部检索补充验证')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '创建研究任务' }));
    await waitFor(() => {
      const post = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === '/api/research' && init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body)).searchMode).toBe('local');
    });
  });

  it('prunes stale knowledge base ids from late re-research seeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
      }
      if (url === '/api/research/research-1') {
        return Response.json({ task: researchTask({ knowledgeBaseIds: ['kb-1', 'kb-gone'] }) });
      }
      if (url === '/api/research/research-1/session') {
        return Response.json({ sessionId: 's-1', runs: [researchTask({ knowledgeBaseIds: ['kb-1', 'kb-gone'] })] });
      }
      if (url === '/api/research' && init?.method === 'POST') {
        return Response.json({ task: researchTask({ id: 'research-new', status: 'queued', report: '', resultQuality: 'pending' }) }, { status: 202 });
      }
      if (url === '/api/research') return Response.json({ tasks: [] });
      if (url === '/api/knowledge-bases') return Response.json(knowledgeBasesPayload());
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { rerenderWith } = renderWorkspace({ location: { view: 'task', taskId: 'research-1', status: 'all' } });

    fireEvent.click(await screen.findByRole('button', { name: '重新研究' }));
    // 模拟 Page 响应导航意图切换到草稿视图
    rerenderWith({ location: { view: 'draft', status: 'all' } });

    expect(await screen.findByLabelText('研究问题')).toHaveValue('对比 X 与 Y 的推理性能');
    expect(screen.getByLabelText('选择资料库 项目资料')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '创建研究任务' }));
    await waitFor(() => {
      const post = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === '/api/research' && init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body)).knowledgeBaseIds).toEqual(['kb-1']);
    });
  });

  it('keeps chat-seed edits across rerenders with a stable seed conversion', async () => {
    const seed = { question: '来自对话的问题', knowledgeBaseIds: ['kb-1'], sourceMessageId: 'm-1' };
    const { rerenderWith } = renderWorkspace({
      location: { view: 'draft', status: 'all' },
      draftSeed: seed
    });

    await screen.findByLabelText('研究问题');
    fireEvent.change(screen.getByLabelText('研究问题'), { target: { value: '来自对话的问题（已修改）' } });

    // 模拟普通重渲染：Page 传入同一个 seed 对象
    rerenderWith({ location: { view: 'draft', status: 'all' }, draftSeed: seed });

    expect(screen.getByLabelText('研究问题')).toHaveValue('来自对话的问题（已修改）');
    expect(screen.getByLabelText('选择资料库 项目资料')).toBeChecked();
  });

  it('distinguishes knowledge base failure from an empty workspace', async () => {
    let kbFailures = 1;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
      }
      if (url === '/api/knowledge-bases') {
        if (kbFailures > 0) {
          kbFailures -= 1;
          return Response.json({ error: '服务器繁忙' }, { status: 500 });
        }
        return Response.json({ knowledgeBases: [] });
      }
      if (url === '/api/research') return Response.json({ tasks: [] });
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderWorkspace({ location: { view: 'draft', status: 'all' } });

    expect(await screen.findByText(/加载资料库失败/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('当前工作区还没有可用的资料库。')).toBeInTheDocument();
  });

  it('blocks over-limit questions without truncating and accepts exactly 4000 characters', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
      }
      if (url === '/api/research' && init?.method === 'POST') {
        return Response.json({ task: researchTask({ id: 'research-new', status: 'queued', report: '', resultQuality: 'pending' }) }, { status: 202 });
      }
      if (url === '/api/research') return Response.json({ tasks: [] });
      if (url === '/api/knowledge-bases') return Response.json(knowledgeBasesPayload());
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderWorkspace({ location: { view: 'draft', status: 'all' } });

    fireEvent.click(await screen.findByLabelText('选择资料库 项目资料'));

    // 空白输入
    fireEvent.click(screen.getByRole('button', { name: '创建研究任务' }));
    expect(await screen.findByText('请输入研究问题。')).toBeInTheDocument();

    // 超长预填：阻止提交且保留原文（seed 预填不受输入框 maxLength 限制）
    const questionField = screen.getByLabelText('研究问题');
    questionField.removeAttribute('maxlength');
    const overLimit = '长'.repeat(4001);
    fireEvent.change(questionField, { target: { value: overLimit } });
    fireEvent.click(screen.getByRole('button', { name: '创建研究任务' }));
    expect(await screen.findByText('研究问题超过 4000 字上限，请删减后再提交。')).toBeInTheDocument();
    expect(questionField).toHaveValue(overLimit);
    expect(vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === '/api/research' && init?.method === 'POST')).toHaveLength(0);

    // 恰好 4000 字：正常提交
    const exactLimit = '问'.repeat(4000);
    fireEvent.change(screen.getByLabelText('研究问题'), { target: { value: exactLimit } });
    fireEvent.click(screen.getByRole('button', { name: '创建研究任务' }));
    await waitFor(() => {
      const post = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === '/api/research' && init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body)).question).toHaveLength(4000);
    });
  });

  it('merges the session run from the list cache when it is newer than both the response and the detail cache', async () => {
    const responseRun = researchTask({
      id: 'research-1', status: 'running', stage: 'writing', progress: 60,
      resultQuality: 'pending', report: '', finishedAt: null, updatedAt: 100
    });
    const detailStale = researchTask({
      id: 'research-1', status: 'running', stage: 'outlining', progress: 45,
      resultQuality: 'pending', report: '', finishedAt: null, updatedAt: 150
    });
    const listNewest = researchTask({ id: 'research-1', status: 'cancelled', updatedAt: 250, finishedAt: 260 });
    let releaseSession: ((value: Response) => void) | undefined;
    const sessionResponse = new Promise<Response>((resolve) => { releaseSession = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/research/research-1' && (!init?.method || init.method === 'GET')) return Response.json({ task: responseRun });
      if (url === '/api/research/research-1/session') return sessionResponse;
      if (url === '/api/research') return Response.json({ tasks: [responseRun] });
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { queryClient } = renderWorkspace({ location: { view: 'task', taskId: 'research-1', status: 'all' } });

    await waitFor(() => expect(queryClient.getQueryData<ResearchTask>(researchQueryKeys.task('research-1'))).toBeDefined());
    // 详情缓存（150）比响应（100）新，但列表缓存（250）更新——必须取列表版本。
    queryClient.setQueryData(researchQueryKeys.task('research-1'), detailStale);
    queryClient.setQueryData<ResearchTask[]>(researchQueryKeys.tasks(), [listNewest]);

    releaseSession?.(Response.json({ sessionId: 's-1', runs: [responseRun] }));
    await waitFor(() => {
      const snapshot = queryClient.getQueryData<ResearchSessionSnapshot>(researchQueryKeys.session('research-1'));
      expect(snapshot?.runs[0]?.status).toBe('cancelled');
      expect(snapshot?.runs[0]?.updatedAt).toBe(250);
    });
  });

  it('merges the session run from the list cache when it is newer than the cached session snapshot', async () => {
    const cachedRun = researchTask({
      id: 'research-1', status: 'running', stage: 'writing', progress: 60,
      resultQuality: 'pending', report: '', finishedAt: null, updatedAt: 100
    });
    const detailStale = researchTask({
      id: 'research-1', status: 'running', stage: 'outlining', progress: 45,
      resultQuality: 'pending', report: '', finishedAt: null, updatedAt: 150
    });
    const listNewest = researchTask({ id: 'research-1', status: 'cancelled', updatedAt: 250, finishedAt: 260 });
    let sessionRun = cachedRun;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/research/research-1/session') return Response.json({ sessionId: 's-1', runs: [sessionRun] });
      if (url === '/api/research/research-1') return Response.json({ task: sessionRun });
      if (url === '/api/research') return Response.json({ tasks: [sessionRun] });
      if (url === '/api/research/capabilities') {
        return Response.json({ capabilities: { localKnowledge: true, publicPrimarySearch: { available: true, role: 'supplemental' } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { queryClient } = renderWorkspace({ location: { view: 'task', taskId: 'research-1', status: 'all' } });

    await waitFor(() => expect(queryClient.getQueryData<ResearchSessionSnapshot>(researchQueryKeys.session('research-1'))).toBeDefined());
    // 既有 Session（100）与详情（150）都落后于列表（250）；晚到的响应（120）也不回退。
    queryClient.setQueryData(researchQueryKeys.task('research-1'), detailStale);
    queryClient.setQueryData<ResearchTask[]>(researchQueryKeys.tasks(), [listNewest]);
    sessionRun = researchTask({
      id: 'research-1', status: 'running', stage: 'writing', progress: 65,
      resultQuality: 'pending', report: '', finishedAt: null, updatedAt: 120
    });

    await queryClient.refetchQueries({ queryKey: researchQueryKeys.session('research-1') });

    const snapshot = queryClient.getQueryData<ResearchSessionSnapshot>(researchQueryKeys.session('research-1'));
    expect(snapshot?.runs[0]?.status).toBe('cancelled');
    expect(snapshot?.runs[0]?.updatedAt).toBe(250);
  });
});
