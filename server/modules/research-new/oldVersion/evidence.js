import { createHash } from 'node:crypto';

function normalizedText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

export function passageHash(value) {
  return createHash('sha256').update(normalizedText(value)).digest('hex');
}

function splitPassages(content) {
  const paragraphs = String(content || '')
    .split(/\n{2,}|(?<=[。！？.!?])\s+/u)
    .map(normalizedText)
    .filter((value) => value.length >= 24);
  const passages = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 1 > 1000) {
      passages.push(current);
      current = '';
    }
    current = current ? `${current}\n${paragraph}` : paragraph.slice(0, 1000);
    if (passages.length >= 79) break;
  }
  if (current && passages.length < 80) passages.push(current);
  return passages;
}

function focusTokens(value) {
  return [...new Set(String(value || '').normalize('NFKC').toLowerCase()
    .match(/[\p{L}\p{N}_-]{3,}/gu) || [])]
    .filter((token) => !new Set(['https', 'site', 'official', 'source', 'changes']).has(token))
    .slice(0, 80);
}

function passageScore(passage, focus) {
  const normalized = normalizedText(passage).normalize('NFKC').toLowerCase();
  return focus.reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0);
}

export function buildPassageCandidates(documents, track = {}) {
  return documents.flatMap((source) => {
    const focus = focusTokens([
      track.question,
      ...(track.evidenceRequirements || []),
      source.query,
      source.title,
      source.snippet
    ].filter(Boolean).join(' '));
    return splitPassages(source.content)
      .map((passage, index) => ({ passage, index, score: passageScore(passage, focus) }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 3)
      .map(({ passage, index }) => ({
    id: `passage-${createHash('sha256').update(`${source.id}|${index}|${passage}`).digest('hex').slice(0, 18)}`,
    sourceId: source.id,
    trackId: source.trackId,
    origin: source.origin,
    contentLevel: source.contentLevel,
    passage
      }));
  });
}

export function materializeEvidence({ track, candidates, selections }) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const roles = new Set(['primary_candidate', 'secondary', 'unknown']);
  const seen = new Set();
  const output = [];
  for (const selection of Array.isArray(selections) ? selections : []) {
    const candidate = byId.get(selection?.passageId);
    if (!candidate || seen.has(candidate.id) || output.length >= 8) continue;
    const supports = Array.isArray(selection.supports)
      ? selection.supports.map(normalizedText).filter(Boolean).slice(0, 5)
      : [];
    const contradicts = Array.isArray(selection.contradicts)
      ? selection.contradicts.map(normalizedText).filter(Boolean).slice(0, 5)
      : [];
    if (!supports.length && !contradicts.length) continue;
    seen.add(candidate.id);
    output.push({
      id: '',
      trackId: track.id,
      sourceId: candidate.sourceId,
      origin: candidate.origin,
      passage: candidate.passage,
      passageHash: passageHash(candidate.passage),
      supports,
      contradicts,
      relevance: Math.max(0, Math.min(1, Number(selection.relevance) || 0)),
      sourceRole: roles.has(selection.sourceRole) ? selection.sourceRole : 'unknown',
      contentLevel: candidate.contentLevel
    });
  }
  return output;
}

export function assessTracks(tracks, evidence, sources = []) {
  return tracks.map((track) => {
    const items = evidence.filter((item) => item.trackId === track.id);
    const trackSources = sources.filter((source) => source.trackId === track.id);
    const readableSourceCount = trackSources.filter((source) => source.content).length;
    const hasReadable = items.some((item) => item.contentLevel !== 'snippet');
    return {
      ...track,
      status: items.length === 0 ? 'unresolved' : hasReadable ? 'answered' : 'partial',
      gaps: items.length === 0
        ? [readableSourceCount > 0
            ? `已读取 ${readableSourceCount} 个来源，但没有段落通过 Evidence 选择`
            : '未检索到可供评估的来源']
        : hasReadable
          ? []
          : ['当前仅有搜索摘要，未读取到正文']
    };
  });
}
