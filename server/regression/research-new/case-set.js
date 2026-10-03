import { createHash } from 'node:crypto';

const MODES = new Set(['web', 'hybrid']);

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every(
    (item) => typeof item === 'string' && item.trim().length > 0
  );
}

export function validateResearchNewCases(cases) {
  if (!Array.isArray(cases) || cases.length < 8) {
    throw new TypeError('Research New 评测至少需要 8 个 case');
  }

  const ids = new Set();
  for (const item of cases) {
    if (!item || typeof item !== 'object') throw new TypeError('评测 case 必须是对象');
    if (typeof item.id !== 'string' || !/^[a-z0-9-]+$/.test(item.id)) {
      throw new TypeError('评测 case id 必须是稳定的 kebab-case');
    }
    if (ids.has(item.id)) throw new TypeError(`评测 case id 重复：${item.id}`);
    ids.add(item.id);
    if (!MODES.has(item.mode)) throw new TypeError(`不支持的评测模式：${item.mode}`);
    if (typeof item.question !== 'string' || !item.question.trim()) {
      throw new TypeError(`评测问题不能为空：${item.id}`);
    }
    for (const field of [
      'requiredDimensions',
      'preferredSourceTraits',
      'allowedUnresolvedWhen',
      'forbiddenUnsupportedClaims'
    ]) {
      if (!nonEmptyStrings(item[field])) throw new TypeError(`${item.id}.${field} 不能为空`);
    }
    if (item.mode === 'hybrid' && (
      typeof item.knowledgeFixture !== 'string' || !item.knowledgeFixture.trim()
    )) {
      throw new TypeError(`Hybrid case 必须声明 knowledgeFixture：${item.id}`);
    }
  }
  return cases;
}

export function hashResearchNewCaseSet(cases) {
  validateResearchNewCases(cases);
  return createHash('sha256').update(JSON.stringify(cases)).digest('hex');
}
