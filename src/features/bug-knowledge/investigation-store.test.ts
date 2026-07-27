import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBugInvestigationStore } from './investigation-store';
import type {
  BugInvestigation,
  BugInvestigationApi
} from './investigation-types';

function investigation(overrides: Partial<BugInvestigation> = {}): BugInvestigation {
  return {
    id: 'investigation-1',
    projectRef: 'project-1',
    title: 'Unexpected end of JSON input',
    status: 'draft',
    evidence: [{
      id: 'evidence-1',
      type: 'error',
      content: 'Unexpected end of JSON input',
      redactions: [],
      metadata: { fileName: '', language: '', lineStart: null },
      createdAt: 1
    }],
    facts: {
      errorTypes: [],
      messages: ['Unexpected end of JSON input'],
      files: [],
      locations: [],
      frameworks: ['SSE'],
      environments: ['browser'],
      errorSignatures: ['unexpected end of json input'],
      reproductionSteps: [],
      verificationNotes: [],
      evidenceIds: ['evidence-1']
    },
    analysis: {
      status: 'idle',
      evidenceQuality: 'pending',
      summary: '',
      hypotheses: [],
      verificationSteps: [],
      missingEvidence: [],
      similarCases: [],
      retrievalTrace: null,
      reasonCode: ''
    },
    runs: [],
    candidateReadiness: {
      ready: false,
      checks: [{ key: 'reproduction', label: '复现步骤', passed: false }]
    },
    candidateBugCaseId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function createApi(overrides: Partial<BugInvestigationApi> = {}): BugInvestigationApi {
  return {
    fetchInvestigations: vi.fn(async () => []),
    createInvestigation: vi.fn(async () => investigation()),
    appendEvidence: vi.fn(async () => investigation({
      analysis: { ...investigation().analysis, status: 'stale' }
    })),
    analyzeInvestigation: vi.fn(async () => investigation({
      analysis: {
        ...investigation().analysis,
        status: 'success',
        evidenceQuality: 'limited',
        summary: '已生成受证据约束的假设。'
      }
    })),
    convertToCandidate: vi.fn(async () => investigation({
      status: 'converted',
      candidateBugCaseId: 'candidate-1'
    })),
    closeInvestigation: vi.fn(async () => investigation({ status: 'closed' })),
    ...overrides
  };
}

describe('Bug investigation store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('creates, analyzes, appends evidence and converts only after an explicit action', async () => {
    const api = createApi();
    const useStore = createBugInvestigationStore(api, 'bug-investigation-store-success');
    const store = useStore();

    await store.initialize('project-1');
    const id = await store.createAndAnalyze({
      projectRef: 'project-1',
      evidence: { type: 'error', content: 'Unexpected end of JSON input' }
    });
    expect(id).toBe('investigation-1');
    expect(api.analyzeInvestigation).toHaveBeenCalledWith('investigation-1');
    expect(api.convertToCandidate).not.toHaveBeenCalled();

    await store.appendAndAnalyze('investigation-1', {
      type: 'reproduction',
      content: '接收拆分的 SSE chunk'
    });
    expect(api.appendEvidence).toHaveBeenCalledOnce();
    expect(api.analyzeInvestigation).toHaveBeenCalledTimes(2);

    await store.convertToCandidate('investigation-1');
    expect(store.selected?.status).toBe('converted');
    expect(store.selected?.candidateBugCaseId).toBe('candidate-1');
  });

  it('keeps the previous snapshot when appending evidence fails', async () => {
    const api = createApi({
      fetchInvestigations: vi.fn(async () => [investigation()]),
      appendEvidence: vi.fn(async () => { throw new Error('证据保存失败'); })
    });
    const useStore = createBugInvestigationStore(api, 'bug-investigation-store-failure');
    const store = useStore();
    await store.initialize('project-1');

    expect(await store.appendAndAnalyze('investigation-1', {
      type: 'note',
      content: '更多信息'
    })).toBe(false);
    expect(store.selected?.evidence).toHaveLength(1);
    expect(store.errorMessage).toContain('证据保存失败');
  });

  it('retries stale analysis without appending the same evidence again', async () => {
    let analysisAttempts = 0;
    const stale = investigation({
      analysis: { ...investigation().analysis, status: 'stale' }
    });
    const api = createApi({
      fetchInvestigations: vi.fn(async () => [investigation()]),
      appendEvidence: vi.fn(async () => stale),
      analyzeInvestigation: vi.fn(async () => {
        analysisAttempts += 1;
        if (analysisAttempts === 1) throw new Error('相似案例检索失败');
        return investigation({
          analysis: {
            ...investigation().analysis,
            status: 'success',
            evidenceQuality: 'limited'
          }
        });
      })
    });
    const useStore = createBugInvestigationStore(api, 'bug-investigation-store-retry');
    const store = useStore();
    await store.initialize('project-1');

    expect(await store.appendAndAnalyze('investigation-1', {
      type: 'code',
      content: 'const value = parseChunk(input)'
    })).toBe(false);
    expect(store.selected?.analysis.status).toBe('stale');
    expect(store.errorMessage).toContain('证据已保存');

    expect(await store.appendAndAnalyze('investigation-1', {
      type: 'code',
      content: 'const value = parseChunk(input)'
    })).toBe(true);
    expect(api.appendEvidence).toHaveBeenCalledOnce();
    expect(api.analyzeInvestigation).toHaveBeenCalledTimes(2);
  });

  it('keeps an explicit chat seed as an editable draft until creation succeeds', async () => {
    const api = createApi();
    const useStore = createBugInvestigationStore(api, 'bug-investigation-store-draft');
    const store = useStore();

    store.startDraft({
      evidence: { type: 'error', content: 'TypeError: failed to fetch' },
      sourceMessageId: 'message-1',
      sourceSessionId: 'session-1'
    });

    expect(store.draftSeed?.evidence.content).toBe('TypeError: failed to fetch');
    expect(api.createInvestigation).not.toHaveBeenCalled();

    store.clearDraft();
    expect(store.draftSeed).toBeNull();
  });
});
