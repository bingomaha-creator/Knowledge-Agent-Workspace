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
export function computeEvidenceIdentity({ runId, sourceChannel, canonicalSourceId, content }) {
  const normalized = normalizeContentForHash(content);
  const contentHash = createHash('sha256').update(normalized).digest('hex');
  const evidenceId = `ev_${createHash('sha256')
    .update([runId, sourceChannel, canonicalSourceId, contentHash].join('|'))
    .digest('hex')
    .slice(0, 32)}`;
  return { evidenceId, contentHash, content: normalized };
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
 * @param {object} input
 * @param {string} input.runId
 * @param {Array} input.acceptedSources 通过相关性筛选的来源（artifacts.sources）
 * @param {Array} [input.excludedSources] 被筛选排除的来源（含 reason）
 * @param {Array} [input.selectionExcluded] 因配额未进入 Writer 的已接受来源
 * @param {Array} [input.documents] Reader 成功读取的文档（sourceId/content/readerKind）
 * @param {Array} [input.readingFailures] Reader 失败（sourceId/code/message/retryable）
 * @param {Array} [input.evidence] 实际入选 Evidence Pack 的 passage
 * @param {Array} [input.citations] 实际生成的结构化 citation
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
    const bound = document
      ? boundArtifactContent(document.content)
      : { content: '', byteSize: 0, truncated: false };
    const { evidenceId, contentHash } = computeEvidenceIdentity({
      runId,
      sourceChannel: source.kind,
      canonicalSourceId: source.url || source.id,
      content: bound.content
    });

    // reading 维度：Reader 实际结果；未被选中读取的来源保持 pending。
    const readingStatus = document
      ? 'succeeded'
      : failure
        ? 'failed'
        : 'pending';
    const readingReason = document
      ? ''
      : (failure ? `${failure.code}: ${failure.message}` : '');

    // extraction 维度：入选 Evidence Pack 的 passage 数；配额排除即 not_selected。
    const passageCount = evidenceBySource.get(source.id) || 0;
    const quotaExcluded = selectionExcludedById.get(source.id);
    const extractionStatus = passageCount > 0
      ? 'extracted'
      : (quotaExcluded ? `not_selected:${quotaExcluded.reason || 'quota'}` : 'not_selected');

    // citation 维度：citation id 由证据装配的确定性规则（kind-sourceId）给出。
    const expectedCitationId = citationIdFor(source);
    const cited = citationById.has(expectedCitationId);

    // provenance 转换：只有经受控 Reader/Adapter 成功读取的 web 来源才升级为
    // verified_primary；筛选拒绝与读取失败都保持原 provenance。
    const provenanceBefore = String(source.provenance || 'unknown');
    const upgraded = readingStatus === 'succeeded'
      && source.kind === 'web'
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

    // 成功读取的内容进入原文 artifact（受字节上限约束，规范化文本）。
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
        truncated: bound.truncated,
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
      truncated: bound.truncated,
      artifactId,
      screeningStatus,
      screeningReason: screeningReason || '',
      readingStatus,
      readingReason,
      extractionStatus,
      citationStatus: cited ? 'cited' : 'not_cited',
      citationId: cited ? expectedCitationId : ''
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
 * would-be Writer 输入差异（shadow 模式核心产物）：Ledger 认为"筛选通过 + 读取
 * 成功 + 已抽取"的来源才是合格 Writer 输入；与实际 Writer 输入（Evidence Pack）
 * 对比，暴露读取失败却经 snippet 回退进入报告的来源等差异。
 */
export function buildWriterInputDiff({ entries, citations = [] }) {
  const wouldInclude = entries
    .filter((item) => item.screeningStatus === 'accepted'
      && item.readingStatus === 'succeeded'
      && item.extractionStatus === 'extracted')
    .map((item) => item.citationId || item.evidenceId);
  const actual = (Array.isArray(citations) ? citations : []).map((item) => item.id);

  const wouldSet = new Set(wouldInclude);
  const actualSet = new Set(actual);
  return {
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
