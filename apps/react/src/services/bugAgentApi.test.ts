import { describe, expect, it, vi } from 'vitest';
import { createBugAgentApi } from './bugAgentApi';

function response(body: unknown, status = 200) {
  return Response.json(body, { status });
}

describe('bugAgentApi', () => {
  it('owns project and investigation HTTP contracts', async () => {
    const project = { projectRef: 'project/a', name: '项目 A' };
    const investigation = { id: 'investigation/1', projectRef: 'project/a' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ projects: [project] }))
      .mockResolvedValueOnce(response({ project }, 201))
      .mockResolvedValueOnce(response({ investigations: [investigation] }))
      .mockResolvedValueOnce(response({ investigation }))
      .mockResolvedValueOnce(response({ investigation }, 201))
      .mockResolvedValueOnce(response({ investigation }))
      .mockResolvedValueOnce(response({ investigation }))
      .mockResolvedValueOnce(response({ investigation }))
      .mockResolvedValueOnce(response({ investigation }));
    const api = createBugAgentApi(fetcher);

    await api.listProjects();
    await api.createProject({ name: '项目 A' });
    await api.listInvestigations('project/a', 'draft');
    await api.getInvestigation('investigation/1');
    await api.createInvestigation({
      projectRef: 'project/a',
      title: '请求失败',
      evidence: { type: 'error', content: '500' }
    });
    await api.appendEvidence('investigation/1', { type: 'network', content: 'POST /api' });
    await api.analyzeInvestigation('investigation/1');
    await api.convertInvestigation('investigation/1');
    await api.closeInvestigation('investigation/1');

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/bug-projects', expect.any(Object));
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/bug-projects', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: '项目 A' })
    }));
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      '/api/bug-investigations?projectRef=project%2Fa&status=draft',
      expect.any(Object)
    );
    expect(fetcher).toHaveBeenNthCalledWith(4, '/api/bug-investigations/investigation%2F1', expect.any(Object));
    expect(fetcher).toHaveBeenNthCalledWith(6, '/api/bug-investigations/investigation%2F1/evidence', expect.objectContaining({ method: 'POST' }));
    expect(fetcher).toHaveBeenNthCalledWith(7, '/api/bug-investigations/investigation%2F1/analyze', expect.objectContaining({ method: 'POST' }));
    expect(fetcher).toHaveBeenNthCalledWith(8, '/api/bug-investigations/investigation%2F1/convert', expect.objectContaining({ method: 'POST' }));
    expect(fetcher).toHaveBeenNthCalledWith(9, '/api/bug-investigations/investigation%2F1/close', expect.objectContaining({ method: 'POST' }));
  });

  it('owns BugCase review and search contracts', async () => {
    const bugCase = { id: 'case/1', sourceProjectRef: 'project/a' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ bugCases: [bugCase] }))
      .mockResolvedValueOnce(response({ bugCase }))
      .mockResolvedValueOnce(response({ bugCase }, 201))
      .mockResolvedValueOnce(response({ bugCase }))
      .mockResolvedValueOnce(response({ bugCase }))
      .mockResolvedValueOnce(response({ bugCase }))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ results: [], scope: {}, trace: {} }));
    const api = createBugAgentApi(fetcher);

    await api.listCases({
      sourceProjectRef: 'project/a', scope: 'project', reviewStatuses: ['candidate'], statuses: ['ready']
    });
    await api.getCase('case/1');
    await api.createCase({ sourceProjectRef: 'project/a', title: '请求失败' } as never);
    await api.updateCase('case/1', { title: '新标题' });
    await api.reviewCase('case/1', { reviewStatus: 'confirmed', reviewReason: '已经复现并验证' });
    await api.promoteCase('case/1');
    await api.deleteCase('case/1');
    await api.searchCases({
      query: '请求失败', projectRef: 'project/a', includeCommon: true,
      additionalProjectRefs: ['project/c', 'project/b'], filters: {}, topK: 10
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      '/api/bug-cases?sourceProjectRef=project%2Fa&scope=project&reviewStatus=candidate&status=ready',
      expect.any(Object)
    );
    expect(fetcher).toHaveBeenNthCalledWith(5, '/api/bug-cases/case%2F1/review', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ reviewStatus: 'confirmed', reviewReason: '已经复现并验证' })
    }));
    expect(fetcher).toHaveBeenNthCalledWith(8, '/api/bug-cases/search', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        query: '请求失败', projectRef: 'project/a', includeCommon: true,
        additionalProjectRefs: ['project/c', 'project/b'], filters: {}, topK: 10
      })
    }));
  });
});
