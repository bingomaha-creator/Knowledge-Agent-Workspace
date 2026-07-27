import { parseBugFacts } from './bug-fact-parser.js';

export const BUG_EVIDENCE_TYPES = Object.freeze([
  'error',
  'network',
  'test_failure',
  'code',
  'environment',
  'reproduction',
  'verification',
  'note'
]);

export const BUG_INVESTIGATION_STATUSES = Object.freeze([
  'draft',
  'converted',
  'closed'
]);

const EVIDENCE_TYPE_SET = new Set(BUG_EVIDENCE_TYPES);
const MAX_EVIDENCE_LENGTH = 24_000;
const MAX_TITLE_LENGTH = 160;

function createDomainError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizedText(value, maxLength, field, { required = false } = {}) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw createDomainError('BUG_INVESTIGATION_INVALID_FIELD', `${field} 必须是字符串`, 400);
  }
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (required && !text) {
    throw createDomainError('BUG_INVESTIGATION_FIELD_REQUIRED', `${field} 不能为空`);
  }
  if (text.length > maxLength) {
    throw createDomainError(
      'BUG_INVESTIGATION_FIELD_TOO_LONG',
      `${field} 不能超过 ${maxLength} 个字符`
    );
  }
  return text;
}

function replaceSecrets(text, pattern, kind, replacement, redactions) {
  let count = 0;
  const output = text.replace(pattern, (...args) => {
    count += 1;
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  });
  if (count) redactions.push({ kind, count });
  return output;
}

/**
 * 只做高确定性的轻量脱敏。低确定性个人信息不在这里猜测，避免破坏诊断证据。
 * 调用方只允许持久化 returned content，原始值不得进入 Store 或模型。
 */
export function sanitizeBugEvidence(value) {
  const source = normalizedText(
    value,
    MAX_EVIDENCE_LENGTH,
    'evidence.content',
    { required: true }
  );
  const redactions = [];
  let content = source;

  content = replaceSecrets(
    content,
    /(\bauthorization\s*[:=]\s*(?:bearer\s+)?)([^\s,;]+)/gi,
    'authorization',
    (_match, prefix) => `${prefix}[REDACTED]`,
    redactions
  );
  content = replaceSecrets(
    content,
    /(\b(?:set-)?cookie\s*[:=]\s*)([^\n]+)/gi,
    'cookie',
    (_match, prefix) => `${prefix}[REDACTED]`,
    redactions
  );
  content = replaceSecrets(
    content,
    /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*["']?)([^\s"',;]+)/gi,
    'credential',
    (_match, prefix) => `${prefix}[REDACTED]`,
    redactions
  );
  content = replaceSecrets(
    content,
    /([?&](?:access_token|api_key|token|secret)=)([^&\s]+)/gi,
    'query_credential',
    (_match, prefix) => `${prefix}[REDACTED]`,
    redactions
  );
  content = replaceSecrets(
    content,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
    'jwt',
    '[REDACTED_JWT]',
    redactions
  );

  return { content, redactions };
}

export function normalizeBugEvidenceInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createDomainError('BUG_INVESTIGATION_INVALID_EVIDENCE', 'evidence 必须是对象', 400);
  }
  const type = normalizedText(input.type || 'error', 40, 'evidence.type', { required: true });
  if (!EVIDENCE_TYPE_SET.has(type)) {
    throw createDomainError(
      'BUG_INVESTIGATION_INVALID_EVIDENCE_TYPE',
      `不支持的证据类型：${type}`
    );
  }
  const sanitized = sanitizeBugEvidence(input.content);
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  return {
    type,
    content: sanitized.content,
    redactions: sanitized.redactions,
    metadata: {
      fileName: normalizedText(metadata.fileName, 500, 'evidence.metadata.fileName'),
      language: normalizedText(metadata.language, 80, 'evidence.metadata.language'),
      lineStart: Number.isInteger(metadata.lineStart) && metadata.lineStart > 0
        ? metadata.lineStart
        : null
    }
  };
}

/**
 * 解析器只声明可以从文本直接观察到的事实；不推断根因。
 */
export function extractBugFacts(evidence = []) {
  return parseBugFacts(evidence);
}

/**
 * 面向用户的调查摘要只由确定性事实生成。模型的根因叙述留在 hypothesis，
 * 不允许越过这条 seam 混入“已确认事实”。
 */
export function buildBugFactSummary(facts, evidence = []) {
  const identifiers = [
    ...(facts.errorTypes || []),
    ...(facts.errorCodes || [])
  ];
  const fallbackSignature = facts.errorSignatures?.[0];
  const locations = (facts.locations || []).slice(0, 3);
  const technicalContext = [
    ...(facts.languages || []),
    ...(facts.frameworks || []),
    ...(facts.environments || [])
  ];
  const parts = [];

  if (identifiers.length) {
    parts.push(`已观察到错误标识：${identifiers.slice(0, 6).join('、')}。`);
  } else if (fallbackSignature) {
    parts.push(`已观察到错误标识：${fallbackSignature}。`);
  } else {
    parts.push('当前现场尚未提取出稳定错误标识。');
  }
  if (locations.length) {
    parts.push(`已定位到：${locations.join('、')}。`);
  }
  if (technicalContext.length) {
    parts.push(`技术上下文：${[...new Set(technicalContext)].slice(0, 8).join('、')}。`);
  }
  parts.push(`当前保存了 ${evidence.length} 项脱敏现场证据。`);
  parts.push(
    (facts.verificationNotes || []).length
      ? '已记录人工验证结果，但根因仍需由你确认。'
      : '当前内容只代表已观察事实，根因仍待验证。'
  );
  return parts.join('');
}

export function evaluateEvidenceQuality(facts, evidence = []) {
  const hasError = facts.errorSignatures.length > 0 || facts.errorTypes.length > 0;
  const hasLocation = facts.files.length > 0;
  const hasReproduction = facts.reproductionSteps.length > 0;
  const hasCode = evidence.some((item) => item.type === 'code');
  const hasNetwork = evidence.some((item) => item.type === 'network');
  const hasEnvironment = (
    facts.frameworks.length > 0
    || (facts.languages || []).length > 0
    || facts.environments.length > 0
    || evidence.some((item) => item.type === 'environment')
  );
  const score = (
    (hasError ? 2 : 0)
    + (hasLocation ? 1 : 0)
    + (hasReproduction ? 2 : 0)
    + (hasCode ? 1 : 0)
    + (hasNetwork ? 1 : 0)
    + (hasEnvironment ? 1 : 0)
  );

  const missingEvidence = [];
  if (!hasError) missingEvidence.push('请补充完整 Error、Stack Trace 或测试失败输出。');
  if (!hasReproduction) missingEvidence.push('请补充触发问题的操作与可执行复现步骤。');
  if (!hasEnvironment) missingEvidence.push('请补充框架、运行环境或相关代码上下文。');
  if (!hasLocation && !hasCode) {
    missingEvidence.push('如需定位实现，请补充堆栈中的文件位置或相关代码片段。');
  }

  return {
    quality: hasError && score >= 4 ? 'sufficient' : score >= 2 ? 'limited' : 'insufficient',
    score,
    signals: {
      hasError,
      hasLocation,
      hasReproduction,
      hasCode,
      hasNetwork,
      hasEnvironment
    },
    missingEvidence
  };
}

export function evaluateCandidateReadiness(facts, evidence = []) {
  const checks = [
    {
      key: 'symptom',
      label: '原始错误或明确现象',
      passed: evidence.some((item) => ['error', 'network', 'test_failure', 'note'].includes(item.type))
    },
    {
      key: 'context',
      label: '技术上下文',
      passed: facts.frameworks.length > 0
        || (facts.languages || []).length > 0
        || facts.environments.length > 0
        || evidence.some((item) => item.type === 'code')
    },
    {
      key: 'signature_or_reproduction',
      label: 'Error Signature 或复现步骤',
      passed: facts.errorSignatures.length > 0 || facts.reproductionSteps.length > 0
    },
    {
      key: 'source',
      label: '来源记录',
      passed: evidence.length > 0
    }
  ];
  return {
    ready: checks.every((check) => check.passed),
    checks
  };
}

export function deriveInvestigationTitle(facts, evidence, requestedTitle = '') {
  const title = normalizedText(requestedTitle, MAX_TITLE_LENGTH, 'title');
  if (title) return title;
  const firstMessage = facts.messages[0] || facts.errorSignatures[0];
  if (firstMessage) return firstMessage.slice(0, MAX_TITLE_LENGTH);
  const firstLine = evidence[0]?.content?.split('\n').find((line) => line.trim())?.trim();
  return (firstLine || '未命名 Bug 调查').slice(0, MAX_TITLE_LENGTH);
}

export function buildCandidateDraft(investigation) {
  const primaryEvidence = investigation.evidence
    .filter((item) => ['error', 'network', 'test_failure', 'note'].includes(item.type))
    .map((item) => item.content)
    .join('\n\n');
  const codeEvidence = investigation.evidence.filter((item) => item.type === 'code');
  const verification = investigation.evidence
    .filter((item) => item.type === 'verification')
    .map((item) => item.content)
    .join('\n\n');
  return {
    sourceProjectRef: investigation.projectRef,
    title: investigation.title,
    symptom: primaryEvidence.slice(0, 8_000),
    errorSignatures: investigation.facts.errorSignatures,
    reproductionSteps: investigation.facts.reproductionSteps,
    context: {
      language: codeEvidence[0]?.metadata?.language || investigation.facts.languages?.[0] || '',
      framework: investigation.facts.frameworks[0] || '',
      versions: [],
      module: investigation.facts.files[0] || '',
      environment: investigation.facts.environments.join(', ')
    },
    resolutionType: 'root_cause_fix',
    // Agent 假设永远不会在转换时自动提升为已确认根因。
    rootCause: null,
    fix: '',
    workaroundRisks: [],
    applicability: [],
    verification,
    tags: ['investigation'],
    sourceRefs: [`investigation:${investigation.id}`]
  };
}
