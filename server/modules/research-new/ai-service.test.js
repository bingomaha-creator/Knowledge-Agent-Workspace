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

test('Evidence selector 与 Writer 使用各自受限输入', async () => {
  const responses = [
    { selections: [{ passageId: 'p1', supports: ['命题'], relevance: 0.8, sourceRole: 'secondary' }] },
    '# 报告\n结论 [E1]\n\n## 局限与未解决问题\n无\n\n## 来源\n[E1]'
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
  const report = await service.writeReport({
    brief: {}, tracks: [], evidence: [{ id: 'E1', sourceId: 'selected', passage: '原文' }],
    sources: [{ id: 'selected', title: '已入选' }, { id: 'excluded', title: '未入选' }]
  });
  assert.match(report, /\[E1\]/u);
  const writerPayload = JSON.parse(calls[1].messages[1].content);
  assert.deepEqual(writerPayload.sources.map((source) => source.id), ['selected']);
});
