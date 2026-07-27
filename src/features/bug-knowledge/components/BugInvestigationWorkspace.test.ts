// @vitest-environment happy-dom
import { createPinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchInvestigations: vi.fn(),
  createInvestigation: vi.fn(),
  appendEvidence: vi.fn(),
  analyzeInvestigation: vi.fn(),
  convertToCandidate: vi.fn(),
  closeInvestigation: vi.fn()
}));

vi.mock('../investigation-api', () => ({ bugInvestigationApi: api }));

import BugInvestigationWorkspace from './BugInvestigationWorkspace.vue';
import type { BugInvestigation } from '../investigation-types';

function investigation(overrides: Partial<BugInvestigation> = {}): BugInvestigation {
  return {
    id: 'investigation-1',
    projectRef: 'project-1',
    title: 'TypeError: currentMessage is undefined',
    status: 'draft',
    evidence: [{
      id: 'evidence-1',
      type: 'error',
      content: 'TypeError: currentMessage is undefined\nat sendMessage (src/store.ts:42:3)',
      redactions: [{ kind: 'authorization', count: 1 }],
      metadata: { fileName: '', language: '', lineStart: null },
      createdAt: 1
    }],
    facts: {
      errorTypes: ['TypeError'],
      messages: ['TypeError: currentMessage is undefined'],
      files: ['src/store.ts'],
      locations: ['src/store.ts:42:3'],
      frameworks: ['Pinia'],
      environments: ['browser'],
      errorSignatures: ['typeerror: currentmessage is undefined'],
      reproductionSteps: ['连续发送两个请求'],
      verificationNotes: [],
      evidenceIds: ['evidence-1']
    },
    analysis: {
      policyVersion: 'bug-investigation-grounding-v4',
      status: 'success',
      evidenceQuality: 'sufficient',
      summary: '并发请求可能共享了消息引用。',
      hypotheses: [{
        title: '共享 currentMessage',
        reasoning: '错误发生在并发请求期间。',
        falsification: '若不同 requestId 始终写入独立消息，则降低该假设优先级。',
        confidenceLabel: 'plausible',
        supportingEvidenceIds: ['evidence-1'],
        counterEvidenceIds: [],
        relatedCaseIds: ['case-1']
      }],
      verificationSteps: [{
        title: '记录 requestId',
        instruction: '检查请求与消息映射。',
        supportingSignal: '两个请求写入同一消息。',
        refutingSignal: '每个 requestId 始终只写入自己的消息。'
      }],
      missingEvidence: [],
      nextAction: {
        title: '执行一次定向验证',
        description: '记录 requestId 与 messageId 的对应关系。',
        evidenceType: 'verification'
      },
      similarCases: [{
        id: 'case-1',
        title: 'Pinia 并发串流',
        symptom: '消息混合',
        scope: 'project',
        sourceProjectRef: 'project-1',
        rootCause: '共享全局引用',
        fix: '按 requestId 隔离',
        verification: '并发回归通过',
        matchedChannels: ['exact'],
        rank: 1,
        score: 0.1
      }],
      retrievalTrace: { evidenceGap: false, ambiguous: false, degradedChannels: [] },
      reasonCode: ''
    },
    runs: [{
      id: 'run-1',
      status: 'success',
      mode: 'model',
      reasonCode: '',
      durationMs: 120,
      inputTokens: 100,
      outputTokens: 50,
      evidenceCount: 1,
      similarCaseCount: 1,
      createdAt: 2
    }],
    candidateReadiness: {
      ready: true,
      checks: [
        { key: 'symptom', label: '原始错误或明确现象', passed: true },
        { key: 'context', label: '技术上下文', passed: true }
      ]
    },
    candidateBugCaseId: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

describe('BugInvestigationWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchInvestigations.mockResolvedValue([investigation()]);
    api.createInvestigation.mockResolvedValue(investigation());
    api.analyzeInvestigation.mockResolvedValue(investigation());
    api.appendEvidence.mockResolvedValue(investigation({
      analysis: { ...investigation().analysis, status: 'stale' }
    }));
    api.convertToCandidate.mockResolvedValue(investigation({
      status: 'converted',
      candidateBugCaseId: 'candidate-1'
    }));
    api.closeInvestigation.mockResolvedValue(investigation({ status: 'closed' }));
  });

  it('visualizes facts, hypotheses, provenance, verification and redaction', async () => {
    const wrapper = mount(BugInvestigationWorkspace, {
      props: { projectRef: 'project-1' },
      global: { plugins: [createPinia()] }
    });
    await flushPromises();

    expect(wrapper.text()).toContain('已确认事实');
    expect(wrapper.get('[data-testid="investigation-next-action"]').text()).toContain('记录 requestId');
    expect(wrapper.text()).toContain('共享 currentMessage');
    expect(wrapper.get('[data-testid="verification-plan"]').text()).toContain('下一步怎么验证');
    expect(wrapper.get('[data-testid="verification-plan"]').text()).toContain('看到这些，支持当前假设');
    expect(wrapper.get('[data-testid="verification-plan"]').text()).toContain('出现这些，降低当前假设');
    expect(wrapper.get('[data-testid="verification-plan"]').text()).toContain('两个请求写入同一消息');
    expect(wrapper.get('[data-testid="verification-plan"]').text()).toContain('每个 requestId 始终只写入自己的消息');
    expect(wrapper.get('[data-testid="primary-hypothesis"]').text()).not.toContain('如何证伪');
    expect(wrapper.get('[data-testid="investigation-details"]').attributes('open')).toBeUndefined();
    expect(wrapper.get('[data-testid="convert-candidate"]').text()).toContain('转为 Candidate');
  });

  it('describes successful analysis as awaiting verification until verification evidence exists', async () => {
    api.fetchInvestigations.mockResolvedValue([investigation({
      facts: {
        ...investigation().facts,
        verificationNotes: []
      }
    })]);
    const wrapper = mount(BugInvestigationWorkspace, {
      props: { projectRef: 'project-1' },
      global: { plugins: [createPinia()] }
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="investigation-next-action"]').text())
      .toContain('已生成调查方向，待验证');
  });

  it('guides limited evidence toward one next action and hides candidate conversion', async () => {
    api.fetchInvestigations.mockResolvedValue([investigation({
      facts: {
        ...investigation().facts,
        frameworks: [],
        environments: [],
        reproductionSteps: []
      },
      analysis: {
        ...investigation().analysis,
        evidenceQuality: 'limited',
        missingEvidence: ['请补充 parseChunk 函数源码。'],
        nextAction: {
          title: '补充代码上下文',
          description: '请补充 parseChunk 函数源码。',
          evidenceType: 'code'
        }
      },
      candidateReadiness: {
        ready: false,
        checks: [
          { key: 'symptom', label: '原始错误或明确现象', passed: true },
          { key: 'context', label: '技术上下文', passed: false }
        ]
      }
    })]);

    const wrapper = mount(BugInvestigationWorkspace, {
      props: { projectRef: 'project-1' },
      global: { plugins: [createPinia()] }
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="investigation-next-action"]').text()).toContain('补充 parseChunk');
    expect(wrapper.find('[data-testid="convert-candidate"]').exists()).toBe(false);
    expect((wrapper.get('.append-evidence select').element as HTMLSelectElement).value).toBe('code');
  });

  it('hides persisted hypotheses from the retired policy until the investigation is reanalyzed', async () => {
    const legacy = investigation({
      analysis: {
        ...investigation().analysis,
        policyVersion: undefined,
        evidenceQuality: 'limited',
        hypotheses: [{
          ...investigation().analysis.hypotheses[0],
          title: '证据中没有出现的 SSE 推断'
        }],
        missingEvidence: ['请补充触发问题的操作与可执行复现步骤。'],
        nextAction: undefined
      },
      candidateReadiness: {
        ready: false,
        checks: [{ key: 'context', label: '技术上下文', passed: false }]
      }
    });
    api.fetchInvestigations.mockResolvedValue([legacy]);

    const wrapper = mount(BugInvestigationWorkspace, {
      props: { projectRef: 'project-1' },
      global: { plugins: [createPinia()] }
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="primary-hypothesis"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('旧假设已隐藏');
    expect(wrapper.text()).not.toContain('证据中没有出现的 SSE 推断');
    expect((wrapper.get('.append-evidence select').element as HTMLSelectElement).value).toBe('reproduction');
  });

  it('shows a retry state instead of another evidence form when saved analysis is stale', async () => {
    api.fetchInvestigations.mockResolvedValue([investigation({
      analysis: {
        ...investigation().analysis,
        status: 'stale'
      }
    })]);

    const wrapper = mount(BugInvestigationWorkspace, {
      props: { projectRef: 'project-1' },
      global: { plugins: [createPinia()] }
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="append-evidence"]').text()).toContain('重新分析');
    expect(wrapper.find('[data-testid="evidence-content"]').exists()).toBe(false);
    await wrapper.get('[data-testid="append-evidence"]').trigger('submit');
    await flushPromises();

    expect(api.appendEvidence).not.toHaveBeenCalled();
    expect(api.analyzeInvestigation).toHaveBeenCalledWith('investigation-1');
  });

  it('creates a candidate only after the explicit conversion action', async () => {
    const wrapper = mount(BugInvestigationWorkspace, {
      props: { projectRef: 'project-1' },
      global: { plugins: [createPinia()] }
    });
    await flushPromises();

    const convert = wrapper.findAll('button').find((button) =>
      button.text().includes('转为 Candidate')
    );
    expect(convert).toBeTruthy();
    await convert!.trigger('click');
    await flushPromises();

    expect(api.convertToCandidate).toHaveBeenCalledWith('investigation-1');
    expect(wrapper.emitted('converted')).toEqual([['candidate-1']]);
  });
});
