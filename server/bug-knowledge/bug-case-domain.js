import { createHash } from 'node:crypto';

export const BUG_CASE_RESOLUTION_TYPES = Object.freeze([
  'root_cause_fix',
  'verified_workaround'
]);

export const BUG_CASE_REVIEW_STATUSES = Object.freeze([
  'candidate',
  'confirmed',
  'rejected'
]);

// 这是唯一允许进入 documents.metadata_json 的业务字段集合。显式白名单很重要：
// API/MCP 即使多传 reviewStatus、reviewedBy 等字段，也不能借由 JSON 元数据绕过审核状态机。
export const BUG_CASE_CONTENT_FIELDS = Object.freeze([
  'title',
  'symptom',
  'errorSignatures',
  'reproductionSteps',
  'context',
  'resolutionType',
  'rootCause',
  'fix',
  'workaroundRisks',
  'applicability',
  'verification',
  'tags',
  'sourceRefs'
]);

const CONTENT_FIELD_SET = new Set(BUG_CASE_CONTENT_FIELDS);
const RESOLUTION_TYPE_SET = new Set(BUG_CASE_RESOLUTION_TYPES);
const CONTEXT_FIELDS = new Set([
  'language',
  'framework',
  'versions',
  'module',
  'environment'
]);

const LIMITS = Object.freeze({
  title: 160,
  symptom: 8_000,
  listItems: 30,
  listItem: 2_000,
  longText: 12_000,
  contextValue: 500,
  versions: 20
});

export function createBugCaseError(code, message, status = 400, details = '') {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createBugCaseError(
      'BUG_CASE_INVALID_FIELD',
      `${field} 必须是对象`,
      400
    );
  }
}

function normalizeString(value, field, maxLength, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) {
      throw createBugCaseError('BUG_CASE_FIELD_REQUIRED', `${field} 不能为空`, 422);
    }
    return '';
  }
  if (typeof value !== 'string') {
    throw createBugCaseError('BUG_CASE_INVALID_FIELD', `${field} 必须是字符串`, 400);
  }
  const normalized = value.trim().replace(/\r\n/g, '\n');
  if (required && !normalized) {
    throw createBugCaseError('BUG_CASE_FIELD_REQUIRED', `${field} 不能为空`, 422);
  }
  if (normalized.length > maxLength) {
    throw createBugCaseError(
      'BUG_CASE_FIELD_TOO_LONG',
      `${field} 不能超过 ${maxLength} 个字符`,
      422
    );
  }
  return normalized;
}

function normalizeStringList(value, field, options = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw createBugCaseError('BUG_CASE_INVALID_FIELD', `${field} 必须是字符串数组`, 400);
  }
  const maxItems = options.maxItems || LIMITS.listItems;
  if (value.length > maxItems) {
    throw createBugCaseError(
      'BUG_CASE_TOO_MANY_ITEMS',
      `${field} 最多包含 ${maxItems} 项`,
      422
    );
  }

  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    const text = normalizeString(item, `${field}[]`, options.maxLength || LIMITS.listItem);
    if (!text) continue;
    const identity = text.toLocaleLowerCase('en-US');
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push(text);
  }
  return normalized;
}

/**
 * 把错误中每次运行都会变化的路径、UUID、地址和行号折叠成稳定占位符。
 * 这里保留异常类型、文件名与错误文本；它们才是跨项目复用时有区分度的证据。
 */
export function stabilizeErrorText(value) {
  return String(value || '')
    .toLocaleLowerCase('en-US')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/(?:[a-z]:)?(?:[\\/][^\\/\s:]+)+[\\/]([^\\/\s:]+\.[a-z0-9]+)(?=:\d+|\s|$)/gi, '<path>/$1')
    .replace(/:\d+(?=:\d+|\b)/g, ':<n>')
    .replace(/\b\d{5,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeErrorSignature(value) {
  return stabilizeErrorText(
    normalizeString(value, 'errorSignatures[]', LIMITS.listItem)
  );
}

export function normalizeErrorSignatures(value) {
  const raw = normalizeStringList(value, 'errorSignatures');
  const seen = new Set();
  const normalized = [];
  for (const signature of raw) {
    const stable = normalizeErrorSignature(signature);
    if (!stable || seen.has(stable)) continue;
    seen.add(stable);
    normalized.push(stable);
  }
  return normalized;
}

function normalizeContext(value = {}) {
  assertPlainObject(value, 'context');
  for (const field of Object.keys(value)) {
    if (!CONTEXT_FIELDS.has(field)) {
      throw createBugCaseError(
        'BUG_CASE_UNKNOWN_CONTEXT_FIELD',
        `不支持的 context 字段：${field}`,
        400
      );
    }
  }
  return {
    language: normalizeString(value.language, 'context.language', LIMITS.contextValue),
    framework: normalizeString(value.framework, 'context.framework', LIMITS.contextValue),
    versions: normalizeStringList(value.versions, 'context.versions', {
      maxItems: LIMITS.versions,
      maxLength: LIMITS.contextValue
    }),
    module: normalizeString(value.module, 'context.module', LIMITS.contextValue),
    environment: normalizeString(value.environment, 'context.environment', LIMITS.contextValue)
  };
}

/**
 * 归一化完整 BugCase 内容。此函数既用于创建，也用于将 patch 与旧内容合并后的再次校验；
 * 它不接受 identity/review 字段，避免把“不可信输入校验”和“状态迁移授权”混在一起。
 */
export function normalizeBugCaseContent(input) {
  assertPlainObject(input, 'BugCase');
  for (const field of Object.keys(input)) {
    if (!CONTENT_FIELD_SET.has(field)) {
      throw createBugCaseError(
        'BUG_CASE_UNKNOWN_FIELD',
        `不支持的 BugCase 字段：${field}`,
        400
      );
    }
  }

  const resolutionType = normalizeString(
    input.resolutionType || 'root_cause_fix',
    'resolutionType',
    40,
    { required: true }
  );
  if (!RESOLUTION_TYPE_SET.has(resolutionType)) {
    throw createBugCaseError(
      'BUG_CASE_INVALID_RESOLUTION_TYPE',
      `不支持的解决类型：${resolutionType}`,
      422
    );
  }

  return {
    title: normalizeString(input.title, 'title', LIMITS.title, { required: true }),
    symptom: normalizeString(input.symptom, 'symptom', LIMITS.symptom, { required: true }),
    errorSignatures: normalizeErrorSignatures(input.errorSignatures),
    reproductionSteps: normalizeStringList(input.reproductionSteps, 'reproductionSteps'),
    context: normalizeContext(input.context || {}),
    resolutionType,
    // null 明确表示“尚未知道根因”，比空串更适合在 API/UI 中表达 workaround 的语义。
    rootCause: normalizeString(input.rootCause, 'rootCause', LIMITS.longText) || null,
    fix: normalizeString(input.fix, 'fix', LIMITS.longText),
    workaroundRisks: normalizeStringList(input.workaroundRisks, 'workaroundRisks'),
    applicability: normalizeStringList(input.applicability, 'applicability'),
    verification: normalizeString(input.verification, 'verification', LIMITS.longText),
    tags: normalizeStringList(input.tags, 'tags', { maxItems: LIMITS.listItems, maxLength: 100 }),
    sourceRefs: normalizeStringList(input.sourceRefs, 'sourceRefs')
  };
}

export function normalizeBugCasePatch(current, patch) {
  assertPlainObject(patch, 'BugCase patch');
  for (const field of Object.keys(patch)) {
    if (!CONTENT_FIELD_SET.has(field)) {
      throw createBugCaseError(
        'BUG_CASE_UNKNOWN_FIELD',
        `不支持的 BugCase 字段：${field}`,
        400
      );
    }
  }
  return normalizeBugCaseContent({ ...current, ...patch });
}

export function buildBugCaseFingerprint(content) {
  const normalized = normalizeBugCaseContent(content);
  const identity = {
    signatures: [...normalized.errorSignatures].sort(),
    context: {
      language: normalized.context.language.toLocaleLowerCase('en-US'),
      framework: normalized.context.framework.toLocaleLowerCase('en-US'),
      versions: [...normalized.context.versions]
        .map((value) => value.toLocaleLowerCase('en-US'))
        .sort(),
      module: normalized.context.module.toLocaleLowerCase('en-US')
    }
  };
  // 没有错误签名时仍生成稳定身份，但加入 symptom，避免所有“纯症状”案例互相碰撞。
  if (!identity.signatures.length) {
    identity.symptom = normalized.symptom.toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
  }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function requireConfirmationValue(condition, code, message) {
  if (!condition) throw createBugCaseError(code, message, 422);
}

function hasTechnicalContext(context) {
  return Boolean(
    context.language
    || context.framework
    || context.versions.length
    || context.module
    || context.environment
  );
}

function validateSharedConfirmationEvidence(normalized) {
  // Gate A/D1 规定的这些字段属于“可被正式诊断”的共同最低证据，
  // 与根因是否已知无关。因此必须在 resolutionType 分支之前检查，
  // 否则 root_cause_fix 会只凭 rootCause + fix 绕过 context、来源和验证。
  requireConfirmationValue(
    hasTechnicalContext(normalized.context),
    'BUG_CASE_TECHNICAL_CONTEXT_REQUIRED',
    '确认 BugCase 前必须填写至少一项技术 context'
  );
  requireConfirmationValue(
    normalized.errorSignatures.length > 0 || normalized.reproductionSteps.length > 0,
    'BUG_CASE_SIGNATURE_OR_REPRODUCTION_REQUIRED',
    '确认 BugCase 前必须填写错误签名或可执行复现步骤'
  );
  requireConfirmationValue(
    Boolean(normalized.verification),
    'BUG_CASE_VERIFICATION_REQUIRED',
    '确认 BugCase 前必须填写人工验证过程'
  );
  requireConfirmationValue(
    normalized.sourceRefs.length > 0,
    'BUG_CASE_SOURCE_REFS_REQUIRED',
    '确认 BugCase 前必须至少保留一个来源'
  );
}

/**
 * 审核 endpoint 在持久化 confirmed 前调用本函数。candidate 允许信息不完整，
 * confirmed 则必须给模型/人类足够证据，尤其不能把“试过能用”伪装成已知根因。
 */
export function validateBugCaseConfirmation(content) {
  const normalized = normalizeBugCaseContent(content);
  requireConfirmationValue(
    Boolean(normalized.fix),
    'BUG_CASE_FIX_REQUIRED',
    '确认 BugCase 前必须填写修复或 workaround 操作'
  );
  validateSharedConfirmationEvidence(normalized);

  if (normalized.resolutionType === 'root_cause_fix') {
    requireConfirmationValue(
      Boolean(normalized.rootCause),
      'BUG_CASE_ROOT_CAUSE_REQUIRED',
      'root_cause_fix 必须填写明确根因'
    );
    return normalized;
  }

  requireConfirmationValue(
    normalized.rootCause === null,
    'BUG_CASE_WORKAROUND_ROOT_CAUSE_MUST_BE_UNKNOWN',
    'verified_workaround 必须明确保持根因未知；已知根因请使用 root_cause_fix'
  );
  requireConfirmationValue(
    normalized.workaroundRisks.length > 0,
    'BUG_CASE_WORKAROUND_RISKS_REQUIRED',
    'verified_workaround 必须填写风险'
  );
  requireConfirmationValue(
    normalized.applicability.length > 0,
    'BUG_CASE_APPLICABILITY_REQUIRED',
    'verified_workaround 必须填写适用范围'
  );
  return normalized;
}

export function renderBugCaseDocument(content) {
  const bugCase = normalizeBugCaseContent(content);
  const list = (values) => values.length ? values.map((value) => `- ${value}`).join('\n') : '- 未记录';
  const context = [
    bugCase.context.language && `语言：${bugCase.context.language}`,
    bugCase.context.framework && `框架：${bugCase.context.framework}`,
    bugCase.context.versions.length && `版本：${bugCase.context.versions.join(', ')}`,
    bugCase.context.module && `模块：${bugCase.context.module}`,
    bugCase.context.environment && `环境：${bugCase.context.environment}`
  ].filter(Boolean).join('\n') || '未记录';

  // 生成确定性的 Markdown 作为既有 chunk/embedding 流水线的输入；结构化字段仍以 metadata 为权威。
  return [
    `# ${bugCase.title}`,
    '## 症状', bugCase.symptom,
    '## 错误签名', list(bugCase.errorSignatures),
    '## 复现步骤', list(bugCase.reproductionSteps),
    '## 上下文', context,
    '## 解决类型', bugCase.resolutionType,
    '## 根因', bugCase.rootCause || '根因未知',
    '## 修复或 Workaround', bugCase.fix || '未记录',
    '## Workaround 风险', list(bugCase.workaroundRisks),
    '## 适用范围', list(bugCase.applicability),
    '## 验证', bugCase.verification || '未记录',
    '## 标签', list(bugCase.tags),
    '## 来源', list(bugCase.sourceRefs)
  ].join('\n\n');
}
