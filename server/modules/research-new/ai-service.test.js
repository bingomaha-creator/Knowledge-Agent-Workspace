import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchNewAiService } from './ai-service.js';

test('AI Service 规范化 Brief/Tracks 并保持动态查询', async () => {
  const client = {
    async chatCompletions() {
      return { choices: [{ message: { content: JSON.stringify({
        brief: {
          objective: '比较版本', requiredQuestions: ['有什么变化？'],
          entities: [{ name: '产品', aliases: ['Product'] }], successCriteria: ['有直接证据']
        },
        tracks: [{ question: '变化是什么？', searchQueries: ['产品 版本 release notes'] }]
      }) } }] };
    }
  };
  const service = createResearchNewAiService({ qwenClient: client, model: 'test' });
  const result = await service.plan({ question: '比较版本', mode: 'web', now: '2026-09-16' });
  assert.equal(result.tracks[0].id, 'track-1');
  assert.deepEqual(result.tracks[0].searchQueries, ['产品 版本 release notes']);
});

test('Planner 兼容模型常见的字符串实体与 Track title 形态', async () => {
  const service = createResearchNewAiService({
    model: 'test',
    qwenClient: {
      async chatCompletions() {
        return { choices: [{ message: { content: JSON.stringify({
          brief: {
            entities: ['Runtime 3', 'Runtime 2'],
            comparison: { left: 'Runtime 3', right: 'Runtime 2' }
          },
          tracks: [{ title: '运行时变化', searchQueries: ['Runtime 3 vs Runtime 2 changes'] }]
        }) } }] };
      }
    }
  });

  const result = await service.plan({
    question: 'Runtime 3 相较 Runtime 2 有哪些变化？', mode: 'web', workspaceContext: [], now: '2026-09-17'
  });
  assert.deepEqual(result.brief.entities.map((entity) => entity.name), ['Runtime 3', 'Runtime 2']);
  assert.equal(result.tracks[0].question, '运行时变化');
});

test('Planner 丢失明确比较关系或过度拆分时只修复一次', async () => {
  const responses = [
    {
      brief: {
        objective: '比较两个版本', requiredQuestions: ['重要变化是什么？'],
        entities: [], preferredSourceTraits: ['一手资料']
      },
      tracks: Array.from({ length: 5 }, (_, index) => ({
        question: `扩张课题 ${index + 1}`,
        searchQueries: [`无关宽泛查询 ${index + 1}`]
      }))
    },
    {
      brief: {
        objective: '比较 PostgreSQL 17 与 PostgreSQL 16',
        requiredQuestions: ['PostgreSQL 17 相较 PostgreSQL 16 有哪些重要变化？'],
        entities: [{ name: 'PostgreSQL', aliases: [] }],
        comparison: { left: 'PostgreSQL 17', right: 'PostgreSQL 16' },
        preferredSourceTraits: ['一手发布资料']
      },
      tracks: [{
        question: '两个版本的重要变化是什么？',
        searchQueries: ['PostgreSQL 17 PostgreSQL 16 important changes']
      }]
    }
  ];
  const calls = [];
  const service = createResearchNewAiService({
    model: 'test',
    qwenClient: {
      async chatCompletions(body) {
        calls.push(JSON.parse(body.messages[1].content));
        return { choices: [{ message: { content: JSON.stringify(responses.shift()) } }] };
      }
    }
  });

  const result = await service.plan({
    question: 'PostgreSQL 17 相较 PostgreSQL 16 有哪些重要变化？',
    mode: 'web',
    workspaceContext: [],
    now: '2026-09-17'
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].validationIssues.sort(), [
    'entities_missing',
    'explicit_comparison_missing',
    'simple_question_overexpanded'
  ]);
  assert.deepEqual(calls[1].repairRequirements, {
    entitiesRequired: true,
    comparisonRequired: true,
    comparisonMarkers: ['17', '16'],
    maxTracks: 3,
    queryAnchorRequired: false
  });
  assert.deepEqual(result.brief.comparison, {
    left: 'PostgreSQL 17',
    right: 'PostgreSQL 16'
  });
  assert.equal(result.tracks.length, 1);
});

test('Planner 查询完全脱离 Brief 实体时触发一次修复', async () => {
  const responses = [
    {
      brief: {
        objective: '研究 WebAssembly 组件模型',
        requiredQuestions: ['组件模型如何工作？'],
        entities: [{ name: 'WebAssembly', aliases: ['Wasm'] }]
      },
      tracks: [{ question: '组件模型如何工作？', searchQueries: ['generic software overview'] }]
    },
    {
      brief: {
        objective: '研究 WebAssembly 组件模型',
        requiredQuestions: ['组件模型如何工作？'],
        entities: [{ name: 'WebAssembly', aliases: ['Wasm'] }]
      },
      tracks: [{ question: '组件模型如何工作？', searchQueries: ['WebAssembly component model'] }]
    }
  ];
  const calls = [];
  const service = createResearchNewAiService({
    model: 'test',
    qwenClient: {
      async chatCompletions(body) {
        calls.push(JSON.parse(body.messages[1].content));
        return { choices: [{ message: { content: JSON.stringify(responses.shift()) } }] };
      }
    }
  });

  const result = await service.plan({
    question: 'WebAssembly 组件模型如何工作？', mode: 'web', workspaceContext: [], now: '2026-09-17'
  });
  assert.deepEqual(calls[1].validationIssues, ['query_anchor_missing']);
  assert.deepEqual(result.tracks[0].searchQueries, ['WebAssembly component model']);
});

test('Planner 不将仓库占位符、知识库 ID 或本地文件名作为 Web 查询', async () => {
  const responses = [
    {
      brief: {
        objective: '评估前端状态管理',
        requiredQuestions: ['状态边界是否清晰？'],
        entities: [{ name: 'React', aliases: [] }],
        preferredSourceTraits: ['官方工程指南']
      },
      tracks: [{
        question: '状态边界是否清晰？',
        searchQueries: ['repo:organization/project-name react-frontend.md kb-40418887 state']
      }]
    },
    {
      brief: {
        objective: '评估前端状态管理',
        requiredQuestions: ['状态边界是否清晰？'],
        entities: [{ name: 'React', aliases: [] }],
        preferredSourceTraits: ['官方工程指南']
      },
      tracks: [{
        question: '状态边界是否清晰？',
        searchQueries: ['React client state server state ownership official guidance']
      }]
    }
  ];
  const calls = [];
  const service = createResearchNewAiService({
    model: 'test',
    qwenClient: {
      async chatCompletions(body) {
        calls.push(JSON.parse(body.messages[1].content));
        return { choices: [{ message: { content: JSON.stringify(responses.shift()) } }] };
      }
    }
  });

  const result = await service.plan({
    question: '结合项目文档评估 React 状态管理边界',
    mode: 'hybrid',
    workspaceContext: [{ knowledgeBaseId: 'kb-40418887', title: 'react-frontend.md' }],
    now: '2026-09-17'
  });

  assert.deepEqual(calls[1].validationIssues, ['web_query_not_executable']);
  assert.deepEqual(result.tracks[0].searchQueries, [
    'React client state server state ownership official guidance'
  ]);
});

test('Planner 修复后仍保留本地标识时生成有界的公网查询', async () => {
  const response = {
    brief: {
      objective: '评估架构边界',
      requiredQuestions: ['模块边界如何改善？'],
      entities: [{ name: 'modular architecture', aliases: [] }]
    },
    tracks: [{
      question: '前后端模块边界如何改善？',
      searchQueries: ['repo:organization/project-name server.md kb-40418887 boundary']
    }]
  };
  let calls = 0;
  const service = createResearchNewAiService({
    model: 'test',
    qwenClient: {
      async chatCompletions() {
        calls += 1;
        return { choices: [{ message: { content: JSON.stringify(response) } }] };
      }
    }
  });

  const result = await service.plan({
    question: '结合项目文档评估模块边界', mode: 'hybrid', workspaceContext: [], now: '2026-09-17'
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.tracks[0].searchQueries, [
    '前后端模块边界如何改善？ modular architecture'
  ]);
});

test('Planner 修复后仍丢失 Brief 实体时补回最小查询锚点', async () => {
  const response = {
    brief: {
      objective: '评估状态边界',
      requiredQuestions: ['状态边界是否清晰？'],
      entities: [{ name: 'React', aliases: [] }]
    },
    tracks: [{ question: '状态边界是否清晰？', searchQueries: ['client state ownership guidance'] }]
  };
  const service = createResearchNewAiService({
    model: 'test',
    qwenClient: {
      async chatCompletions() {
        return { choices: [{ message: { content: JSON.stringify(response) } }] };
      }
    }
  });

  const result = await service.plan({
    question: '结合项目文档评估 React 状态边界', mode: 'hybrid', workspaceContext: [], now: '2026-09-17'
  });

  assert.deepEqual(result.tracks[0].searchQueries, ['client state ownership guidance React']);
});

test('Evidence selector 与 Writer 使用各自受限输入', async () => {
  const responses = [
    { selections: [{ passageId: 'p1', supports: '命题', contradicts: '', relevance: 0.8, sourceRole: 'secondary' }] },
    {
      title: '报告',
      sections: [{
        trackId: 'track-1', heading: '结论', claims: [{
          type: 'workspace_fact', text: '项目事实', evidenceIds: ['E1']
        }]
      }],
      limitations: []
    }
  ];
  const calls = [];
  const client = {
    async chatCompletions(body) {
      calls.push(body);
      const value = responses.shift();
      return { choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] };
    }
  };
  const service = createResearchNewAiService({ qwenClient: client, model: 'test' });
  const selections = await service.selectEvidence({
    track: { id: 'track-1' },
    candidates: [{ id: 'p1', passage: '原文' }]
  });
  assert.equal(selections[0].passageId, 'p1');
  assert.deepEqual(selections[0].supports, ['命题']);
  assert.deepEqual(selections[0].contradicts, []);
  assert.match(calls[0].messages[0].content, /文档版本、URL、标题、搜索查询和导航链接不能单独证明/u);
  const draft = await service.writeReportDraft({
    brief: {}, mode: 'hybrid', tracks: [{
      id: 'track-1', question: '项目现状是什么？', status: 'answered'
    }], evidence: [{
      id: 'E1', trackId: 'track-1', sourceId: 'selected', origin: 'workspace', passage: '原文'
    }],
    sources: [
      { id: 'selected', trackId: 'track-1', origin: 'workspace', title: '已入选' },
      { id: 'excluded', trackId: 'track-1', origin: 'web', title: '未入选' }
    ],
    currentTime: '2026-09-17T12:00:00.000Z'
  });
  assert.equal(draft.sections[0].claims[0].evidenceIds[0], 'E1');
  const writerPayload = JSON.parse(calls[1].messages[1].content);
  assert.deepEqual(writerPayload.sources.map((source) => source.id), ['selected']);
  assert.equal('sourceCoverage' in writerPayload, false);
  assert.deepEqual(writerPayload.reportContract, [{
    trackId: 'track-1',
    status: 'answered',
    workspaceEvidenceIds: ['E1'],
    webEvidenceIds: [],
    allowedClaimTypes: ['workspace_fact'],
    limitationRequired: false
  }]);
  assert.equal(writerPayload.currentTime, '2026-09-17T12:00:00.000Z');
  assert.match(calls[1].messages[0].content, /未入选来源不能用作事实/u);
  assert.match(calls[1].messages[0].content, /reportContract/u);
});

test('Evidence selector 不将布尔值转成文本证据', async () => {
  const service = createResearchNewAiService({
    model: 'test',
    qwenClient: {
      async chatCompletions() {
        return { choices: [{ message: { content: JSON.stringify({
          selections: [{ passageId: 'p1', supports: true, contradicts: false, relevance: 1 }]
        }) } }] };
      }
    }
  });

  const selections = await service.selectEvidence({
    track: { id: 'track-1' }, candidates: [{ id: 'p1', passage: '原文' }]
  });
  assert.deepEqual(selections[0].supports, []);
  assert.deepEqual(selections[0].contradicts, []);
});

test('Gap Assessor 只为未解决 Track 返回不重复的有界补搜查询', async () => {
  let request;
  const service = createResearchNewAiService({
    model: 'test',
    qwenClient: {
      async chatCompletions(body) {
        request = body;
        return { choices: [{ message: { content: JSON.stringify({
          shouldReplan: true,
          conflicts: ['来源对行为变化的描述不一致'],
          trackResults: [
            {
              trackId: 'track-1', status: 'answered', reason: '已有完整证据',
              missingEvidence: [], followUpQueries: ['重复查询']
            },
            {
              trackId: 'track-2', status: 'partial', reason: '缺少一手说明',
              missingEvidence: ['官方说明'],
              followUpQueries: ['重复查询', 'repo:organization/project-name local.md', 'official behavior details']
            },
            { trackId: 'unknown', status: 'unresolved', followUpQueries: ['不应执行'] }
          ]
        }) } }] };
      }
    }
  });

  const assessment = await service.assessGaps({
    brief: { objective: '研究 Runtime 行为', entities: [{ name: 'Runtime', aliases: [] }] },
    tracks: [
      { id: 'track-1', question: '已回答问题', status: 'answered', gaps: [] },
      { id: 'track-2', question: '仍缺什么证据？', status: 'partial', gaps: ['只有摘要'] }
    ],
    evidence: [
      { id: 'E1', trackId: 'track-1', sourceId: 'source-1', contentLevel: 'full_text', supports: ['完整证据'] },
      { id: 'E2', trackId: 'track-2', sourceId: 'source-2', contentLevel: 'snippet', supports: ['摘要证据'] }
    ],
    sources: [{
      id: 'source-2', trackId: 'track-2', origin: 'web', title: '普通博客',
      url: 'https://example.com/blog', sourceKind: 'public_web', readerKind: 'provider_content'
    }],
    executedQueries: ['重复查询']
  });

  assert.equal(assessment.shouldReplan, true);
  assert.equal(assessment.trackResults.length, 2);
  assert.deepEqual(assessment.trackResults[0].followUpQueries, []);
  assert.deepEqual(assessment.trackResults[1].followUpQueries, [
    '仍缺什么证据？ Runtime',
    'official behavior details Runtime'
  ]);
  assert.deepEqual(assessment.conflicts, ['来源对行为变化的描述不一致']);
  const payload = JSON.parse(request.messages[1].content);
  assert.equal(payload.evidence[1].sourceId, 'source-2');
  assert.deepEqual(payload.sources[0], {
    id: 'source-2', trackId: 'track-2', origin: 'web', title: '普通博客',
    url: 'https://example.com/blog', sourceKind: 'public_web',
    readerKind: 'provider_content', readFailure: null
  });
  assert.match(request.messages[0].content, /普通网页不能冒充/u);
});
