// @vitest-environment happy-dom
import { createPinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchProjects: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  fetchCases: vi.fn(),
  createCase: vi.fn(),
  updateCase: vi.fn(),
  deleteCase: vi.fn(),
  reviewCase: vi.fn(),
  promoteCase: vi.fn(),
  searchCases: vi.fn()
}));
const investigationApi = vi.hoisted(() => ({
  fetchInvestigations: vi.fn(),
  createInvestigation: vi.fn(),
  appendEvidence: vi.fn(),
  analyzeInvestigation: vi.fn(),
  convertToCandidate: vi.fn(),
  closeInvestigation: vi.fn()
}));

vi.mock('../api', () => ({ bugKnowledgeApi: api }));
vi.mock('../investigation-api', () => ({ bugInvestigationApi: investigationApi }));

import BugKnowledgePanel from './BugKnowledgePanel.vue';

const project = {
  projectRef: 'project-1',
  knowledgeBaseId: 'kb-project-1',
  name: 'Storefront',
  description: '',
  kind: 'project_bugs' as const,
  bugCaseCount: 1,
  createdAt: 1,
  updatedAt: 1
};

function caseDto(id: string, reviewStatus: 'candidate' | 'confirmed' = 'confirmed') {
  return {
    id,
    knowledgeBaseId: project.knowledgeBaseId,
    scope: 'project' as const,
    sourceProjectRef: project.projectRef,
    title: id === 'candidate-secret' ? 'candidate secret' : 'Hydration mismatch',
    symptom: 'SSR mismatch',
    errorSignatures: ['Hydration node mismatch'],
    reproductionSteps: ['Refresh'],
    context: {
      language: 'TypeScript',
      framework: 'Vue',
      versions: ['3.5.13'],
      module: 'detail',
      environment: 'browser'
    },
    resolutionType: 'root_cause_fix' as const,
    rootCause: 'Timezone differs',
    fix: 'Use UTC',
    workaroundRisks: [],
    applicability: ['Vue 3.5'],
    verification: 'Passed',
    tags: ['ssr'],
    sourceRefs: ['tests/detail.spec.ts'],
    fingerprint: 'fp',
    status: 'ready' as const,
    error: null,
    reviewStatus,
    reviewedBy: reviewStatus === 'confirmed' ? 'local-user' : null,
    reviewReason: reviewStatus === 'confirmed' ? 'verified' : null,
    reviewedAt: reviewStatus === 'confirmed' ? 2 : null,
    createdAt: 1,
    updatedAt: 1
  };
}

describe('BugKnowledgePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchProjects.mockResolvedValue([project]);
    api.fetchCases.mockResolvedValue([caseDto('bug-1')]);
    investigationApi.fetchInvestigations.mockResolvedValue([]);
    api.searchCases.mockResolvedValue({
      results: [
        {
          bugCase: caseDto('bug-1'),
          rank: 1,
          score: 0.03,
          matchedChannels: ['fts'],
          citations: [{
            id: 'citation-1',
            documentId: 'bug-1',
            knowledgeBaseId: project.knowledgeBaseId,
            headingPath: [],
            snippet: '<img src=x onerror="window.pwned=true"> [危险](javascript:alert(1)) **安全证据**',
            channel: 'fts',
            rank: 1
          }]
        },
        {
          bugCase: caseDto('candidate-secret', 'candidate'),
          rank: 2,
          score: 0.02,
          matchedChannels: ['fts'],
          citations: []
        }
      ],
      scope: {
        projectRefs: [project.projectRef],
        knowledgeBaseIds: [project.knowledgeBaseId, 'kb-common-bugs'],
        includesCommon: true
      },
      trace: { degradedChannels: [], ambiguous: false, evidenceGap: false }
    });
  });

  it('uses the shared compact select contract for every BugCase filter', async () => {
    const wrapper = mount(BugKnowledgePanel, {
      global: { plugins: [createPinia()] }
    });
    await flushPromises();

    const reviewTab = wrapper.findAll('.bug-section-tabs button').find((button) =>
      button.text().includes('待审核')
    );
    await reviewTab!.trigger('click');
    expect(wrapper.findAll('.bug-filter-bar .workspace-filter-select')).toHaveLength(4);
  });

  it('sanitizes citation Markdown and never renders candidate search results as confirmed hits', async () => {
    const wrapper = mount(BugKnowledgePanel, {
      global: { plugins: [createPinia()] }
    });
    await flushPromises();

    const libraryTab = wrapper.findAll('.bug-section-tabs button').find((button) =>
      button.text().includes('案例库')
    );
    await libraryTab!.trigger('click');
    await wrapper.get('[data-testid="bug-search-input"]').setValue('Hydration mismatch');
    await wrapper.get('.bug-search-form').trigger('submit');
    await flushPromises();

    expect(api.searchCases).toHaveBeenCalledOnce();
    expect(wrapper.findAll('.bug-search-result')).toHaveLength(1);
    expect(wrapper.text()).not.toContain('candidate secret');
    const citation = wrapper.get('.bug-citation-snippet');
    expect(citation.find('img').exists()).toBe(false);
    expect(citation.find('script').exists()).toBe(false);
    expect(citation.find('a[href^="javascript:"]').exists()).toBe(false);
    expect(citation.text()).toContain('安全证据');
  });

  it('takes a successfully confirmed Candidate to a visible confirmed-case detail', async () => {
    const pending = caseDto('bug-pending', 'candidate');
    const confirmed = caseDto('bug-pending', 'confirmed');
    api.fetchCases.mockResolvedValue([pending]);
    api.reviewCase.mockResolvedValue(confirmed);
    const wrapper = mount(BugKnowledgePanel, {
      global: { plugins: [createPinia()] }
    });
    await flushPromises();

    const reviewTab = wrapper.findAll('.bug-section-tabs button').find((button) =>
      button.text().includes('待审核')
    );
    await reviewTab!.trigger('click');
    await wrapper.get('textarea[placeholder="记录为什么确认或拒绝"]').setValue('最小复现验证通过');
    await wrapper.get('[data-testid="bug-confirm"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="confirmed-case-list"]').text()).toContain('Hydration mismatch');
    expect(wrapper.get('[data-testid="confirmed-case-detail"]').text()).toContain('Use UTC');
  });
});
