import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildResearchSearchQuery,
  createDirectResearchPlan,
  normalizeResearchPlan,
  shouldUseDirectResearchPlan
} from './research-plan.js';

test('plan normalizer turns entity, facets, and evidence needs into a bounded search query', () => {
  const plan = normalizeResearchPlan(
    '请比较 OpenHands、Aider 和 SWE-agent 的任务执行、代码编辑和测试验证，并优先参考官方仓库。',
    {
      subquestions: [{
        subject: 'OpenHands',
        question: 'OpenHands 如何执行任务、编辑代码并验证结果？',
        intent: 'implementation',
        facets: ['task_execution', 'code_editing', 'test_validation'],
        preferredSourceTypes: ['official_repo', 'official_docs'],
        freshness: 'current',
        searchQuery: '这是一段不应该被直接采用的冗长模型搜索词，它可能包含未经验证的实现猜测'
      }]
    }
  );

  assert.equal(plan.planner, 'model');
  assert.equal(plan.subquestions.length, 1);
  assert.equal(plan.subquestions[0].subject, 'OpenHands');
  assert.deepEqual(plan.subquestions[0].facets, [
    'task_execution',
    'code_editing',
    'test_validation'
  ]);
  assert.deepEqual(plan.subquestions[0].evidenceNeed, {
    preferredSourceTypes: ['official_repo', 'official_docs'],
    freshness: 'current'
  });
  assert.match(plan.subquestions[0].searchQuery, /^OpenHands /);
  assert.match(plan.subquestions[0].searchQuery, /official GitHub/);
  assert.match(plan.subquestions[0].searchQuery, /official docs/);
  assert.doesNotMatch(plan.subquestions[0].searchQuery, /未经验证|实现猜测/);
  assert.ok(plan.subquestions[0].searchQuery.length <= 180);
});

test('leading implementation assumptions are rewritten as open evidence questions', () => {
  const plan = normalizeResearchPlan('SWE-agent 的任务执行和代码编辑机制是什么？', {
    subquestions: [{
      subject: 'SWE-agent',
      question: 'SWE-agent 是否通过 DOM 注入代码而非文件系统写入？',
      intent: 'implementation',
      facets: ['task_execution', 'code_editing'],
      preferredSourceTypes: ['official_repo']
    }]
  });

  assert.equal(plan.planner, 'model');
  assert.doesNotMatch(plan.subquestions[0].question, /DOM|而非|是否通过/);
  assert.match(plan.subquestions[0].question, /SWE-agent/);
  assert.match(plan.subquestions[0].question, /实际实现/);
  assert.doesNotMatch(plan.subquestions[0].searchQuery, /DOM/);
});

test('either-or and shared-state assumptions are also rewritten as open questions', () => {
  const plan = normalizeResearchPlan('比较 Aider 和 SWE-agent 的执行机制。', {
    subquestions: [
      {
        subject: 'Aider',
        question: 'Aider 是否支持端到端闭环，还是依赖外部工具链？',
        intent: 'implementation',
        facets: ['task_execution', 'test_validation'],
        preferredSourceTypes: ['official_repo']
      },
      {
        subject: 'SWE-agent',
        question: 'SWE-agent 是否具备统一框架并共享状态？',
        intent: 'implementation',
        facets: ['task_execution', 'context_state'],
        preferredSourceTypes: ['official_repo']
      }
    ]
  });
  assert.equal(plan.subquestions.length, 2);
  assert.ok(plan.subquestions.every((item) => item.question.includes('实际实现方式')));
  assert.ok(plan.subquestions.every((item) => !/是否|还是|依赖|共享/u.test(item.question)));
});

test('source preferences follow the research topic instead of globally forcing GitHub', () => {
  const plan = normalizeResearchPlan('现行个人信息保护法规有哪些核心要求？', {
    subquestions: [{
      subject: '个人信息保护法规',
      question: '现行个人信息保护法规有哪些核心要求？',
      intent: 'current_state',
      facets: ['适用范围', '核心义务'],
      preferredSourceTypes: ['government_document'],
      freshness: 'current'
    }]
  });

  assert.deepEqual(
    plan.subquestions[0].evidenceNeed.preferredSourceTypes,
    ['government_document']
  );
  assert.match(plan.subquestions[0].searchQuery, /government official/);
  assert.doesNotMatch(plan.subquestions[0].searchQuery, /GitHub/);
});

test('simple fact research can use a direct plan while comparisons still use the model planner', () => {
  assert.equal(shouldUseDirectResearchPlan('MCP 是什么？'), true);
  assert.equal(
    shouldUseDirectResearchPlan('请比较 OpenHands、Aider 和 SWE-agent 的代码编辑机制。'),
    false
  );

  const plan = createDirectResearchPlan('MCP 是什么？');
  assert.equal(plan.planner, 'direct');
  assert.equal(plan.subquestions.length, 1);
  assert.equal(plan.subquestions[0].question, 'MCP 是什么？');
});

test('query builder keeps only bounded subject, source, and facet terms', () => {
  const query = buildResearchSearchQuery({
    subject: 'Aider',
    facets: ['edit_formats', 'git_integration', 'test_validation', 'extra_field'],
    evidenceNeed: {
      preferredSourceTypes: ['official_docs', 'official_repo'],
      freshness: 'any'
    }
  }, 'Aider 有什么特点？');

  assert.equal(
    query,
    'Aider official docs official GitHub edit formats git integration test validation'
  );
});
