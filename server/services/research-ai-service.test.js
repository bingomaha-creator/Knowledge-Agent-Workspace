import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createResearchAiService,
  createFallbackResearchPlan,
  normalizeResearchPlan
} from './research-ai-service.js';

test('planner accepts at most three topic-anchored and materially different subquestions', () => {
  const plan = normalizeResearchPlan('如何为 Vue Agent 设计可恢复的深度研究任务？', {
    subquestions: [
      { question: 'Vue Agent 的深度研究任务如何持久化阶段并恢复？', searchQuery: 'Vue Agent 深度研究 任务恢复', intent: 'implementation' },
      { question: 'Vue Agent 的深度研究任务失败重试有哪些边界？', searchQuery: 'Vue Agent 深度研究 重试 边界', intent: 'risk' },
      { question: '泛泛讨论有哪些风险？', searchQuery: '风险', intent: 'risk' },
      { question: 'Vue Agent 的深度研究任务如何持久化阶段并恢复？', searchQuery: 'Vue Agent 任务恢复', intent: 'implementation' }
    ]
  });

  assert.equal(plan.planner, 'model');
  assert.equal(plan.subquestions.length, 2);
  assert.deepEqual(plan.subquestions.map((item) => item.id), ['q1', 'q2']);
});

test('planner falls back to only the original question for malformed or out-of-scope output', () => {
  const plan = normalizeResearchPlan('如何为 Vue Agent 设计可恢复的深度研究任务？', {
    subquestions: [{ question: '咖啡豆烘焙有哪些风险？', searchQuery: '咖啡豆烘焙', intent: 'risk' }]
  });

  assert.equal(plan.planner, 'fallback');
  assert.equal(plan.subquestions.length, 1);
  assert.equal(plan.subquestions[0].question, '如何为 Vue Agent 设计可恢复的深度研究任务？');
});

test('fallback keeps one original-question branch but compacts an explicit GitHub project request for search', () => {
  const question = '如何做好一个 coding agent 呢？有 GitHub 的相关项目参考一下吗？';
  const plan = createFallbackResearchPlan(question, '规划模型执行失败');

  assert.equal(plan.planner, 'fallback');
  assert.equal(plan.subquestions.length, 1);
  assert.equal(plan.subquestions[0].question, question);
  assert.equal(plan.subquestions[0].searchQuery, 'coding agent GitHub');
});

test('planner fallback anchors a referential follow-up to the prior cited sources', async () => {
  const service = createResearchAiService({});
  const plan = await service.planResearch({
    question: '那你引用的这两个 agent 有什么特点，可以介绍一下吗？',
    continuationContext: {
      originQuestion: '如何做好一个 coding agent 呢？有 GitHub 的相关项目参考一下吗？',
      parent: {
        taskId: 'research-1',
        question: '如何做好一个 coding agent 呢？有 GitHub 的相关项目参考一下吗？',
        reportExcerpt: '第一轮引用了两个公开来源。',
        limitations: []
      },
      citations: [
        {
          id: 'paper',
          title: 'Agentic Very Much! Adoption of Coding Agent in New GitHub Projects',
          snippet: 'A paper about adoption of coding agents in GitHub projects.',
          originTaskId: 'research-1'
        },
        {
          id: 'roadmap',
          title: 'GitHub - Yuan-ManX/ai-agent-roadmap',
          snippet: 'A roadmap collecting AI agent frameworks.',
          originTaskId: 'research-1'
        }
      ]
    }
  });

  assert.equal(plan.planner, 'fallback');
  assert.match(plan.subquestions[0].searchQuery, /ai-agent-roadmap/i);
  assert.match(plan.subquestions[0].searchQuery, /Coding Agent/i);
});

test('planner rejects industry and compliance scenarios that the original RAG question never requested', () => {
  const plan = normalizeResearchPlan('如何做好一个 RAG 知识库？', {
    subquestions: [
      { question: 'RAG 知识库如何优化文档切片？', searchQuery: 'RAG 文档切片', intent: 'implementation' },
      { question: 'RAG 知识库在金融合规中需要什么审计字段？', searchQuery: 'RAG 金融合规审计', intent: 'risk' }
    ]
  });

  assert.equal(plan.subquestions.length, 1);
  assert.doesNotMatch(plan.subquestions[0].question, /金融|合规/);
});

test('writer receives the bounded evidence pack rather than raw retrieval output', async () => {
  const calls = [];
  const service = createResearchAiService({
    model: 'test-model',
    qwenClient: {
      async chatCompletions(body, options) {
        calls.push({ body, options });
        return { choices: [{ message: { content: '## 结论\n只基于给定资料。 [1]' } }] };
      }
    },
    logger: { warn() {} }
  });
  const result = await service.writeResearchReport({
    question: '研究任务如何恢复？',
    plan: { subquestions: [{ id: 'q1', question: '研究任务如何恢复？' }] },
    evidence: [{
      citationNumber: 1,
      title: '任务状态机',
      kind: 'local',
      snippet: '阶段产物持久化后可以恢复。',
      claim: '阶段产物持久化后可以恢复。',
      queries: ['研究任务如何恢复？'],
      rawToolPayload: 'must-not-leak'
    }]
  });

  assert.match(result.draftReport, /\[1\]/);
  assert.equal(result.diagnostics.mode, 'model');
  assert.equal(result.diagnostics.evidenceCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.stream, false);
  const prompt = calls[0].body.messages[1].content;
  assert.match(prompt, /阶段产物持久化后可以恢复/);
  assert.doesNotMatch(prompt, /must-not-leak/);
});
