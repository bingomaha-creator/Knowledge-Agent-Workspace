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
