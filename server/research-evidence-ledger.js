/**
 * Evidence Ledger（Spec docs/specs/research-harness.md §7）。
 *
 * 纯函数：从 Run 最终/阶段 artifacts 的公开形状推导台账条目、原文 artifact 与
 * would-be Writer 差异报告；不发起读取、不写库。持久化由 store 的受守卫方法承担。
 *
 * 稳定身份（§7.1）：evidenceId = hash(runId, sourceChannel, canonicalSourceId,
 * contentHash)；contentHash 基于实际被读取的规范化内容（未读取来源以空内容参与
 * 哈希，来源内容变化产生新身份，不覆盖原证据）。
 *
 * 四维生命周期（§7.2）独立表达、不压成单一 status：
 * - screening: accepted | rejected(reason)
 * - reading:   pending | succeeded | failed(reason)
 * - extraction: not_selected | extracted | failed(reason)
 * - citation:  not_cited | cited
 *
 * provenance 转换（Phase 2A 特别要求）：只有经过受控 Reader/Adapter 成功读取的
 * 来源才能升级为 verified_primary（原因与 artifactRef 一并记录）；搜索结果声称
 * "官方"或仅命中可信域名不能直接升级；读取失败/筛选拒绝的来源保持原 provenance。
 */

import { createHash } from 'node:crypto';
import { expandCjkBigrams, tokenize } from './rag-utils.js';
import { deriveClaim, splitContentParagraphs } from './research-evidence.js';

export const LEDGER_VERSION = 1;
export const MAX_ARTIFACT_BYTES = 160_000;
export const EVIDENCE_LEDGER_MODES = Object.freeze(['off', 'shadow', 'primary']);

/**
 * 三态开关归一（Spec §12 Phase 2A）：off 关闭台账；shadow 双写对比（Phase 2A
 * 默认值）；primary 在通过双写验收门槛前不可用——请求即抛错，不做静默回落。
 */
export function normalizeEvidenceLedgerMode(value) {
  const mode = String(value || 'shadow').trim().toLowerCase();
  if (!EVIDENCE_LEDGER_MODES.includes(mode)) {
    throw new TypeError(`RESEARCH_EVIDENCE_LEDGER 非法取值：${value}（允许 off|shadow|primary）`);
  }
  if (mode === 'primary') {
    throw new TypeError('evidence ledger primary 模式未通过双写验收门槛前不可用（Phase 2A 仅开放 shadow）');
  }
  return mode;
}

const PROVIDER_FIELD_BY_CHANNEL = Object.freeze({
  web: 'controlled_web_search',
  local: 'project_knowledge_search'
});

export function normalizeContentForHash(content) {
  return String(content || '').replace(/\r/g, '').replace(/\u0000/g, '').trim();
}

/**
 * 按字节上限截断规范化内容（与 Reader 的字节上限语义一致）。
 */
export function boundArtifactContent(content, maxBytes = MAX_ARTIFACT_BYTES) {
  const normalized = normalizeContentForHash(content);
  const bytes = new TextEncoder().encode(normalized);
  if (bytes.byteLength <= maxBytes) {
    return { content: normalized, byteSize: bytes.byteLength, truncated: false };
  }
  const bounded = new TextDecoder().decode(bytes.slice(0, maxBytes)).trim();
  return { content: bounded, byteSize: Buffer.byteLength(bounded), truncated: true };
}

/**
 * 稳定身份：内容寻址。同一 Run 内同一来源同一版内容只产生一个 evidenceId；
 * 来源内容变化产生新身份。
 */
/**
 * 内容指纹：对规范化正文整体计算（不截断）。这是 evidenceId 的唯一内容输入。
 */
export function computeContentHash(content) {
  return createHash('sha256').update(normalizeContentForHash(content)).digest('hex');
}

/**
 * 稳定身份：evidenceId 由 (runId, sourceChannel, canonicalSourceId, contentHash)
 * 唯一决定；contentHash 必须由调用方基于完整规范化正文显式传入（可用
 * computeContentHash 计算，或采用 Reader 预计算的 full-content hash），本函数
 * 不做任何隐式重算或截断。
 */
export function computeEvidenceIdentity({ runId, sourceChannel, canonicalSourceId, contentHash }) {
  if (!contentHash) {
    throw new TypeError('computeEvidenceIdentity requires contentHash（基于完整规范化正文）');
  }
  const evidenceId = `ev_${createHash('sha256')
    .update([runId, sourceChannel, canonicalSourceId, contentHash].join('|'))
    .digest('hex')
    .slice(0, 32)}`;
  return { evidenceId, contentHash };
}

function domainOf(url) {
  try {
    return new URL(String(url || '')).hostname || '';
  } catch {
    return '';
  }
}

function citationIdFor(source) {
  return `${source.kind || 'source'}-${source.id || 'unknown'}`;
}

/**
 * 从阶段/最终 artifacts 推导台账条目。
 *
 * reading 维度的 document 形状：{ sourceId, content, readerKind, contentHash?,
 * attestation? }——attestation 是 Adapter 对"内容取得方式与来源身份"的显式声明：
 * 默认 { provenance: 'reader_obtained', reason } 只证明内容由该 Reader 获取；
 * 只有来源身份与官方主体关系经过明确验证的 Adapter 才能声明
 * provenance: 'verified_primary'（不得靠域名或搜索结果标签推断）。
 *
 * citation 维度在 extracting 阶段只能标记 writer_selected/pending（进入 Writer
 * 输入 ≠ 最终被报告引用）；最终 cited/not_cited 由 verifying 阶段的
 * verification.referencedCitationIds 经 store 的组合提交收敛。
 *
 * contentHash 基于 Reader 实际取得的完整规范化正文（document 可携带预计算的
 * full-content hash，避免对截断文本重算）；原文 artifact 按 160KB 上限截断保存。
 */
export function buildLedgerEntries({
  runId,
  acceptedSources = [],
  excludedSources = [],
  selectionExcluded = [],
  documents = [],
  readingFailures = [],
  subquestionIdBySourceId = {},
  evidence = [],
  citations = []
}) {
  const documentBySource = new Map(
    (Array.isArray(documents) ? documents : []).map((document) => [document.sourceId, document])
  );
  const failureBySource = new Map(
    (Array.isArray(readingFailures) ? readingFailures : []).map((failure) => [failure.sourceId, failure])
  );
  const selectionExcludedById = new Map(
    (Array.isArray(selectionExcluded) ? selectionExcluded : []).map((item) => [item.id, item])
  );
  const evidenceBySource = new Map();
  for (const item of Array.isArray(evidence) ? evidence : []) {
    evidenceBySource.set(item.sourceId, (evidenceBySource.get(item.sourceId) || 0) + 1);
  }
  const citationById = new Map(
    (Array.isArray(citations) ? citations : []).map((item) => [item.id, item])
  );

  const entries = [];
  const artifacts = [];

  const buildEntry = (source, { screeningStatus, screeningReason }) => {
    const document = documentBySource.get(source.id);
    const failure = failureBySource.get(source.id);
    // 内容身份基于 Reader 实际取得的完整规范化正文：document 可携带 Reader 预计算
    // 的 full-content hash，否则此处显式重算；artifact 只按上限截断保存。
    const contentHash = document?.contentHash
      || computeContentHash(document?.content || '');
    const { evidenceId } = computeEvidenceIdentity({
      runId,
      sourceChannel: source.kind,
      canonicalSourceId: source.url || source.id,
      contentHash
    });
    const bound = document
      ? boundArtifactContent(document.content)
      : { content: '', byteSize: 0, truncated: false };
    // 截断标记来自 Reader（如 provider_raw 先全量哈希再截断）与 artifact 上限的合成。
    const truncated = document?.truncated === true || bound.truncated;

    // reading 维度：Reader 实际结果；未被选中读取的来源保持 pending。
    const readingStatus = document
      ? 'succeeded'
      : failure
        ? 'failed'
        : 'pending';
    const readingReason = document
      ? ''
      : (failure ? `${failure.code}: ${failure.message}` : '');

    // Reader attestation（默认只证明"内容由该 Reader 获取"）。
    const readerAttestation = document
      ? (document.attestation || {
        provenance: 'reader_obtained',
        reason: `obtained_by_reader:${document.readerKind || 'unknown'}`
      })
      : null;

    // extraction 维度：固定枚举 not_selected | extracted | failed；原因放独立字段。
    const passageCount = evidenceBySource.get(source.id) || 0;
    const quotaExcluded = selectionExcludedById.get(source.id);
    const extractionStatus = passageCount > 0
      ? 'extracted'
      : 'not_selected';
    const extractionReason = quotaExcluded
      ? (quotaExcluded.reason || 'quota')
      : '';

    // citation 维度：extracting 阶段只标记进入 Writer 输入（writer_selected）；
    // 最终 cited/not_cited 由 verifying 阶段的 referencedCitationIds 收敛。
    const expectedCitationId = citationIdFor(source);
    const writerSelected = citationById.has(expectedCitationId);

    // provenance 转换：只有 Adapter 显式声明 verified_primary（来源身份与官方
    // 主体关系经过明确验证）的读取才升级；provider_raw / 任意 GitHub README
    // 读取成功都只是 reader_obtained，不自动升级；筛选拒绝与读取失败保持原值
    // 并记录原因。
    const provenanceBefore = String(source.provenance || 'unknown');
    const upgraded = readingStatus === 'succeeded'
      && source.kind === 'web'
      && readerAttestation?.provenance === 'verified_primary'
      && provenanceBefore !== 'verified_primary';
    const provenanceAfter = upgraded ? 'verified_primary' : provenanceBefore;
    const provenanceTransition = upgraded
      ? {
        from: provenanceBefore,
        to: provenanceAfter,
        reason: `verified_by_reader:${document.readerKind}`,
        artifactRef: ''
      }
      : (readingStatus === 'failed'
        ? { from: provenanceBefore, to: provenanceBefore, reason: `read_failed:${failure?.code || 'unknown'}`, artifactRef: '' }
        : (screeningStatus === 'rejected'
          ? { from: provenanceBefore, to: provenanceBefore, reason: `screening_rejected:${screeningReason || 'unknown'}`, artifactRef: '' }
          : null));

    // 成功读取的内容进入原文 artifact（按 160KB 上限截断保存，身份哈希仍是全量正文）。
    let artifactId = '';
    if (document && bound.content) {
      artifactId = `art_${createHash('sha256')
        .update([runId, source.id, contentHash].join('|'))
        .digest('hex')
        .slice(0, 32)}`;
      artifacts.push({
        artifactId,
        runId,
        kind: 'source_content',
        contentHash,
        byteSize: bound.byteSize,
        truncated,
        content: bound.content
      });
      if (upgraded && provenanceTransition) {
        provenanceTransition.artifactRef = artifactId;
      }
    }

    entries.push({
      evidenceId,
      runId,
      sourceChannel: source.kind || 'local',
      canonicalSourceId: source.url || source.id || '',
      canonicalUrl: source.url || '',
      title: source.title || '',
      domain: source.sourceDomain || domainOf(source.url),
      publishedAt: source.publishedAt || '',
      sourceType: source.sourceType || '',
      provenanceBefore,
      provenanceAfter,
      provenanceTransition,
      subquestionId: subquestionIdBySourceId[source.id] || source.subquestionId || '',
      query: (source.queries || [])[0] || '',
      discoverySnippet: String(source.snippet || '').slice(0, 1000),
      provider: PROVIDER_FIELD_BY_CHANNEL[source.kind] || source.kind || '',
      // 读取失败的来源走 snippet 回退：有效 readerKind 为 search_snippet（与
      // assembleResearchEvidence 的回退语义一致），reading 维度仍记录读取失败。
      readerKind: document?.readerKind || (failure ? 'search_snippet' : ''),
      contentHash,
      truncated,
      artifactId,
      screeningStatus,
      screeningReason: screeningReason || '',
      readingStatus,
      readingReason,
      extractionStatus,
      extractionReason,
      readerAttestation: readerAttestation?.provenance || '',
      readerAttestationReason: readerAttestation?.reason || '',
      citationStatus: writerSelected ? 'writer_selected' : 'pending',
      citationId: writerSelected ? expectedCitationId : ''
    });
  };

  for (const source of Array.isArray(acceptedSources) ? acceptedSources : []) {
    buildEntry(source, { screeningStatus: 'accepted' });
  }
  for (const source of Array.isArray(excludedSources) ? excludedSources : []) {
    buildEntry(
      { ...source, provenance: source.relevance?.classification?.provenance || source.provenance || 'unknown' },
      { screeningStatus: 'rejected', screeningReason: source.reason || 'low_relevance' }
    );
  }

  return { entries, artifacts };
}


// —— would-be Evidence Pack（Spec §12 第二交付门）——
// Ledger 按自身准入、passage 选择与稳定 citation 分配规则独立产出 would-be
// Evidence Pack/citations，供与旧 Writer 输入对比。规则全部确定性、无时间与
// 随机因素：同输入重跑得到逐字相同的结果。默认上限复用现有约定：8 来源、
// 12 passages、每来源每轮 2 段。

export const WOULD_BE_DEFAULT_LIMITS = Object.freeze({
  maxSources: 8,
  maxPassages: 12,
  maxPassagesPerSource: 2
});

/**
 * 不含 runId 的稳定来源键：同一来源在任何 Run 中键值相同，作为 would-be
 * citation 分配的最终 tie-break（Codex 修正第 2 点）。
 */
function stableSourceKey(entry) {
  return [entry.sourceChannel || '', entry.canonicalSourceId || '', entry.canonicalUrl || ''].join('|');
}

function querySignalsOf(value) {
  return uniqueTokens(expandCjkBigrams(tokenize(String(value || ''))));
}

function uniqueTokens(tokens) {
  return [...new Set(tokens.map((token) => String(token || '').toLowerCase())).values()]
    .filter((token) => token.length > 1);
}

function rankParagraphsForQuery(paragraphs, query) {
  const wanted = new Set(querySignalsOf(query));
  return paragraphs
    .map((paragraph, index) => {
      const paragraphSignals = new Set(querySignalsOf(paragraph));
      const overlap = [...wanted].filter((token) => paragraphSignals.has(token)).length;
      return { passage: paragraph, index, overlap };
    })
    .sort((left, right) => right.overlap - left.overlap || left.index - right.index)
    .map((item) => item.passage);
}

/**
 * Ledger 自身的 would-be Evidence Pack。
 *
 * 准入（evidence admission）：screening=accepted 且
 *   - reading=succeeded → 全文层（从原文 artifact 按 query 相关度选段）；
 *   - reading=failed → 薄层（发现摘要作为单段，标记 search_snippet 降质）；
 *   - reading=pending → 不准入（reason=reading_pending）。
 * passage 选择：每来源按 query 相关度取最多 maxPassagesPerSource 段，来源按
 *   （子问题顺序，evidenceId）稳定排序，总量受 maxPassages 约束。
 * citation 分配：按同一稳定顺序编号 1..N，id = `ledger-${evidenceId}`
 *   （内容寻址来源的血统，重跑可重复）。
 *
 * @param {object} input
 * @param {Array} input.entries Ledger 条目
 * @param {Array} input.artifacts Ledger 原文 artifact（含 content）
 * @param {string[]} input.subquestionOrder 子问题 id 的计划顺序
 * @param {object} [input.limits] { maxSources, maxPassages, maxPassagesPerSource }
 */
export function buildWouldBeEvidencePack({
  runId,
  entries,
  artifacts = [],
  subquestionOrder = [],
  limits = {}
} = {}) {
  const maxSources = Math.max(1, Number(limits?.maxSources ?? WOULD_BE_DEFAULT_LIMITS.maxSources));
  const maxPassages = Math.max(1, Number(limits?.maxPassages ?? WOULD_BE_DEFAULT_LIMITS.maxPassages));
  const maxPassagesPerSource = Math.max(1, Number(limits?.maxPassagesPerSource ?? WOULD_BE_DEFAULT_LIMITS.maxPassagesPerSource));

  const contentByArtifactId = new Map(
    (Array.isArray(artifacts) ? artifacts : []).map((artifact) => [artifact.artifactId, artifact.content])
  );
  const orderIndex = new Map(subquestionOrder.map((id, index) => [String(id), index]));

  // 准入：仅 accepted 来源；reading=succeeded 走全文层，failed 走薄层，pending 不准入。
  const admitted = [];
  const admissionExcluded = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry.screeningStatus !== 'accepted') {
      admissionExcluded.push({ evidenceId: entry.evidenceId, reason: 'screening_rejected' });
      continue;
    }
    if (entry.readingStatus === 'succeeded' && entry.artifactId && contentByArtifactId.has(entry.artifactId)) {
      admitted.push({ entry, tier: 'fulltext', content: contentByArtifactId.get(entry.artifactId), contentHash: entry.contentHash });
    } else if (entry.readingStatus === 'failed' && entry.discoverySnippet) {
      admitted.push({ entry, tier: 'thin', content: String(entry.discoverySnippet).slice(0, 1_000), contentHash: entry.contentHash });
    } else {
      admissionExcluded.push({
        evidenceId: entry.evidenceId,
        reason: entry.readingStatus === 'pending' || !entry.artifactId ? 'reading_pending' : 'no_content'
      });
    }
  }

  // 稳定排序：子问题计划顺序 → contentHash（内容寻址）→ evidenceId。用
  // contentHash 而非 evidenceId 做 tie-break，保证相同内容跨 Run 的分配顺序
  // 也可重复（evidenceId 含 runId，跨 Run 必然不同）。
  admitted.sort((left, right) => {
    const leftIndex = orderIndex.get(left.entry.subquestionId) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.get(right.entry.subquestionId) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    if (left.contentHash !== right.contentHash) {
      return left.contentHash < right.contentHash ? -1 : 1;
    }
    return stableSourceKey(left.entry).localeCompare(stableSourceKey(right.entry));
  });

  const admittedSources = admitted.slice(0, maxSources);
  for (const overflow of admitted.slice(maxSources)) {
    admissionExcluded.push({ evidenceId: overflow.entry.evidenceId, reason: 'source_cap' });
  }

  const citations = [];
  const evidence = [];
  let remaining = maxPassages;
  for (const { entry, tier, content } of admittedSources) {
    if (remaining <= 0) {
      admissionExcluded.push({ evidenceId: entry.evidenceId, reason: 'passage_cap' });
      continue;
    }
    const citationId = `ledger-${entry.evidenceId}`;
    const citationNumber = citations.length + 1;
    const paragraphs = splitContentParagraphs(content);
    const ranked = tier === 'fulltext'
      ? rankParagraphsForQuery(paragraphs, entry.query)
      : paragraphs;
    const selected = (ranked.length ? ranked : [content])
      .slice(0, Math.min(maxPassagesPerSource, remaining))
      .filter(Boolean);
    if (!selected.length) {
      admissionExcluded.push({ evidenceId: entry.evidenceId, reason: 'no_usable_passage' });
      continue;
    }
    // passage 内容指纹（Codex 修正第 1 点）：与 source 内容身份（entry.contentHash）
    // 分离——全文层为选段所依据的 artifact 内容，薄层为发现摘要本身。
    const passageContentHash = computeContentHash(content);
    citations.push({
      id: citationId,
      index: citationNumber,
      title: entry.title,
      url: entry.canonicalUrl,
      kind: entry.sourceChannel,
      subquestionId: entry.subquestionId,
      queries: [entry.query].filter(Boolean),
      sourceEntryId: entry.evidenceId,
      tier,
      readerKind: tier === 'thin' ? 'search_snippet' : entry.readerKind,
      contentHash: entry.contentHash,
      passageContentHash
    });
    selected.forEach((passage, passageIndex) => {
      evidence.push({
        id: `${citationId}-p${passageIndex + 1}`,
        citationId,
        citationNumber,
        claim: deriveClaim(passage),
        passage,
        passageContentHash,
        sourceId: entry.canonicalSourceId,
        subquestionId: entry.subquestionId,
        readerKind: tier === 'thin' ? 'search_snippet' : entry.readerKind,
        tier
      });
      remaining -= 1;
    });
  }

  return {
    citations,
    evidence,
    admission: {
      admittedCount: admittedSources.length,
      admittedEvidenceIds: admittedSources.map(({ entry }) => entry.evidenceId),
      excluded: admissionExcluded
    }
  };
}

/**
 * would-be Evidence Pack 与旧 Writer 输入的逐项差异分类（机器可读、可人工复核）。
 *
 * 分类（按旧 citation 逐项）：
 * - kept_fulltext：would-be 以全文层保留；
 * - kept_thin_downgraded（预期降级）：would-be 以搜索摘要薄证据保留（Reader 失败）；
 * - unexpected_loss（意外丢失）：would-be 中不存在且无正当理由——primary 门槛 2 计数项；
 * - ledger_added：would-be 新纳入（信息项，非丢失）。
 */
export function buildWouldBePackDiff({
  entries,
  wouldBe,
  oldCitations = [],
  oldEvidence = [],
  subquestionOrder = []
}) {
  const entryByOldCitationId = new Map(
    (Array.isArray(entries) ? entries : [])
      .filter((item) => item.citationId)
      .map((item) => [item.citationId, item])
  );
  const wouldBeByEntryId = new Map(
    (wouldBe?.citations || []).map((item) => [item.sourceEntryId, item])
  );

  const items = [];
  for (const oldCitation of Array.isArray(oldCitations) ? oldCitations : []) {
    const entry = entryByOldCitationId.get(oldCitation.id);
    const wouldBeCitation = entry ? wouldBeByEntryId.get(entry.evidenceId) : null;

    let classification;
    let reason;
    if (wouldBeCitation) {
      if (entry.readingStatus === 'succeeded') {
        classification = 'kept_fulltext';
        reason = 'would-be 以全文层保留该来源。';
      } else {
        classification = 'kept_thin_downgraded';
        reason = 'Reader 读取失败，would-be 以搜索摘要薄证据保留（预期降级）。';
      }
    } else if (entry) {
      classification = 'unexpected_loss';
      reason = `来源已通过筛选但未进入 would-be Pack（reading=${entry.readingStatus}）——primary 门槛 2 计数项。`;
    } else {
      classification = 'unexpected_loss';
      reason = '旧 citation 在台账中无对应条目——一致性破坏。';
    }
    items.push({
      oldCitationId: oldCitation.id,
      classification,
      reason,
      wouldBeCitationId: wouldBeCitation?.id || null,
      title: oldCitation.title || ''
    });
  }

  const coveredOld = new Set(
    (Array.isArray(oldEvidence) ? oldEvidence : [])
      .map((item) => item.subquestionId)
      .filter(Boolean)
  );
  const coveredWouldBe = new Set(
    (wouldBe?.evidence || [])
      .map((item) => item.subquestionId)
      .filter(Boolean)
  );
  const total = Math.max(1, subquestionOrder.length);
  const ratio = (size) => Number((size / total).toFixed(4));

  const keptItems = items.filter((item) => item.classification === 'kept_fulltext').length;
  const thinItems = items.filter((item) => item.classification === 'kept_thin_downgraded').length;
  const lossItems = items.filter((item) => item.classification === 'unexpected_loss').length;
  const addedItems = (wouldBe?.citations || []).filter(
    (item) => !items.some((old) => old.wouldBeCitationId === item.id)
  ).length;

  return {
    diagnostic: 'would_be_pack_diff',
    items,
    counts: {
      oldCitations: items.length,
      keptFulltext: keptItems,
      keptThinDowngraded: thinItems,
      unexpectedLoss: lossItems,
      ledgerAdded: addedItems
    },
    coverage: {
      old: ratio(coveredOld.size),
      wouldBe: ratio(coveredWouldBe.size),
      totalSubquestions: subquestionOrder.length,
      lostSubquestions: [...coveredOld].filter((id) => !coveredWouldBe.has(id))
    },
    wouldBeCitations: wouldBe?.citations || [],
    wouldBeEvidence: wouldBe?.evidence || []
  };
}
