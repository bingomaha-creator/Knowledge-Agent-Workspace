export const RESEARCH_NEW_STATUSES = Object.freeze([
  'queued', 'running', 'completed', 'failed', 'cancelled'
]);

export const RESEARCH_NEW_STAGES = Object.freeze([
  'planning', 'researching', 'assessing', 'reporting', 'verifying', 'completed'
]);

export const RESEARCH_NEW_STAGE_PROGRESS = Object.freeze({
  planning: 5,
  researching: 25,
  assessing: 60,
  reporting: 70,
  verifying: 90,
  completed: 100
});

export const DEFAULT_RESEARCH_NEW_BUDGET = Object.freeze({
  maxRounds: 2,
  maxSearchCalls: 8,
  maxSourcesRead: 10,
  maxWallTimeMs: 300_000,
  maxWriterAttempts: 2,
  roundsUsed: 0,
  searchCalls: 0,
  sourcesRead: 0,
  writerAttempts: 0
});

export function normalizeResearchNewMode(value) {
  return value === 'hybrid' ? 'hybrid' : 'web';
}

export function normalizeKnowledgeBaseIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((id) => typeof id === 'string')
    .map((id) => id.trim().slice(0, 160))
    .filter(Boolean))].slice(0, 20);
}

export function createResearchNewError(code, message, status = 500, details = '') {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

// ponytail: only heading prefixes and whitespace loss are supported, not fuzzy text matching.
export function adjacentSection(document, passage) {
  // The Knowledge chunker prepends ancestor headings that are not contiguous in the document.
  passage = String(passage || '').replace(/^(?:#{1,6}[ \t]+[^\n]*\r?\n[ \t\r\n]*)+/, '').trim();
  if (!passage || passage.length < 20) return null;
  const content = String(document.content || '');
  // GraphRAG removes whitespace. Map identical non-whitespace characters back to original offsets.
  const positions = [...content.matchAll(/\S/g)].map((match) => match.index);
  const normalized = positions.map((index) => content[index]).join('');
  const anchor = passage.replace(/\s/g, '');
  const index = normalized.indexOf(anchor);
  if (index < 0 || normalized.indexOf(anchor, index + 1) !== -1) return null;
  const start = positions[index];
  const end = positions[index + anchor.length - 1] + 1;
  const headings = [...content.matchAll(/^#{1,3}\s+.+$/gm)].map((match) => match.index);
  const sectionStart = headings.filter((index) => index <= start).at(-1) ?? 0;
  const sectionEnd = headings.find((index) => index >= end) ?? content.length;
  const offset = Math.max(sectionStart, start - 800);
  const until = Math.min(sectionEnd, end + 800, offset + 3200);
  if (until < end || (offset === start && until === end)) return null;
  return { id: `${document.id}:context:${offset}:${until}`, documentId: document.id,
    knowledgeBaseId: document.knowledgeBaseId, title: document.name,
    snippet: content.slice(offset, until), offset, endOffset: until };
}
