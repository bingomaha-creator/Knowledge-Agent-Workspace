import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBugKnowledgeStore } from './store';
import type {
  BugCase,
  BugCaseDraft,
  BugKnowledgeApi,
  BugProject,
  BugSearchResponse
} from './types';

const project: BugProject = {
  projectRef: 'project-1',
  knowledgeBaseId: 'kb-project-1',
  name: 'Storefront',
  description: '',
  kind: 'project_bugs',
  bugCaseCount: 1,
  createdAt: 1,
  updatedAt: 1
};

const draft: BugCaseDraft = {
  sourceProjectRef: project.projectRef,
  title: 'Hydration mismatch',
  symptom: 'SSR hydration fails',
  errorSignatures: ['Hydration node mismatch'],
  reproductionSteps: ['Refresh page'],
  context: {
    language: 'TypeScript',
    framework: 'Vue',
    versions: ['3.5.13'],
    module: 'detail',
    environment: 'browser'
  },
  resolutionType: 'root_cause_fix',
  rootCause: 'Timezone differs',
  fix: 'Use UTC',
  workaroundRisks: [],
  applicability: ['Vue 3.5'],
  verification: 'Regression passed',
  tags: ['ssr'],
  sourceRefs: ['tests/detail.spec.ts']
};

function bugCase(overrides: Partial<BugCase> = {}): BugCase {
  return {
    id: 'bug-1',
    knowledgeBaseId: project.knowledgeBaseId,
    scope: 'project',
    ...draft,
    fingerprint: 'fingerprint',
    status: 'ready',
    error: null,
    reviewStatus: 'candidate',
    reviewedBy: null,
    reviewReason: null,
    reviewedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function createApi(overrides: Partial<BugKnowledgeApi> = {}): BugKnowledgeApi {
  return {
    fetchProjects: vi.fn(async () => [project]),
    createProject: vi.fn(async () => project),
    updateProject: vi.fn(async () => project),
    fetchCases: vi.fn(async () => [bugCase()]),
    createCase: vi.fn(async () => bugCase({ id: 'bug-created' })),
    updateCase: vi.fn(async (_id, patch) => bugCase({ ...patch, id: 'bug-1' })),
    deleteCase: vi.fn(async () => undefined),
    reviewCase: vi.fn(async (_id, review) => bugCase({
      reviewStatus: review.reviewStatus,
      reviewedBy: 'local-user',
      reviewReason: review.reviewReason,
      reviewedAt: 2
    })),
    promoteCase: vi.fn(async () => bugCase({
      knowledgeBaseId: 'kb-common-bugs',
      scope: 'common',
      reviewStatus: 'confirmed'
    })),
    searchCases: vi.fn(async (): Promise<BugSearchResponse> => ({
      results: [{
        bugCase: bugCase({ reviewStatus: 'confirmed' }),
        rank: 1,
        score: 0.03,
        matchedChannels: ['exact'],
        citations: []
      }],
      scope: {
        projectRefs: [project.projectRef],
        knowledgeBaseIds: [project.knowledgeBaseId, 'kb-common-bugs'],
        includesCommon: true
      },
      trace: { degradedChannels: [], ambiguous: false, evidenceGap: false }
    })),
    ...overrides
  };
}

describe('Bug knowledge store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('loads server state and completes create, review, delete, and scoped search without chat state', async () => {
    const api = createApi();
    const useStore = createBugKnowledgeStore(api, 'bug-knowledge-test-success');
    const store = useStore();

    await store.initialize();
    expect(store.projects).toEqual([project]);
    expect(store.cases[0].reviewStatus).toBe('candidate');
    expect(store.selectedProjectRef).toBe(project.projectRef);

    await store.createCase(draft);
    expect(store.cases.some((item) => item.id === 'bug-created')).toBe(true);

    await store.reviewCase('bug-1', 'confirmed', '人工回归通过');
    expect(store.cases.find((item) => item.id === 'bug-1')?.reviewStatus).toBe('confirmed');

    store.searchQuery = 'Hydration node mismatch';
    store.includeCommon = true;
    store.additionalProjectRefs = [];
    await store.search();
    expect(api.searchCases).toHaveBeenCalledWith({
      query: 'Hydration node mismatch',
      projectRef: project.projectRef,
      includeCommon: true,
      additionalProjectRefs: [],
      filters: {},
      topK: 5
    });
    expect(store.searchResults[0].bugCase.reviewStatus).toBe('confirmed');

    await store.deleteCase('bug-1');
    expect(store.cases.some((item) => item.id === 'bug-1')).toBe(false);
  });

  it('does not apply optimistic success when an API mutation fails', async () => {
    const api = createApi({
      createCase: vi.fn(async () => { throw new Error('保存失败'); })
    });
    const useStore = createBugKnowledgeStore(api, 'bug-knowledge-test-failure');
    const store = useStore();
    await store.initialize();
    const before = store.cases.map((item) => item.id);

    expect(await store.createCase(draft)).toBe(false);
    expect(store.cases.map((item) => item.id)).toEqual(before);
    expect(store.errorMessage).toContain('保存失败');
  });
});
