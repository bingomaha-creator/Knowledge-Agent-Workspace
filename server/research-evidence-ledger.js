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
      subquestionId: source.subquestionId || '',
      query: (source.queries || [])[0] || '',
      provider: PROVIDER_FIELD_BY_CHANNEL[source.kind] || source.kind || '',
      readerKind: document?.readerKind || (failure ? failure.readerKind || '' : ''),
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

/**
 * 读取资格差异诊断（shadow 模式产物）：Ledger 按"筛选通过 + 读取成功 + 已抽取"
 * 判定合格的 Writer 输入来源，与实际 Writer 输入对比，暴露读取失败却经 snippet
 * 回退进入报告的来源。
 *
 * 注意（Spec §12 Phase 2A）：这只是**读取资格差异诊断**，不是 Ledger primary
 * 验收结果——真正的 would-be Evidence Pack/citations 需要 Ledger 按自身准入与
 * passage 选择规则独立产出（primary 验收工作的一部分），在此之前第二交付门
 * 保持未达成。
 */
export function buildReadingEligibilityDiff({ entries, citations = [] }) {
  const wouldInclude = entries
    .filter((item) => item.screeningStatus === 'accepted'
      && item.readingStatus === 'succeeded'
      && item.extractionStatus === 'extracted')
    .map((item) => item.citationId || item.evidenceId);
  const actual = (Array.isArray(citations) ? citations : []).map((item) => item.id);

  const wouldSet = new Set(wouldInclude);
  const actualSet = new Set(actual);
  return {
    diagnostic: 'reading_eligibility',
    ledgerWouldIncludeCitationIds: wouldInclude,
    actualWriterCitationIds: actual,
    ledgerIncludedButWriterMissed: wouldInclude.filter((id) => !actualSet.has(id)),
    ledgerExcludedButWriterUsed: actual.filter((id) => !wouldSet.has(id)),
    counts: {
      ledger: wouldInclude.length,
      actual: actual.length,
      ledgerIncludedButWriterMissed: wouldInclude.filter((id) => !actualSet.has(id)).length,
      ledgerExcludedButWriterUsed: actual.filter((id) => !wouldSet.has(id)).length
    }
  };
}
