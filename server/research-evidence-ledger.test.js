/**
 * Evidence Ledger 单元测试（Spec research-harness §7）。
 *
 * 重点验证 Phase 2A 的 provenance 状态转换：只有经受控 Reader/Adapter 成功读取
 * 的来源才升级 verified_primary；candidate_primary 不自动等同 verified；
 * read_failed / screening_rejected 保持原 provenance 并记录原因；来源内容变化
 * 产生新身份；would-be Writer 差异暴露 snippet 回退来源。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundArtifactContent,
  buildLedgerEntries,
  buildWriterInputDiff,
  computeEvidenceIdentity,
  normalizeEvidenceLedgerMode
} from './research-evidence-ledger.js';

function webSource(overrides = {}) {
  return {
    id: 's1',
    title: '来源一',
    url: 'https://example.org/1',
    snippet: '来源一摘要',
    kind: 'web',
    provenance: 'candidate_primary',
    queries: ['子问题一是什么？'],
    ...overrides
  };
}

test('稳定身份：同输入同身份，内容变化产生新身份', () => {
  const first = computeEvidenceIdentity({
    runId: 'r1', sourceChannel: 'web', canonicalSourceId: 'https://example.org/1', content: '内容 A'
  });
  const again = computeEvidenceIdentity({
    runId: 'r1', sourceChannel: 'web', canonicalSourceId: 'https://example.org/1', content: '内容 A'
  });
  const changed = computeEvidenceIdentity({
    runId: 'r1', sourceChannel: 'web', canonicalSourceId: 'https://example.org/1', content: '内容 B'
  });
  assert.equal(first.evidenceId, again.evidenceId);
  assert.equal(first.contentHash, again.contentHash);
  assert.notEqual(first.evidenceId, changed.evidenceId, '来源内容变化必须产生新身份');
  assert.notEqual(first.contentHash, changed.contentHash);
});

test('boundArtifactContent 按字节截断并标记 truncated', () => {
  const small = boundArtifactContent('短内容');
  assert.equal(small.truncated, false);
  const big = boundArtifactContent('x'.repeat(200_000), 1_000);
  assert.equal(big.truncated, true);
  assert.ok(big.byteSize <= 1_000 + 4, '截断后不超过上限（UTF-8 截断余量以内）');
});

test('provenance 转换：受控 Reader 读取成功才升级 verified_primary，并带 artifactRef', () => {
  const { entries, artifacts } = buildLedgerEntries({
    runId: 'r1',
    acceptedSources: [
      webSource({ id: 's1', provenance: 'candidate_primary' }),
      webSource({ id: 's2', url: 'https://example.org/2', provenance: 'unknown' })
    ],
    documents: [
      { sourceId: 's1', content: '来源一完整正文', readerKind: 'github_readme' }
    ],
    readingFailures: [
      { sourceId: 's2', code: 'upstream_error', message: '读取失败', retryable: true }
    ],
    evidence: [{ sourceId: 's1', citationId: 'web-s1', claim: '主张', citationNumber: 1 }],
    citations: [{ id: 'web-s1', index: 1 }]
  });

  const read = entries.find((item) => item.canonicalSourceId === 'https://example.org/1');
  assert.equal(read.readingStatus, 'succeeded');
  assert.equal(read.provenanceBefore, 'candidate_primary');
  assert.equal(read.provenanceAfter, 'verified_primary', '受控 Reader 成功读取 → 升级 verified_primary');
  assert.equal(read.provenanceTransition.reason, 'verified_by_reader:github_readme');
  assert.ok(read.provenanceTransition.artifactRef, '升级必须带 artifactRef');
  assert.ok(artifacts.some((item) => item.artifactId === read.provenanceTransition.artifactRef));

  const failed = entries.find((item) => item.canonicalSourceId === 'https://example.org/2');
  assert.equal(failed.readingStatus, 'failed');
  assert.equal(failed.provenanceAfter, 'unknown', '读取失败保持原 provenance');
  assert.equal(failed.provenanceTransition.reason, 'read_failed:upstream_error');
  assert.equal(failed.citationStatus, 'not_cited');
});

test('四维生命周期独立表达：筛选通过但读取失败、抽取与引用来自 snippet 回退', () => {
  const { entries } = buildLedgerEntries({
    runId: 'r1',
    acceptedSources: [
      webSource({ id: 's1', provenance: 'unknown' })
    ],
    readingFailures: [
      { sourceId: 's1', code: 'unsupported_source', message: '未命中 Adapter', retryable: false }
    ],
    evidence: [{ sourceId: 's1', citationId: 'web-s1', claim: 'snippet 回退主张', citationNumber: 1 }],
    citations: [{ id: 'web-s1', index: 1 }]
  });
  const entry = entries[0];
  assert.equal(entry.screeningStatus, 'accepted');
  assert.equal(entry.readingStatus, 'failed', '读取失败');
  assert.equal(entry.extractionStatus, 'extracted', 'snippet 回退的 passage 仍参与抽取（维度独立）');
  assert.equal(entry.citationStatus, 'cited');
});

test('筛选拒绝的来源进入台账并保持原 provenance', () => {
  const { entries } = buildLedgerEntries({
    runId: 'r1',
    acceptedSources: [],
    excludedSources: [
      { id: 's9', title: '无关来源', url: 'https://example.org/9', snippet: '无关', kind: 'web', reason: 'low_relevance', relevance: { classification: { provenance: 'unknown' } } }
    ]
  });
  const entry = entries[0];
  assert.equal(entry.screeningStatus, 'rejected');
  assert.equal(entry.screeningReason, 'low_relevance');
  assert.equal(entry.readingStatus, 'pending', '被拒绝来源不进入读取');
  assert.equal(entry.extractionStatus, 'not_selected');
  assert.equal(entry.provenanceTransition.reason, 'screening_rejected:low_relevance');
});

test('would-be Writer 差异：读取失败的 snippet 回退来源被台账排除在 Writer 输入之外', () => {
  const { entries } = buildLedgerEntries({
    runId: 'r1',
    acceptedSources: [
      webSource({ id: 's1', provenance: 'candidate_primary' }),
      webSource({ id: 's2', url: 'https://example.org/2', provenance: 'candidate_primary' })
    ],
    documents: [{ sourceId: 's1', content: '来源一完整正文', readerKind: 'github_readme' }],
    readingFailures: [{ sourceId: 's2', code: 'upstream_error', message: 'x', retryable: true }],
    evidence: [
      { sourceId: 's1', citationId: 'web-s1', claim: 'a', citationNumber: 1 },
      { sourceId: 's2', citationId: 'web-s2', claim: 'b', citationNumber: 2 }
    ],
    citations: [{ id: 'web-s1', index: 1 }, { id: 'web-s2', index: 2 }]
  });
  const diff = buildWriterInputDiff({ entries, citations: [{ id: 'web-s1' }, { id: 'web-s2' }] });
  assert.deepEqual(diff.ledgerWouldIncludeCitationIds, ['web-s1']);
  assert.deepEqual(diff.ledgerExcludedButWriterUsed, ['web-s2'],
    '读取失败却经 snippet 回退进入 Writer 的来源必须在差异中显式暴露');
  assert.equal(diff.counts.ledger, 1);
  assert.equal(diff.counts.actual, 2);
});

test('normalizeEvidenceLedgerMode：三态归一，primary 未过门槛前抛错', () => {
  assert.equal(normalizeEvidenceLedgerMode(undefined), 'shadow');
  assert.equal(normalizeEvidenceLedgerMode('off'), 'off');
  assert.equal(normalizeEvidenceLedgerMode('SHADOW'), 'shadow');
  assert.throws(() => normalizeEvidenceLedgerMode('primary'), /Phase 2A 仅开放 shadow/);
  assert.throws(() => normalizeEvidenceLedgerMode('bogus'), /非法取值/);
});
