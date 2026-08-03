import { describe, expect, it } from 'vitest';
import {
  buildResearchRunViewModel,
  diagnosticReasonLabel,
  plannerLabel
} from './presentation';
import type { ResearchTask } from './types';

function taskWithArtifacts(artifacts: ResearchTask['artifacts']): ResearchTask {
  return {
    id: 'research-1',
    question: '测试',
    status: 'completed',
    stage: 'completed',
    progress: 100,
    citations: [],
    knowledgeBaseIds: [],
    searchMode: 'hybrid',
    webSearchStatus: 'available',
    resultQuality: 'limited',
    limitations: [],
    attempt: 1,
    sessionId: 'research-1',
    parentTaskId: '',
    turnIndex: 1,
    artifacts,
    createdAt: 1,
    updatedAt: 1
  };
}

describe('research presentation', () => {
  it('adapts legacy artifacts into the diagnostics view without mutating the task', () => {
    const task = taskWithArtifacts({
      plan: {
        objective: '测试',
        planner: 'fallback',
        subquestions: []
      },
      writer: {
        mode: 'fallback',
        reasonCode: 'model_unavailable'
      }
    });
    const view = buildResearchRunViewModel(task);
    expect(view.plan?.planner).toBe('fallback');
    expect(view.diagnostics?.writing?.reasonCode).toBe('model_unavailable');
  });

  it('uses user-facing labels for execution modes and safe reason codes', () => {
    expect(plannerLabel('direct')).toBe('直接检索');
    expect(diagnosticReasonLabel('invalid_citations')).toBe('报告引用未通过校验');
  });
});
