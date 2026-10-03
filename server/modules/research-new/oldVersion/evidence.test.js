import assert from 'node:assert/strict';
import test from 'node:test';
import { assessTracks, buildPassageCandidates, materializeEvidence, passageHash } from './evidence.js';

test('Evidence 只能引用本轮候选 passage，且哈希来自实际段落', () => {
  const candidates = buildPassageCandidates([{
    id: 'source-1', trackId: 'track-1', origin: 'web', contentLevel: 'full_text',
    content: '第一段提供足够长的版本变化证据，说明行为发生了明确改变。\n\n第二段说明兼容性边界和迁移限制，也包含足够信息。'
  }]);
  const evidence = materializeEvidence({
    track: { id: 'track-1' },
    candidates,
    selections: [
      { passageId: candidates[0].id, supports: ['版本变化'], relevance: 0.9, sourceRole: 'primary_candidate' },
      { passageId: 'invented', supports: ['模型虚构'] }
    ]
  });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].passageHash, passageHash(evidence[0].passage));
});

test('Track 状态区分正文、snippet 与零证据', () => {
  const tracks = ['a', 'b', 'c'].map((id) => ({ id, question: id, gaps: [] }));
  const assessed = assessTracks(tracks, [
    { trackId: 'a', contentLevel: 'full_text' },
    { trackId: 'b', contentLevel: 'snippet' }
  ]);
  assert.deepEqual(assessed.map((track) => track.status), ['answered', 'partial', 'unresolved']);
});

test('Track 未形成 Evidence 时区分无来源与已读取但未入选', () => {
  const tracks = [
    { id: 'no-source', question: '没有候选来源' },
    { id: 'not-selected', question: '有来源但没有直接证据' }
  ];
  const assessed = assessTracks(tracks, [], [{
    id: 'source-1', trackId: 'not-selected', origin: 'workspace', content: '已读取内容'
  }]);

  assert.deepEqual(assessed[0].gaps, ['未检索到可供评估的来源']);
  assert.deepEqual(assessed[1].gaps, ['已读取 1 个来源，但没有段落通过 Evidence 选择']);
});

test('长正文按当前 Track 与 Provider 摘要选择相关段落，而不是只取文首', () => {
  const filler = (label) => `${label} ${'unrelated introductory material '.repeat(18)}`;
  const candidates = buildPassageCandidates([{
    id: 'source-long', trackId: 'track-1', origin: 'web', contentLevel: 'full_text',
    query: 'PostgreSQL 17 incompatible changes',
    snippet: 'Remove server variable old_snapshot_threshold and change maintenance search_path.',
    content: [
      filler('Introduction A'), filler('Introduction B'), filler('Introduction C'),
      filler('Introduction D'),
      'Incompatible Changes\n\nRemove server variable old_snapshot_threshold. Maintenance operations now use a safe search_path.'
    ].join('\n\n')
  }], {
    question: 'PostgreSQL 17 有哪些不兼容变化？',
    evidenceRequirements: ['Identify removed settings and behavior changes']
  });

  assert.equal(candidates.length, 3);
  assert.ok(candidates.some((candidate) => candidate.passage.includes('old_snapshot_threshold')));
});
