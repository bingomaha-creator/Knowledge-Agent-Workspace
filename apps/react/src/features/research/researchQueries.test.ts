/**
 * 前端缓存仲裁回归测试（Spec research-harness §13.2：旧轮询响应不得覆盖更新的
 * task/verdict/evidence snapshot）。
 *
 * preferAuthoritativeTask 是轮询与缓存收敛的唯一仲裁点；本测试锁定其语义：
 * updatedAt 更新者获胜、且新快照的增量字段（contract/budget）原样带入缓存，
 * 不会被仲裁逻辑剥离。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { preferAuthoritativeTask } from './researchQueries';
import type { ResearchTask } from '@/services/researchApi';

function task(overrides: Partial<ResearchTask>): ResearchTask {
  return {
    id: 'research-1',
    question: 'q',
    status: 'completed',
    stage: 'completed',
    progress: 100,
    error: '',
    report: '',
    citations: [],
    searchMode: 'web',
    webSearchStatus: 'available',
    resultQuality: 'limited',
    limitations: [],
    failedStage: '',
    attempt: 1,
    cancelRequested: false,
    sessionId: 's',
    parentTaskId: '',
    turnIndex: 1,
    continuationContext: null,
    knowledgeBaseIds: [],
    artifacts: {},
    createdAt: 1,
    updatedAt: 100,
    startedAt: null,
    finishedAt: null,
    ...overrides
  };
}

describe('preferAuthoritativeTask', () => {
  it('旧轮询响应不得覆盖更新的快照', () => {
    const cached = task({ updatedAt: 200, contract: { mode: 'shadow', passed: true, nextAction: 'complete', checks: [] } });
    const stale = task({ updatedAt: 150, contract: null, budget: null });
    const winner = preferAuthoritativeTask(cached, stale);
    assert.equal(winner.updatedAt, 200);
    assert.equal(winner.contract?.nextAction, 'complete', '旧响应覆盖时保留缓存中的 contract');
  });

  it('新快照胜出并携带增量字段进入缓存', () => {
    const cached = task({ updatedAt: 100, contract: null, budget: null });
    const incoming = task({
      updatedAt: 300,
      contract: { mode: 'shadow', passed: false, nextAction: 'repair_report', checks: [] },
      budget: {
        wallTimeMs: 1200,
        webSearchCalls: 2,
        targetedReplans: { used: 0, limit: 1 },
        reportRepairs: { used: 0, limit: 1 },
        adapterRetries: { used: 0, limit: 3 },
        writerTokens: { input: 10, output: 20 },
        updatedAt: 300
      }
    });
    const winner = preferAuthoritativeTask(cached, incoming);
    assert.equal(winner.updatedAt, 300);
    assert.equal(winner.contract?.nextAction, 'repair_report');
    assert.equal(winner.budget?.webSearchCalls, 2);
  });
});
