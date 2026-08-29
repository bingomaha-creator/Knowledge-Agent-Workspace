import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BugWorkspace } from './BugWorkspace';
import { defaultBugCaseFilters, type BugWorkspaceLocation } from './bugViewState';

function bugCase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'case-1', sourceProjectRef: 'project-a', knowledgeBaseId: 'kb-a', scope: 'project',
    title: '支付接口失败', symptom: '支付返回 500', errorSignatures: ['HTTP 500'],
    reproductionSteps: ['提交支付'], context: { language: 'TypeScript', framework: 'React', versions: [], module: 'checkout', environment: 'production' },
    resolutionType: 'root_cause_fix', rootCause: '超时配置错误', fix: '修正超时配置', workaroundRisks: [],
    applicability: [], verification: '回归通过', tags: ['payment'], sourceRefs: [], fingerprint: 'fp-1',
    status: 'ready', error: null, reviewStatus: 'candidate', reviewedBy: null, reviewReason: null,
    reviewedAt: null, createdAt: 1, updatedAt: 1, ...overrides
  };
}

function investigation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1', projectRef: 'project-a', title: '支付回调失败', status: 'draft',
    evidence: [{ id: 'e-1', type: 'error', content: 'TypeError: failed', redactions: [], metadata: { fileName: '', language: '', lineStart: null }, createdAt: 1 }],
    facts: { errorTypes: ['TypeError'], errorCodes: [], messages: ['failed'], files: ['checkout.ts'], locations: [], languages: ['TypeScript'], frameworks: ['React'], environments: ['production'], errorSignatures: ['TypeError: failed'], reproductionSteps: [], verificationNotes: [], evidenceIds: ['e-1'] },
    analysis: { policyVersion: 'v4', status: 'degraded', evidenceQuality: 'limited', summary: '模型不可用，但确定性事实已经保留。', hypotheses: [], verificationSteps: [], missingEvidence: ['补充网络响应'], nextAction: null, similarCases: [], retrievalTrace: { degradedChannels: ['vector'], ambiguous: false, evidenceGap: true }, reasonCode: 'model_unavailable' },
    runs: [], candidateReadiness: { ready: false, checks: [{ key: 'verification', label: '需要验证证据', passed: false }] },
    candidateBugCaseId: null, createdAt: 1, updatedAt: 1, ...overrides
  };
}

function bugLocation(overrides: Partial<BugWorkspaceLocation> = {}): BugWorkspaceLocation {
  return {
    section: 'investigations',
    projectRef: 'project-a',
    recordId: undefined,
    creating: false,
    investigationView: 'active',
    caseFilters: defaultBugCaseFilters(),
    ...overrides
  };
}

function renderWorkspace(overrides: Partial<Parameters<typeof BugWorkspace>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const props: Parameters<typeof BugWorkspace>[0] = {
    location: bugLocation(),
    onLocationChange: vi.fn(),
    ...overrides
  };
  return {
    ...render(<QueryClientProvider client={queryClient}><BugWorkspace {...props} /></QueryClientProvider>),
    props
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/bug-projects') {
      return Response.json({ projects: [{
        projectRef: 'project-a', knowledgeBaseId: 'kb-a', name: '结算系统', description: '',
        kind: 'project_bugs', bugCaseCount: 0, createdAt: 1, updatedAt: 1
      }] });
    }
    if (url === '/api/bug-investigations?projectRef=project-a') {
      return Response.json({ investigations: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
});

describe('BugWorkspace', () => {
  it('shows the selected project and three user-facing work areas', async () => {
    const { props } = renderWorkspace();

    expect(screen.getByRole('heading', { level: 1, name: 'Bug Agent' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: '结算系统' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /调查/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /审核/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /案例库/ })).toBeInTheDocument();
    expect(await screen.findByText('当前项目还没有调查。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /审核/ }));
    expect(props.onLocationChange).toHaveBeenCalledWith(bugLocation({ section: 'review' }));
  });

  it('creates an investigation from an editable prefilled draft', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/bug-projects') {
        return Response.json({ projects: [{
          projectRef: 'project-a', knowledgeBaseId: 'kb-a', name: '结算系统', description: '',
          kind: 'project_bugs', bugCaseCount: 0, createdAt: 1, updatedAt: 1
        }] });
      }
      if (url === '/api/bug-investigations?projectRef=project-a') return Response.json({ investigations: [] });
      if (url === '/api/bug-investigations' && init?.method === 'POST') {
        return Response.json({ investigation: { id: 'inv-1', projectRef: 'project-a' } }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { props } = renderWorkspace({
      location: bugLocation({ creating: true }),
      seed: { title: '支付接口失败', evidence: { type: 'error', content: 'HTTP 500' } }
    });

    expect(await screen.findByDisplayValue('支付接口失败')).toBeInTheDocument();
    expect(screen.getByDisplayValue('HTTP 500')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '创建并分析' }));

    await waitFor(() => expect(props.onLocationChange).toHaveBeenCalledWith(bugLocation({ recordId: 'inv-1' })));
  });

  it('confirms a Candidate and opens its confirmed library detail', async () => {
    const candidate = bugCase();
    const confirmed = bugCase({ reviewStatus: 'confirmed', reviewReason: '已经复现并完成回归' });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/bug-projects') return Response.json({ projects: [{ projectRef: 'project-a', knowledgeBaseId: 'kb-a', name: '结算系统', description: '', kind: 'project_bugs', bugCaseCount: 1, createdAt: 1, updatedAt: 1 }] });
      if (url === '/api/bug-cases?sourceProjectRef=project-a&reviewStatus=candidate') return Response.json({ bugCases: [candidate] });
      if (url === '/api/bug-cases/case-1' && init?.method === 'GET') return Response.json({ bugCase: candidate });
      if (url === '/api/bug-cases/case-1/review' && init?.method === 'POST') return Response.json({ bugCase: confirmed });
      throw new Error(`Unexpected request: ${url}`);
    });
    const { props } = renderWorkspace({ location: bugLocation({ section: 'review', recordId: 'case-1' }) });

    expect(await screen.findByRole('heading', { name: '支付接口失败' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('审核原因'), { target: { value: '已经复现并完成回归' } });
    fireEvent.click(screen.getByRole('button', { name: '确认案例' }));

    await waitFor(() => expect(props.onLocationChange).toHaveBeenCalledWith(bugLocation({ section: 'library', recordId: 'case-1' })));
  });

  it('shows hybrid search results in the confirmed library list', async () => {
    const confirmed = bugCase({ reviewStatus: 'confirmed' });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/bug-projects') return Response.json({ projects: [{ projectRef: 'project-a', knowledgeBaseId: 'kb-a', name: '结算系统', description: '', kind: 'project_bugs', bugCaseCount: 1, createdAt: 1, updatedAt: 1 }] });
      if (url === '/api/bug-cases?reviewStatus=confirmed&status=ready') return Response.json({ bugCases: [confirmed] });
      if (url === '/api/bug-cases/search' && init?.method === 'POST') return Response.json({
        results: [{ bugCase: confirmed, rank: 1, score: 0.91, matchedChannels: ['exact', 'fts'], citations: [] }],
        scope: { projectRefs: ['project-a'], knowledgeBaseIds: ['kb-a'], includesCommon: true },
        trace: { degradedChannels: [], ambiguous: false, evidenceGap: false }
      });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWorkspace({
      location: bugLocation({ section: 'library', caseFilters: { ...defaultBugCaseFilters(), query: '支付失败' } })
    });

    expect(await screen.findByText('支付接口失败')).toBeInTheDocument();
    expect(screen.getByText('exact + fts · 0.91')).toBeInTheDocument();
  });

  it('keeps deterministic facts visible when model analysis is degraded', async () => {
    const item = investigation();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/bug-projects') return Response.json({ projects: [{ projectRef: 'project-a', knowledgeBaseId: 'kb-a', name: '结算系统', description: '', kind: 'project_bugs', bugCaseCount: 0, createdAt: 1, updatedAt: 1 }] });
      if (url === '/api/bug-investigations?projectRef=project-a') return Response.json({ investigations: [item] });
      if (url === '/api/bug-investigations/inv-1') return Response.json({ investigation: item });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWorkspace({ location: bugLocation({ recordId: 'inv-1' }) });

    expect(await screen.findByText('确定性 Facts')).toBeInTheDocument();
    expect(screen.getByText('TypeError')).toBeInTheDocument();
    expect(screen.getByText('模型不可用，但确定性事实已经保留。')).toBeInTheDocument();
    expect(screen.getByText('需要验证证据')).toBeInTheDocument();
  });

  it('retries stale analysis without appending the saved evidence twice', async () => {
    const item = investigation();
    const stale = investigation({ analysis: { ...(item.analysis as object), status: 'stale' } });
    let analyzeAttempts = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/bug-projects') return Response.json({ projects: [{ projectRef: 'project-a', knowledgeBaseId: 'kb-a', name: '结算系统', description: '', kind: 'project_bugs', bugCaseCount: 0, createdAt: 1, updatedAt: 1 }] });
      if (url === '/api/bug-investigations?projectRef=project-a') return Response.json({ investigations: [item] });
      if (url === '/api/bug-investigations/inv-1' && init?.method === 'GET') return Response.json({ investigation: item });
      if (url === '/api/bug-investigations/inv-1/evidence') return Response.json({ investigation: stale });
      if (url === '/api/bug-investigations/inv-1/analyze') {
        analyzeAttempts += 1;
        return analyzeAttempts === 1
          ? Response.json({ error: '模型暂时不可用' }, { status: 503 })
          : Response.json({ investigation: item });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderWorkspace({ location: bugLocation({ recordId: 'inv-1' }) });

    await screen.findByText('确定性 Facts');
    fireEvent.change(screen.getByLabelText('证据内容'), { target: { value: '补充网络响应 500' } });
    fireEvent.click(screen.getByRole('button', { name: '保存证据并分析' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('模型暂时不可用');
    fireEvent.click(screen.getByRole('button', { name: '只重试分析' }));

    await waitFor(() => expect(analyzeAttempts).toBe(2));
    const evidenceCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/evidence'));
    expect(evidenceCalls).toHaveLength(1);
  });

  it('corrects a missing project with a replace navigation and keeps creating', async () => {
    const { props } = renderWorkspace({ location: bugLocation({ projectRef: undefined, creating: true }) });

    await waitFor(() => expect(props.onLocationChange).toHaveBeenCalledWith(
      bugLocation({ projectRef: 'project-a', creating: true }),
      { replace: true }
    ));
  });

  it('emits review filter changes as business state without losing context', async () => {
    const candidate = bugCase();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/bug-projects') return Response.json({ projects: [{ projectRef: 'project-a', knowledgeBaseId: 'kb-a', name: '结算系统', description: '', kind: 'project_bugs', bugCaseCount: 1, createdAt: 1, updatedAt: 1 }] });
      if (url === '/api/bug-cases?sourceProjectRef=project-a&reviewStatus=candidate') return Response.json({ bugCases: [candidate] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const { props } = renderWorkspace({ location: bugLocation({ section: 'review' }) });

    fireEvent.change(await screen.findByLabelText('审核状态'), { target: { value: 'confirmed' } });

    expect(props.onLocationChange).toHaveBeenCalledWith(
      bugLocation({ section: 'review', caseFilters: { ...defaultBugCaseFilters(), reviewStatus: 'confirmed' } })
    );
  });

  it('clears record, creating, view and filters when switching sections', async () => {
    const { props } = renderWorkspace({
      location: bugLocation({
        creating: true,
        recordId: undefined,
        investigationView: 'history',
        caseFilters: { ...defaultBugCaseFilters(), query: '支付失败' }
      })
    });

    await screen.findByRole('option', { name: '结算系统' });
    fireEvent.click(screen.getByRole('tab', { name: /审核/ }));

    expect(props.onLocationChange).toHaveBeenCalledWith(bugLocation({ section: 'review' }));
  });

  it('switches the project and keeps the creating state', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/bug-projects') return Response.json({ projects: [
        { projectRef: 'project-a', knowledgeBaseId: 'kb-a', name: '结算系统', description: '', kind: 'project_bugs', bugCaseCount: 0, createdAt: 1, updatedAt: 1 },
        { projectRef: 'project-b', knowledgeBaseId: 'kb-b', name: '网关服务', description: '', kind: 'project_bugs', bugCaseCount: 0, createdAt: 2, updatedAt: 2 }
      ] });
      if (url === '/api/bug-cases?sourceProjectRef=project-a&reviewStatus=candidate') return Response.json({ bugCases: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const { props } = renderWorkspace({
      location: bugLocation({
        section: 'review',
        creating: true,
        investigationView: 'history',
        caseFilters: { ...defaultBugCaseFilters(), query: '支付失败' }
      })
    });

    await screen.findByRole('option', { name: '网关服务' });
    fireEvent.change(screen.getByLabelText('当前 Bug 项目'), { target: { value: 'project-b' } });

    expect(props.onLocationChange).toHaveBeenCalledWith(
      bugLocation({ section: 'review', projectRef: 'project-b', creating: true })
    );
  });
});
