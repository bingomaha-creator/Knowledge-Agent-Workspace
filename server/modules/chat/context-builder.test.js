import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContext } from './context-builder.js';

function candidate(id, kind, content, extra = {}) {
  return {
    id,
    kind,
    sourceRef: { id },
    messages: [{ role: kind === 'current_user' ? 'user' : 'system', content }],
    ...extra
  };
}

test('ContextBuilder always keeps required candidates and reports their decisions', () => {
  const result = buildContext({
    purpose: 'answer_generation',
    profile: {
      id: 'test-profile',
      contextWindowTokens: 200,
      outputReserveTokens: 40,
      safetyReserveTokens: 20
    },
    candidates: [
      candidate('system-base', 'system_rule', '遵守系统规则', {
        messages: [{ id: 'transport-only-id', role: 'system', content: '遵守系统规则' }]
      }),
      candidate('user-current', 'current_user', '回答当前问题')
    ]
  });

  assert.deepEqual(result.messages.map((message) => message.role), ['system', 'user']);
  assert.equal('id' in result.messages[0], false);
  assert.equal(result.manifest.profile.inputBudgetTokens, 140);
  assert.equal(result.manifest.summary.includedCount, 2);
  assert.deepEqual(
    result.manifest.decisions.map(({ candidateId, decision, reason }) => ({
      candidateId,
      decision,
      reason
    })),
    [
      { candidateId: 'system-base', decision: 'included', reason: 'required' },
      { candidateId: 'user-current', decision: 'included', reason: 'required' }
    ]
  );
});

test('ContextBuilder fails instead of truncating required context', () => {
  assert.throws(
    () => buildContext({
      purpose: 'answer_generation',
      profile: {
        id: 'tiny-profile',
        contextWindowTokens: 20,
        outputReserveTokens: 8,
        safetyReserveTokens: 4
      },
      candidates: [
        candidate('system-base', 'system_rule', '必须完整保留的系统规则非常非常长'),
        candidate('user-current', 'current_user', '必须完整保留的当前用户问题')
      ]
    }),
    (error) => error?.code === 'CONTEXT_BUDGET_EXCEEDED'
  );
});

test('ContextBuilder keeps conversation turns whole and excludes later candidates by budget', () => {
  const result = buildContext({
    purpose: 'answer_generation',
    profile: {
      id: 'whole-turn-profile',
      contextWindowTokens: 42,
      outputReserveTokens: 10,
      safetyReserveTokens: 10
    },
    candidates: [
      candidate('system-base', 'system_rule', '规'),
      candidate('user-current', 'current_user', '问'),
      candidate('turn-recent', 'conversation_turn', '', {
        messages: [
          { role: 'user', content: '旧问' },
          { role: 'assistant', content: '旧答' }
        ]
      }),
      candidate('knowledge-1', 'knowledge_chunk', '知识知识知识知识知识')
    ]
  });

  assert.deepEqual(
    result.messages.map((message) => `${message.role}:${message.content}`),
    ['system:规', 'user:旧问', 'assistant:旧答', 'user:问']
  );
  assert.deepEqual(
    result.manifest.decisions.map(({ candidateId, decision, reason }) => ({
      candidateId,
      decision,
      reason
    })),
    [
      { candidateId: 'system-base', decision: 'included', reason: 'required' },
      { candidateId: 'user-current', decision: 'included', reason: 'required' },
      {
        candidateId: 'turn-recent',
        decision: 'included',
        reason: 'conversation_continuity'
      },
      { candidateId: 'knowledge-1', decision: 'excluded', reason: 'over_budget' }
    ]
  );
});

test('ContextBuilder records scope and duplicate exclusions without copying candidate content', () => {
  const result = buildContext({
    purpose: 'answer_generation',
    profile: {
      id: 'audit-profile',
      contextWindowTokens: 400,
      outputReserveTokens: 40,
      safetyReserveTokens: 20
    },
    candidates: [
      candidate('system-base', 'system_rule', '系统正文'),
      candidate('user-current', 'current_user', '用户正文'),
      candidate('knowledge-primary', 'knowledge_chunk', '知识正文', {
        sourceRef: { id: 'chunk-1', parentId: 'doc-1' }
      }),
      candidate('knowledge-duplicate', 'knowledge_chunk', '重复知识正文', {
        sourceRef: { id: 'chunk-1', parentId: 'doc-1' }
      }),
      candidate('research-foreign', 'research_evidence', '越界研究正文', {
        eligible: false,
        exclusionReason: 'out_of_scope',
        sourceRef: {
          id: 'evidence-1',
          parentId: 'research-task-other',
          title: '不应透传的标题'
        }
      })
    ]
  });

  assert.deepEqual(
    result.manifest.decisions.map(({ candidateId, decision, reason }) => ({
      candidateId,
      decision,
      reason
    })),
    [
      { candidateId: 'system-base', decision: 'included', reason: 'required' },
      { candidateId: 'user-current', decision: 'included', reason: 'required' },
      { candidateId: 'knowledge-primary', decision: 'included', reason: 'relevant' },
      { candidateId: 'knowledge-duplicate', decision: 'excluded', reason: 'duplicate' },
      { candidateId: 'research-foreign', decision: 'excluded', reason: 'out_of_scope' }
    ]
  );
  const serializedManifest = JSON.stringify(result.manifest);
  assert.equal(serializedManifest.includes('系统正文'), false);
  assert.equal(serializedManifest.includes('用户正文'), false);
  assert.equal(serializedManifest.includes('知识正文'), false);
  assert.equal(serializedManifest.includes('越界研究正文'), false);
  assert.equal(serializedManifest.includes('不应透传的标题'), false);
});
