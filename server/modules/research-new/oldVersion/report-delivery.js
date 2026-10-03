import { createResearchNewError } from '../domain.js';

const CLAIM_LABELS = Object.freeze({
  workspace_fact: '项目事实',
  external_practice: '外部实践',
  recommendation: '建议'
});
const UNSUPPORTED_ABSENCE_PATTERN = /结论\s*[：:]\s*(?:未定义|不存在|缺失)|(?:文档|架构|规范|要求|条款|定义|信息|内容).{0,16}(?:完全|明确)?(?:未提及|未出现|未定义|不存在|缺失|零提及)|完全未规定|完全缺失|零提及/u;
const INLINE_INJECTION_PATTERN = /[\r\n]|https?:\/\/|\[[^\]]+\]/u;
const LIMITATION_BOUNDARY_PATTERN = /^(?:本轮未检索到|当前证据未覆盖|当前证据存在冲突)/u;

function isPlainText(value) {
  const text = String(value || '').trim();
  return Boolean(text) && !INLINE_INJECTION_PATTERN.test(text);
}

function escapeInlineMarkdown(value) {
  return String(value || '').trim().replace(/([\\`*_[\]<>#|])/gu, '\\$1');
}

function citationMarkers(ids) {
  return ids.map((id) => `[${id}]`).join('');
}

function validateDraft(draft, { tracks, evidence, mode }) {
  const failures = [];
  const trackIds = new Set(tracks.map((track) => track.id));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const sections = Array.isArray(draft?.sections) ? draft.sections : [];
  const sectionTrackIds = new Set();
  const claimTrackIds = new Set();
  const limitations = Array.isArray(draft?.limitations) ? draft.limitations : [];
  const limitationTrackIds = new Set();

  for (const limitation of limitations) {
    const trackId = String(limitation?.trackId || '');
    const text = String(limitation?.text || '').trim();
    if (!trackIds.has(trackId) || !isPlainText(text)) {
      failures.push('limitation_shape');
      continue;
    }
    if (!LIMITATION_BOUNDARY_PATTERN.test(text)) failures.push('limitation_evidence_boundary');
    limitationTrackIds.add(trackId);
  }

  for (const section of sections) {
    const trackId = String(section?.trackId || '');
    if (!trackIds.has(trackId) || sectionTrackIds.has(trackId)) {
      failures.push('section_track');
    }
    sectionTrackIds.add(trackId);
    const claims = Array.isArray(section?.claims) ? section.claims : [];
    if (claims.length) claimTrackIds.add(trackId);
    for (const claim of claims) {
      const type = String(claim?.type || '');
      const ids = Array.isArray(claim?.evidenceIds) ? claim.evidenceIds.map(String) : [];
      const origins = ids.map((id) => evidenceById.get(id)?.origin);
      if (!CLAIM_LABELS[type] || !String(claim?.text || '').trim() || !ids.length
        || origins.some((origin) => !origin)) {
        failures.push('claim_shape');
        continue;
      }
      if (!isPlainText(claim.text)) failures.push('claim_text_format');
      if (ids.some((id) => evidenceById.get(id)?.trackId !== trackId)) {
        failures.push('claim_track_membership');
      }
      if (UNSUPPORTED_ABSENCE_PATTERN.test(String(claim.text))) {
        failures.push('unsupported_absence_claim');
      }
      if (type === 'workspace_fact' && origins.some((origin) => origin !== 'workspace')) {
        failures.push('workspace_claim_origin');
      }
      if (type === 'external_practice' && origins.some((origin) => origin !== 'web')) {
        failures.push('external_claim_origin');
      }
      if (type === 'recommendation') {
        const requiredOrigins = mode === 'hybrid' ? ['workspace', 'web'] : ['web'];
        if (requiredOrigins.some((origin) => !origins.includes(origin))) {
          failures.push('recommendation_origin');
        }
      }
    }
  }

  if (tracks.some((track) => track.status === 'answered' && !sectionTrackIds.has(track.id))) {
    failures.push('answered_track_section');
  }
  if (tracks.some((track) => track.status !== 'unresolved'
    && evidence.some((item) => item.trackId === track.id)
    && !claimTrackIds.has(track.id))) {
    failures.push('track_claim');
  }
  if (tracks.some((track) => track.status !== 'answered' && !limitationTrackIds.has(track.id))) {
    failures.push('unresolved_track_limitation');
  }
  return [...new Set(failures)];
}

function renderDraft(draft, { brief, tracks, sources, evidence }) {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const citedIds = [];
  const lines = [`# ${escapeInlineMarkdown(brief?.objective || '研究报告')}`, ''];

  const sections = Array.isArray(draft?.sections) ? draft.sections : [];
  for (const section of sections.filter((item) => Array.isArray(item?.claims) && item.claims.length)) {
    const track = tracks.find((item) => item.id === section.trackId);
    lines.push(`## ${escapeInlineMarkdown(track?.question || '研究结论')}`, '');
    for (const claim of section.claims) {
      const ids = claim.evidenceIds.map(String);
      citedIds.push(...ids);
      lines.push(`- ${CLAIM_LABELS[claim.type]}：${escapeInlineMarkdown(claim.text)} ${citationMarkers(ids)}`);
    }
    lines.push('');
  }

  lines.push('## 局限与未解决问题', '');
  const limitations = Array.isArray(draft.limitations) ? draft.limitations : [];
  if (limitations.length) {
    limitations.forEach((item) => lines.push(`- ${escapeInlineMarkdown(item?.text)}`));
  } else {
    lines.push('- 本轮没有额外的未解决问题。');
  }

  lines.push('', '## 来源', '');
  const uniqueIds = [...new Set(citedIds)];
  uniqueIds.forEach((id) => {
    const evidenceItem = evidenceById.get(id);
    const source = sourceById.get(evidenceItem?.sourceId);
    const url = source?.url ? ` — ${source.url}` : '';
    lines.push(`[${id}] ${escapeInlineMarkdown(source?.title || '未命名来源')}${url}`);
  });
  return lines.join('\n');
}

export async function createVerifiedReport({
  brief,
  tracks,
  sources,
  evidence,
  mode,
  maxAttempts = 2,
  writeDraft,
  onAttempt,
  currentTime,
  signal
}) {
  let failures = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await onAttempt?.(attempt);
    const draft = await writeDraft({
      brief,
      tracks,
      sources,
      evidence,
      mode,
      currentTime,
      previousFailure: failures,
      signal
    });
    failures = validateDraft(draft, { tracks, evidence, mode });
    if (!failures.length) {
      return {
        attempts: attempt,
        draft,
        report: renderDraft(draft, { brief, tracks, sources, evidence }),
        verification: { valid: true, failures: [] }
      };
    }
  }
  throw createResearchNewError(
    'RESEARCH_NEW_REPORT_INVALID',
    `结构化报告验证失败：${failures.join(', ') || 'unknown'}`,
    502,
    failures.join(', ')
  );
}
