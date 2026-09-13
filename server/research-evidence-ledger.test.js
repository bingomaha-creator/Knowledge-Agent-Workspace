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
 * - would-be diff 为逐项分类的差异报告（kept/预期降级/unexpected_loss），
 *   不是 primary 验收结果；人工复核字段为 pending_review。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundArtifactContent,
  buildLedgerEntries,
  buildWouldBeEvidencePack,
  buildWouldBePackDiff,
  computeContentHash,
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
  const hashA = computeContentHash('内容 A');
  const hashB = computeContentHash('内容 B');
  const first = computeEvidenceIdentity({
    runId: 'r1', sourceChannel: 'web', canonicalSourceId: 'https://example.org/1', contentHash: hashA
  });
  const again = computeEvidenceIdentity({
    runId: 'r1', sourceChannel: 'web', canonicalSourceId: 'https://example.org/1', contentHash: hashA
  });
  const changed = computeEvidenceIdentity({
    runId: 'r1', sourceChannel: 'web', canonicalSourceId: 'https://example.org/1', contentHash: hashB
  });
  assert.equal(first.evidenceId, again.evidenceId);
  assert.equal(first.contentHash, again.contentHash);
  assert.notEqual(first.evidenceId, changed.evidenceId, '来源内容变化必须产生新身份');
  assert.notEqual(first.contentHash, changed.contentHash);
  assert.throws(
    () => computeEvidenceIdentity({ runId: 'r1', sourceChannel: 'web', canonicalSourceId: 'x' }),
    /contentHash/,
    '缺少 contentHash 时必须显式报错，不得按空正文静默计算'
  );
});

test('内容身份基于完整正文：160KB 截断点之后的内容变化仍产生不同 evidenceId', () => {
  const prefix = 'x'.repeat(170_000);
  const hashA = computeContentHash(`${prefix}结尾 A`);
  const hashB = computeContentHash(`${prefix}结尾 B`);
  assert.notEqual(hashA, hashB, '全量哈希对截断点之后的内容敏感');
  const docA = computeEvidenceIdentity({
    runId: 'r1', sourceChannel: 'web', canonicalSourceId: 'https://example.org/a', contentHash: hashA
  });
  const docB = computeEvidenceIdentity({
    runId: 'r1', sourceChannel: 'web', canonicalSourceId: 'https://example.org/b', contentHash: hashB
  });
  assert.notEqual(docA.evidenceId, docB.evidenceId,
    '差异位于 160KB 截断点之后时，身份仍必须不同（artifact 截断保存不影响身份）');

  const artifactA = boundArtifactContent(`${prefix}结尾 A`);
  assert.equal(artifactA.truncated, true, 'artifact 按 160KB 上限截断保存');
  assert.ok(artifactA.byteSize <= 160_000 + 4);
});

test('document 可携带预计算的 full-content hash，Ledger 不对截断文本重算', () => {
  const computed = computeContentHash('正文');
  const { entries } = buildLedgerEntries({
    runId: 'r1',
    acceptedSources: [webSource({ id: 's1' })],
    documents: [{
      sourceId: 's1',
      content: '正文',
      readerKind: 'github_readme',
      contentHash: computed,
      attestation: { provenance: 'reader_obtained', reason: 'content_from_github_readme_endpoint' }
    }]
  });
  assert.equal(entries[0].contentHash, computed, '预计算 hash 被直接采用');
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

test('would-be Pack 差异：读取失败的 snippet 回退来源按预期降级保留，无意外丢失', () => {
  const runId = 'r1';
  const { entries, artifacts } = buildLedgerEntries({
    runId,
    acceptedSources: [
      webSource({ id: 's1', provenance: 'candidate_primary' }),
      webSource({ id: 's2', url: 'https://example.org/2', provenance: 'candidate_primary' })
    ],
    documents: [{ sourceId: 's1', content: '来源一完整正文', readerKind: 'github_readme' }],
    readingFailures: [{ sourceId: 's2', code: 'upstream_error', message: 'x', retryable: true }],
    subquestionIdBySourceId: { s1: 'q1', s2: 'q2' },
    evidence: [
      { sourceId: 's1', citationId: 'web-s1', claim: 'a', citationNumber: 1, subquestionId: 'q1', readerKind: 'github_readme' },
      { sourceId: 's2', citationId: 'web-s2', claim: 'b', citationNumber: 2, subquestionId: 'q2', readerKind: 'search_snippet' }
    ],
    citations: [{ id: 'web-s1', index: 1 }, { id: 'web-s2', index: 2 }]
  });
  const wouldBe = buildWouldBeEvidencePack({
    runId, entries, artifacts, subquestionOrder: ['q1', 'q2']
  });
  const diff = buildWouldBePackDiff({
    entries,
    wouldBe,
    oldCitations: [{ id: 'web-s1' }, { id: 'web-s2' }],
    oldEvidence: [{ citationId: 'web-s1', subquestionId: 'q1', readerKind: 'github_readme' }, { citationId: 'web-s2', subquestionId: 'q2', readerKind: 'search_snippet' }],
    subquestionOrder: ['q1', 'q2']
  });
  assert.equal(diff.diagnostic, 'would_be_pack_diff');
  const byOld = Object.fromEntries(diff.items.map((item) => [item.oldCitationId, item]));
  assert.equal(byOld['web-s1'].classification, 'kept_fulltext', '全文层来源保留');
  assert.equal(byOld['web-s2'].classification, 'kept_thin', '旧路径本来就是 snippet → kept_thin（无降级）');
  assert.equal(byOld['web-s2'].oldReaderKind, 'search_snippet');
  assert.ok(byOld['web-s2'].passageContentHashes.length > 0, '差异项携带 would-be 入选 passage 指纹');
  assert.equal(diff.counts.unexpectedLoss, 0, '无意外丢失');
  assert.equal(diff.counts.keptThin, 1);
  assert.equal(diff.coverage.wouldBe, diff.coverage.old, '覆盖率不劣化');
});

test('would-be Pack 差异：旧路径全文、would-be 薄层 → 真正降级 downgraded 独立计数', () => {
  // 构造"旧路径为全文、台账读取失败"的场景：台账 reading=failed（薄层），
  // 而旧 evidence 的 readerKind 为全文——真实降级必须独立于 kept_thin 计数。
  const runId = 'r1';
  const { entries, artifacts } = buildLedgerEntries({
    runId,
    acceptedSources: [webSource({ id: 's1', provenance: 'candidate_primary' })],
    readingFailures: [{ sourceId: 's1', code: 'upstream_error', message: 'x', retryable: true }],
    subquestionIdBySourceId: { s1: 'q1' },
    evidence: [{ sourceId: 's1', citationId: 'web-s1', claim: 'a', citationNumber: 1, subquestionId: 'q1', readerKind: 'github_readme' }],
    citations: [{ id: 'web-s1', index: 1 }]
  });
  // 人为将台账行修正为 reading succeeded（模拟旧路径拿到过正文但台账记录失败的错配场景不可达；
  // 此处直接以 reading=failed + 旧 evidence 全文 readerKind 构造 downgraded 分类）
  const wouldBe = buildWouldBeEvidencePack({
    runId, entries, artifacts, subquestionOrder: ['q1']
  });
  const diff = buildWouldBePackDiff({
    entries,
    wouldBe,
    oldCitations: [{ id: 'web-s1' }],
    oldEvidence: [{ citationId: 'web-s1', subquestionId: 'q1', readerKind: 'github_readme' }],
    subquestionOrder: ['q1']
  });
  // 台账 reading=failed → 薄层准入；旧 evidence 为全文 readerKind → downgraded
  assert.equal(diff.items[0].classification, 'downgraded');
  assert.equal(diff.counts.downgraded, 1);
  assert.equal(diff.counts.keptThin, 0);
  assert.equal(diff.counts.unexpectedLoss, 0, '降级不是丢失');
});

test('normalizeEvidenceLedgerMode：三态归一，primary 未过门槛前抛错', () => {
  assert.equal(normalizeEvidenceLedgerMode(undefined), 'shadow');
  assert.equal(normalizeEvidenceLedgerMode('off'), 'off');
  assert.equal(normalizeEvidenceLedgerMode('SHADOW'), 'shadow');
  assert.throws(() => normalizeEvidenceLedgerMode('primary'), /Phase 2A 仅开放 shadow/);
  assert.throws(() => normalizeEvidenceLedgerMode('bogus'), /非法取值/);
});

// —— Reader→Ledger 全链路（Codex Phase 2A 修正第 3 点）——
// provider_raw 先对完整原始 content 计算全量哈希，再截断保存 artifact：
// 相同 runId/sourceChannel/canonicalSourceId、仅 160KB 截断点之后正文不同的两次
// 读取，contentHash/evidenceId 必须不同，而 artifact 前缀相同且 truncated=true。
test('Reader→Ledger 全链路：160KB 后内容不同 → 身份不同，artifact 前缀相同且截断', async () => {
  const { createResearchSourceReader } = await import('./services/research-source-reader.js');
  const reader = createResearchSourceReader({
    fetchImpl: async () => { throw new Error('provider_raw 不应发起网络请求'); }
  });
  const runId = 'r-chain';
  const buildFor = async (suffix) => {
    const source = {
      id: 's1',
      title: '来源一',
      url: 'https://example.org/1',
      snippet: '摘要',
      kind: 'web',
      content: `${'x'.repeat(170_000)}${suffix}`
    };
    const document = await reader.readSource(source, undefined);
    assert.equal(document.truncated, true, 'Reader 按 160KB 截断 document 正文');
    return buildLedgerEntries({
      runId,
      acceptedSources: [{ ...source, subquestionId: 'q1' }],
      documents: [document],
      evidence: [{ sourceId: 's1', citationId: 'web-s1', claim: '主张', citationNumber: 1 }],
      citations: [{ id: 'web-s1', index: 1 }]
    });
  };

  const a = await buildFor('结尾 A');
  const b = await buildFor('结尾 B');

  assert.notEqual(a.entries[0].contentHash, b.entries[0].contentHash,
    '全量 contentHash 必须对截断点之后的内容敏感');
  assert.notEqual(a.entries[0].evidenceId, b.entries[0].evidenceId,
    'evidenceId 随 contentHash 变化（同一 canonicalSourceId 的不同版本是不同身份）');
  assert.equal(a.entries[0].truncated, true);
  assert.equal(a.artifacts[0].truncated, true);
  assert.equal(b.artifacts[0].truncated, true);
  assert.equal(a.artifacts[0].content, b.artifacts[0].content, 'artifact 保存相同的 160KB 截断前缀');
  assert.equal(a.artifacts[0].byteSize, b.artifacts[0].byteSize);
  assert.notEqual(a.artifacts[0].contentHash, b.artifacts[0].contentHash, 'artifact 记录的是全量哈希');
});

// —— buildWouldBeEvidencePack 表驱动单测（Codex 修正第 7 点）——
// 覆盖 fulltext、thin、pending/no-content、source cap、passage cap、每来源上限、
// 相同 contentHash 稳定排序；不再依赖大型 Phase 0 集成测试自证。

function wouldBeFixture({ sourceCount = 2, reading = 'succeeded', runId = 'r-wb', snippets = null } = {}) {
  const subquestionOrder = ['q1', 'q2'];
  const acceptedSources = Array.from({ length: sourceCount }, (_, index) => webSource({
    id: `s${index + 1}`,
    url: `https://example.org/${index + 1}`,
    provenance: 'candidate_primary',
    queries: [index % 2 === 0 ? '子问题一是什么？' : '子问题二是什么？']
  }));
  const entriesInput = acceptedSources.map((source, index) => ({
    ...source,
    readingStatusOverride: reading
  }));
  const documents = reading === 'succeeded'
    ? acceptedSources.map((source) => ({
      sourceId: source.id,
      content: `${source.id} 的完整正文，${source.snippet}`,
      readerKind: 'github_readme'
    }))
    : [];
  const readingFailures = reading === 'failed'
    ? acceptedSources.map((source) => ({ sourceId: source.id, code: 'upstream_error', message: 'x', retryable: true }))
    : [];
  return { runId, subquestionOrder, acceptedSources, documents, readingFailures, snippets };
}

test('would-be Pack：fulltext 准入并从原文 artifact 选段', () => {
  const { entries, artifacts } = buildLedgerEntries({
    runId: 'r-wb',
    acceptedSources: [webSource({ id: 's1' }), webSource({ id: 's2', url: 'https://example.org/2' })],
    documents: [
      { sourceId: 's1', content: '来源一完整正文，包含足够长的段落。', readerKind: 'github_readme' },
      { sourceId: 's2', content: '来源二完整正文，包含足够长的段落。', readerKind: 'github_readme' }
    ],
    citations: [{ id: 'web-s1', index: 1 }, { id: 'web-s2', index: 2 }]
  });
  const pack = buildWouldBeEvidencePack({
    runId: 'r-wb', entries, artifacts, subquestionOrder: ['q1', 'q2']
  });
  assert.equal(pack.citations.length, 2);
  assert.ok(pack.citations.every((item) => item.tier === 'fulltext' && item.selectionContentHash),
    'citation 汇总指纹使用显式命名 selectionContentHash');
  assert.ok(pack.citations.every((item) => item.canonicalSourceId && item.canonicalUrl),
    'would-be citation 必须携带显式来源身份');
  assert.ok(pack.evidence.length >= 2);
  assert.ok(pack.evidence.every((item) => item.passageContentHash === computeContentHash(item.passage)),
    '每条 evidence 的 passageContentHash 必须对实际入选 passage 内容计算');
});

test('would-be Pack：thin 准入使用发现摘要，snippet 变化改变 passageContentHash', () => {
  const build = (snippet) => {
    const { entries, artifacts } = buildLedgerEntries({
      runId: 'r-wb',
      acceptedSources: [webSource({ id: 's1', snippet })],
      readingFailures: [{ sourceId: 's1', code: 'upstream_error', message: 'x', retryable: true }],
      citations: []
    });
    return buildWouldBeEvidencePack({
      runId: 'r-wb', entries, artifacts, subquestionOrder: ['q1']
    });
  };
  const packA = build('原始摘要内容');
  const packB = build('变化后的摘要内容');
  assert.equal(packA.citations[0].tier, 'thin');
  assert.equal(packA.citations[0].readerKind, 'search_snippet');
  assert.notEqual(
    packA.evidence[0].passageContentHash,
    packB.evidence[0].passageContentHash,
    'snippet 内容变化必须改变对应 evidence 的 passageContentHash（Codex 修正第 1 点）'
  );
  assert.equal(
    packA.evidence[0].passageContentHash,
    computeContentHash(packA.evidence[0].passage),
    'passageContentHash 必须对实际入选 passage 的规范化内容计算'
  );
  // source 内容身份（contentHash，读取失败时空正文哈希）与 passage 身份分离
  assert.equal(packA.citations[0].contentHash, packB.citations[0].contentHash);
  // citation 汇总指纹也随 snippet 变化（薄层的选段依据就是摘要本身）
  assert.notEqual(packA.citations[0].selectionContentHash, packB.citations[0].selectionContentHash);
});

test('would-be Pack：reading pending 与无内容来源不准入并记录原因', () => {
  const { entries, artifacts } = buildLedgerEntries({
    runId: 'r-wb',
    acceptedSources: [webSource({ id: 's1' })],
    citations: []
  });
  const pack = buildWouldBeEvidencePack({
    runId: 'r-wb', entries, artifacts, subquestionOrder: ['q1']
  });
  assert.equal(pack.citations.length, 0);
  assert.ok(pack.admission.excluded.some((item) => item.reason === 'reading_pending'));
});

test('would-be Pack：source cap 超出部分排除并记录 source_cap', () => {
  const sources = Array.from({ length: 10 }, (_, index) => webSource({
    id: `s${index + 1}`,
    url: `https://example.org/${index + 1}`,
    provenance: 'candidate_primary'
  }));
  const { entries, artifacts } = buildLedgerEntries({
    runId: 'r-wb',
    acceptedSources: sources,
    documents: sources.map((source) => ({
      sourceId: source.id,
      content: `${source.id} 的完整正文，包含足够长的段落内容用于证据装配与选择。`,
      readerKind: 'github_readme'
    })),
    citations: []
  });
  const pack = buildWouldBeEvidencePack({
    runId: 'r-wb', entries, artifacts, subquestionOrder: [], limits: { maxSources: 8, maxPassages: 12, maxPassagesPerSource: 2 }
  });
  assert.equal(pack.citations.length, 8, '来源上限 8 生效');
  assert.ok(pack.admission.excluded.filter((item) => item.reason === 'source_cap').length === 2);
});

test('would-be Pack：passage cap 与每来源上限生效', () => {
  const sources = Array.from({ length: 8 }, (_, index) => webSource({
    id: `s${index + 1}`,
    url: `https://example.org/${index + 1}`,
    provenance: 'candidate_primary',
    queries: ['共享查询词']
  }));
  const { entries, artifacts } = buildLedgerEntries({
    runId: 'r-wb',
    acceptedSources: sources,
    documents: sources.map((source) => ({
      sourceId: source.id,
      content: `${source.id} 的完整正文段落一。\n\n${source.id} 的完整正文段落二。\n\n${source.id} 的完整正文段落三。`,
      readerKind: 'github_readme'
    })),
    citations: []
  });
  const pack = buildWouldBeEvidencePack({
    runId: 'r-wb', entries, artifacts, subquestionOrder: [], limits: { maxSources: 8, maxPassages: 12, maxPassagesPerSource: 2 }
  });
  assert.ok(pack.evidence.length <= 12, 'passage 总量上限 12 生效');
  const perSource = {};
  for (const item of pack.evidence) {
    perSource[item.sourceId] = (perSource[item.sourceId] || 0) + 1;
  }
  assert.ok(Object.values(perSource).every((count) => count <= 2), '每来源不超过 2 段');
});

test('would-be Pack：相同 contentHash 的两个来源按稳定来源键排序，跨 Run 一致', () => {
  const build = (runId) => {
    const sources = [
      webSource({ id: 's-b', url: 'https://b.example.org/x', provenance: 'candidate_primary' }),
      webSource({ id: 's-a', url: 'https://a.example.org/x', provenance: 'candidate_primary' })
    ];
    const { entries, artifacts } = buildLedgerEntries({
      runId,
      acceptedSources: sources,
      documents: sources.map((source) => ({
        sourceId: source.id,
        content: '两个来源的正文内容完全相同，用于验证相同 contentHash 下的稳定来源键排序。',
        readerKind: 'github_readme'
      })),
      citations: []
    });
    const pack = buildWouldBeEvidencePack({
      runId, entries, artifacts, subquestionOrder: ['q1']
    });
    return pack.citations.map((item) => item.canonicalSourceId || item.url);
  };
  const orderRunA = build('r-aaaa');
  const orderRunB = build('r-bbbb');
  assert.deepEqual(orderRunB, orderRunA, '不同 runId 下 canonicalSourceId → citation index 映射完全一致');
  assert.deepEqual(orderRunA, ['https://a.example.org/x', 'https://b.example.org/x'],
    '相同 contentHash 时按稳定来源键（canonicalSourceId）排序');
});
