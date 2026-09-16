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
