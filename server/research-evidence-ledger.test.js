/**
 * Evidence Ledger 单元测试（Spec research-harness §7）。
 *
 * 重点验证：
 * - 内容身份基于 Reader 实际取得的完整规范化正文（160KB 截断点之后的内容变化
 *   仍产生不同 evidenceId）；原文 artifact 按上限截断保存；
 * - reading succeeded / 内容 attestation / 来源 provenance 三者分离：
 *   provider_raw 与任意 GitHub README 读取成功只是 reader_obtained，不自动升级
 *   verified_primary；只有 Adapter 显式声明 verified_primary 才升级；
 * - 四维生命周期独立表达 + extraction 固定枚举（原因独立字段）；
 * - citation 维度在 extracting 阶段只标记 writer_selected/pending；
 * - would-be diff 是读取资格差异诊断，不是 primary 验收结果。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundArtifactContent,
  buildLedgerEntries,
  buildReadingEligibilityDiff,
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

test('内容身份基于完整正文：160KB 截断点之后的内容变化仍产生不同 evidenceId', () => {
  const prefix = 'x'.repeat(170_000);
  const docA = computeEvidenceIdentity({
    runId: 'r1', sourceChannel: 'web', canonicalSourceId: 'https://example.org/a', content: `${prefix}结尾 A`
  });
  const docB = computeEvidenceIdentity({
    runId: 'r1', sourceChannel: 'web', canonicalSourceId: 'https://example.org/b', content: `${prefix}结尾 B`
  });
  assert.notEqual(docA.evidenceId, docB.evidenceId,
    '差异位于 160KB 截断点之后时，身份仍必须不同（artifact 截断保存不影响身份）');

  const artifactA = boundArtifactContent(`${prefix}结尾 A`);
  assert.equal(artifactA.truncated, true, 'artifact 按 160KB 上限截断保存');
  assert.ok(artifactA.byteSize <= 160_000 + 4);
});

test('document 可携带预计算的 full-content hash，Ledger 不对截断文本重算', () => {
  const computed = computeEvidenceIdentity({
    runId: 'r1', sourceChannel: 'web', canonicalSourceId: 'src', content: '正文'
  });
  const { entries } = buildLedgerEntries({
    runId: 'r1',
    acceptedSources: [webSource({ id: 's1' })],
    documents: [{
      sourceId: 's1',
      content: '正文',
      readerKind: 'github_readme',
      contentHash: computed.contentHash,
      attestation: { provenance: 'reader_obtained', reason: 'content_from_github_readme_endpoint' }
    }]
  });
  assert.equal(entries[0].contentHash, computed.contentHash, '预计算 hash 被直接采用');
});

test('attestation 与 provenance 分离：provider_raw/GitHub 读取成功只是 reader_obtained', () => {
  const { entries } = buildLedgerEntries({
    runId: 'r1',
    acceptedSources: [
      webSource({ id: 's1', provenance: 'candidate_primary' }),
      webSource({ id: 's2', url: 'https://example.org/2', provenance: 'unknown' })
    ],
    documents: [
      { sourceId: 's1', content: '来源一完整正文', readerKind: 'github_readme' },
      { sourceId: 's2', content: '来源二完整正文', readerKind: 'provider_raw' }
    ],
    evidence: [{ sourceId: 's1', citationId: 'web-s1', claim: '主张', citationNumber: 1 }],
    citations: [{ id: 'web-s1', index: 1 }]
  });

  const github = entries.find((item) => item.canonicalSourceId === 'https://example.org/1');
  assert.equal(github.readingStatus, 'succeeded');
  assert.equal(github.readerAttestation, 'reader_obtained',
    '任意 GitHub README 读取成功不得自动升级 verified_primary');
  assert.equal(github.provenanceAfter, 'candidate_primary', 'provenance 保持原值');
  assert.equal(github.provenanceTransition, null, '无升级即无转换');

  const provider = entries.find((item) => item.canonicalSourceId === 'https://example.org/2');
  assert.equal(provider.readerAttestation, 'reader_obtained',
    'provider_raw 只证明内容来自 Provider payload');
  assert.equal(provider.provenanceAfter, 'unknown');
  assert.equal(provider.readingStatus, 'succeeded');
  assert.equal(provider.citationStatus, 'pending', '未进入 Writer 输入的来源保持 pending');
});

test('只有 Adapter 显式声明 verified_primary 才升级，并带 artifactRef', () => {
  const { entries, artifacts } = buildLedgerEntries({
    runId: 'r1',
    acceptedSources: [webSource({ id: 's1', provenance: 'candidate_primary' })],
    documents: [{
      sourceId: 's1',
      content: '来源一完整正文',
      readerKind: 'official_docs',
      attestation: { provenance: 'verified_primary', reason: 'official_ownership_verified' }
    }],
    evidence: [{ sourceId: 's1', citationId: 'web-s1', claim: '主张', citationNumber: 1 }],
    citations: [{ id: 'web-s1', index: 1 }]
  });
  const entry = entries[0];
  assert.equal(entry.provenanceAfter, 'verified_primary');
  assert.equal(entry.provenanceTransition.reason, 'verified_by_reader:official_docs');
  assert.ok(entry.provenanceTransition.artifactRef);
  assert.ok(artifacts.some((item) => item.artifactId === entry.provenanceTransition.artifactRef));
});

test('读取失败：保持原 provenance 并记录 read_failed 原因', () => {
  const { entries } = buildLedgerEntries({
    runId: 'r1',
    acceptedSources: [webSource({ id: 's2', url: 'https://example.org/2', provenance: 'unknown' })],
    readingFailures: [
      { sourceId: 's2', code: 'upstream_error', message: '读取失败', retryable: true }
    ]
  });
  const entry = entries[0];
  assert.equal(entry.readingStatus, 'failed');
  assert.equal(entry.provenanceAfter, 'unknown', '读取失败保持原 provenance');
  assert.equal(entry.provenanceTransition.reason, 'read_failed:upstream_error');
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
  assert.equal(entry.citationStatus, 'writer_selected', 'extracting 阶段只标记进入 Writer 输入');
});

test('extraction 固定枚举：配额原因放独立 extractionReason 字段', () => {
  const { entries } = buildLedgerEntries({
    runId: 'r1',
    acceptedSources: [
      webSource({ id: 's1', provenance: 'candidate_primary' }),
      webSource({ id: 's5', url: 'https://example.org/5', provenance: 'candidate_primary' })
    ],
    selectionExcluded: [{ id: 's5', reason: 'max_sources_per_document' }],
    evidence: [{ sourceId: 's1', citationId: 'web-s1', claim: 'a', citationNumber: 1 }]
  });
  const selected = entries.find((item) => item.canonicalSourceId === 'https://example.org/1');
  const excluded = entries.find((item) => item.canonicalSourceId === 'https://example.org/5');
  assert.equal(selected.extractionStatus, 'extracted');
  assert.equal(selected.extractionReason, '');
  assert.equal(excluded.extractionStatus, 'not_selected', '枚举保持固定，不含内嵌原因');
  assert.equal(excluded.extractionReason, 'max_sources_per_document');
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
  assert.equal(entry.citationStatus, 'pending');
  assert.equal(entry.provenanceTransition.reason, 'screening_rejected:low_relevance');
});

test('读取资格差异诊断：读取失败的 snippet 回退来源被显式暴露', () => {
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
  const diff = buildReadingEligibilityDiff({ entries, citations: [{ id: 'web-s1' }, { id: 'web-s2' }] });
  assert.equal(diff.diagnostic, 'reading_eligibility',
    '当前 diff 是读取资格差异诊断，不是 Ledger primary 验收结果');
  assert.deepEqual(diff.ledgerWouldIncludeCitationIds, ['web-s1']);
  assert.deepEqual(diff.ledgerExcludedButWriterUsed, ['web-s2']);
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
