import { createHash } from 'node:crypto';

const REQUIRED_KINDS = new Set(['system_rule', 'current_user']);
const DEFAULT_PROFILE = Object.freeze({
  id: 'default-32k',
  contextWindowTokens: 32_768,
  outputReserveTokens: 4_096,
  safetyReserveTokens: 2_048
});

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback;
}

function normalizeProfile(input = {}) {
  const contextWindowTokens = positiveInteger(
    input.contextWindowTokens,
    DEFAULT_PROFILE.contextWindowTokens
  );
  const outputReserveTokens = positiveInteger(
    input.outputReserveTokens,
    DEFAULT_PROFILE.outputReserveTokens
  );
  const safetyReserveTokens = positiveInteger(
    input.safetyReserveTokens,
    DEFAULT_PROFILE.safetyReserveTokens
  );
  return {
    id: typeof input.id === 'string' && input.id.trim()
      ? input.id.trim().slice(0, 80)
      : DEFAULT_PROFILE.id,
    contextWindowTokens,
    outputReserveTokens,
    safetyReserveTokens,
    inputBudgetTokens: Math.max(
      0,
      contextWindowTokens - outputReserveTokens - safetyReserveTokens
    )
  };
}

function estimateTextTokens(value) {
  if (value === undefined || value === null || value === '') return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const cjkCount = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  const nonCjkCount = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\s]/gu, '').length;
  return cjkCount + Math.ceil(nonCjkCount / 4);
}

function interleave(groups) {
  const output = [];
  const longest = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < longest; index += 1) {
    for (const group of groups) {
      if (group[index]) output.push(group[index]);
    }
  }
  return output;
}

function scheduleOptionalCandidates(candidates) {
  const tools = candidates
    .filter((candidate) => candidate.kind === 'tool_exchange')
    .toReversed();
  const conversation = candidates.filter((candidate) => candidate.kind === 'conversation_turn');
  const recentConversation = conversation.slice(-2).toReversed();
  const olderConversation = conversation.slice(0, -2).toReversed();
  const evidence = interleave([
    candidates.filter((candidate) => candidate.kind === 'knowledge_chunk'),
    candidates.filter((candidate) => candidate.kind === 'memory'),
    candidates.filter((candidate) => candidate.kind === 'research_evidence')
  ]);
  const fewShot = candidates.filter((candidate) => candidate.kind === 'few_shot');
  const known = new Set([
    ...tools,
    ...conversation,
    ...evidence,
    ...fewShot
  ]);
  const remaining = candidates.filter((candidate) => !known.has(candidate));
  return [
    ...tools,
    ...recentConversation,
    ...evidence,
    ...olderConversation,
    ...fewShot,
    ...remaining
  ];
}

function includedReason(kind) {
  if (kind === 'tool_exchange') return 'active_tool_chain';
  if (kind === 'conversation_turn') return 'conversation_continuity';
  return 'relevant';
}

const EXCLUSION_REASONS = new Set([
  'out_of_scope',
  'duplicate',
  'over_budget',
  'stale',
  'superseded',
  'invalid',
  'low_relevance'
]);

function exclusionReason(candidate) {
  return EXCLUSION_REASONS.has(candidate.exclusionReason)
    ? candidate.exclusionReason
    : 'out_of_scope';
}

function candidateFingerprint(candidate) {
  if (typeof candidate.fingerprint === 'string' && candidate.fingerprint) {
    return candidate.fingerprint;
  }
  const sourceId = candidate.sourceRef?.id || candidate.id;
  const parentId = candidate.sourceRef?.parentId || '';
  return `${candidate.kind}:${parentId}:${sourceId}`;
}

function safeSourceRef(candidate) {
  const id = typeof candidate?.sourceRef?.id === 'string' && candidate.sourceRef.id
    ? candidate.sourceRef.id
    : candidate.id;
  const parentId = typeof candidate?.sourceRef?.parentId === 'string'
    ? candidate.sourceRef.parentId
    : '';
  return {
    id: String(id || '').slice(0, 200),
    ...(parentId ? { parentId: parentId.slice(0, 200) } : {})
  };
}

function safeMessage(message) {
  const safe = {
    role: ['system', 'user', 'assistant', 'tool'].includes(message?.role)
      ? message.role
      : 'system',
    content: typeof message?.content === 'string' ? message.content : ''
  };
  if (Array.isArray(message?.tool_calls)) safe.tool_calls = message.tool_calls;
  if (typeof message?.tool_call_id === 'string') safe.tool_call_id = message.tool_call_id;
  if (typeof message?.name === 'string') safe.name = message.name;
  return safe;
}

const OUTPUT_KIND_ORDER = new Map([
  ['system_rule', 0],
  ['knowledge_chunk', 1],
  ['memory', 1],
  ['research_evidence', 1],
  ['few_shot', 2],
  ['conversation_turn', 3],
  ['current_user', 4],
  ['tool_exchange', 5]
]);

function outputOrder(candidate) {
  return OUTPUT_KIND_ORDER.get(candidate.kind) ?? 6;
}

function estimateCandidateTokens(candidate) {
  return candidate.messages.reduce((total, message) => (
    total
    + 4
    + estimateTextTokens(message.content)
    + estimateTextTokens(message.tool_calls)
    + estimateTextTokens(message.tool_call_id)
  ), 0);
}

function createBudgetError(requiredTokens, inputBudgetTokens) {
  const error = new Error('必选上下文超过当前模型的输入预算。');
  error.code = 'CONTEXT_BUDGET_EXCEEDED';
  error.details = `required=${requiredTokens}, budget=${inputBudgetTokens}`;
  return error;
}

function summarize(decisions) {
  const includedByKind = {};
  const excludedByReason = {};
  let includedCount = 0;
  let excludedCount = 0;
  for (const decision of decisions) {
    if (decision.decision === 'included') {
      includedCount += 1;
      includedByKind[decision.kind] = (includedByKind[decision.kind] || 0) + 1;
    } else {
      excludedCount += 1;
      excludedByReason[decision.reason] = (excludedByReason[decision.reason] || 0) + 1;
    }
  }
  return { includedCount, excludedCount, includedByKind, excludedByReason };
}

function buildIdFor(value) {
  return `ctx-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`;
}

/**
 * 把各领域 Module 已经产生的候选装配成一次模型调用的消息与审计清单。
 * 本 Interface 不执行检索，也不持久化内容；调用者负责提供候选并保存返回的 Manifest。
 */
export function buildContext({ purpose, profile: profileInput, candidates = [] }) {
  const profile = normalizeProfile(profileInput);
  const normalized = candidates.map((candidate, inputIndex) => {
    const messages = Array.isArray(candidate?.messages)
      ? candidate.messages.map(safeMessage)
      : [];
    return {
      ...candidate,
      inputIndex,
      sourceRef: safeSourceRef(candidate),
      messages,
      estimatedTokens: estimateCandidateTokens({ messages })
    };
  });
  const required = normalized.filter((candidate) => REQUIRED_KINDS.has(candidate.kind));
  const requiredTokens = required.reduce((total, candidate) => total + candidate.estimatedTokens, 0);
  if (requiredTokens > profile.inputBudgetTokens) {
    throw createBudgetError(requiredTokens, profile.inputBudgetTokens);
  }

  const decisions = required.map((candidate) => ({
    candidateId: candidate.id,
    kind: candidate.kind,
    sourceRef: candidate.sourceRef,
    estimatedTokens: candidate.estimatedTokens,
    decision: 'included',
    reason: 'required'
  }));
  const selected = [...required];
  let estimatedInputTokens = requiredTokens;
  const optional = normalized.filter((candidate) => !REQUIRED_KINDS.has(candidate.kind));
  const seenFingerprints = new Set(required.map(candidateFingerprint));
  for (const candidate of scheduleOptionalCandidates(optional)) {
    if (candidate.eligible === false) {
      decisions.push({
        candidateId: candidate.id,
        kind: candidate.kind,
        sourceRef: candidate.sourceRef,
        estimatedTokens: candidate.estimatedTokens,
        decision: 'excluded',
        reason: exclusionReason(candidate),
        inputIndex: candidate.inputIndex
      });
      continue;
    }
    const fingerprint = candidateFingerprint(candidate);
    if (seenFingerprints.has(fingerprint)) {
      decisions.push({
        candidateId: candidate.id,
        kind: candidate.kind,
        sourceRef: candidate.sourceRef,
        estimatedTokens: candidate.estimatedTokens,
        decision: 'excluded',
        reason: 'duplicate',
        inputIndex: candidate.inputIndex
      });
      continue;
    }
    seenFingerprints.add(fingerprint);
    const fits = estimatedInputTokens + candidate.estimatedTokens <= profile.inputBudgetTokens;
    decisions.push({
      candidateId: candidate.id,
      kind: candidate.kind,
      sourceRef: candidate.sourceRef,
      estimatedTokens: candidate.estimatedTokens,
      decision: fits ? 'included' : 'excluded',
      reason: fits ? includedReason(candidate.kind) : 'over_budget',
      inputIndex: candidate.inputIndex
    });
    if (fits) {
      selected.push(candidate);
      estimatedInputTokens += candidate.estimatedTokens;
    }
  }
  const inputIndexes = new Map(normalized.map((candidate) => [candidate.id, candidate.inputIndex]));
  decisions.sort((left, right) => (
    (left.inputIndex ?? inputIndexes.get(left.candidateId) ?? 0)
    - (right.inputIndex ?? inputIndexes.get(right.candidateId) ?? 0)
  ));
  for (const decision of decisions) delete decision.inputIndex;
  const manifestBase = {
    schemaVersion: 1,
    purpose,
    policyVersion: 'context-policy-v1',
    estimatorVersion: 'cjk-conservative-v1',
    profile,
    estimatedInputTokens,
    decisions,
    summary: summarize(decisions),
    warnings: []
  };

  return {
    messages: selected
      .toSorted((left, right) => (
        outputOrder(left) - outputOrder(right)
        || left.inputIndex - right.inputIndex
      ))
      .flatMap((candidate) => candidate.messages),
    manifest: {
      ...manifestBase,
      buildId: buildIdFor(manifestBase)
    }
  };
}
