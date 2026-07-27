import { tokenize } from '../rag-utils.js';
import {
  createBugCaseError,
  normalizeErrorSignature,
  stabilizeErrorText
} from './bug-case-domain.js';

const MAX_SIGNATURE_LENGTH = 2_000;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeFilterText(value, field) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw createBugCaseError('BUG_QUERY_INVALID_FILTER', `${field} 必须是字符串`, 400);
  }
  return value.trim().toLocaleLowerCase('en-US');
}

function normalizeFilterList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw createBugCaseError('BUG_QUERY_INVALID_FILTER', `${field} 必须是字符串数组`, 400);
  }
  return unique(value.map((item) => normalizeFilterText(item, `${field}[]`))).slice(0, 20);
}

export function createBugQuery(input = {}) {
  if (typeof input.query !== 'string' || !input.query.trim()) {
    throw createBugCaseError('BUG_QUERY_REQUIRED', 'query 不能为空', 422);
  }
  const raw = input.query.trim();
  if (raw.length > 8_000) {
    throw createBugCaseError('BUG_QUERY_TOO_LONG', 'query 不能超过 8000 个字符', 422);
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Stack frame 主要贡献 symbol；把它从完整签名候选中分离，可避免不同构建目录/行号破坏 exact 命中。
  const signatureLines = lines.filter((line) =>
    !/^at\s+/i.test(line) && line.length <= MAX_SIGNATURE_LENGTH
  );
  const signatures = unique(
    (
      signatureLines.length
        ? signatureLines
        : raw.length <= MAX_SIGNATURE_LENGTH ? [raw] : []
    ).map(normalizeErrorSignature)
  );
  const symbols = unique(
    [...raw.matchAll(/\bat\s+([A-Za-z_$][\w$]*(?:\.[\w$<>]+)*)/g)]
      .map((match) => match[1].toLocaleLowerCase('en-US'))
  );
  const errorCodes = unique([
    ...raw.matchAll(/\b(?:ERR_[A-Z0-9_]+|E[A-Z]{2,}[A-Z0-9_]*|[A-Z][A-Z0-9_]+-\d+)\b/g)
  ].map((match) => match[0].toLocaleLowerCase('en-US')));
  const exceptionTypes = unique([
    ...raw.matchAll(/\b[A-Za-z_$][\w$]*(?:Error|Exception)\b/g)
  ].map((match) => match[0].toLocaleLowerCase('en-US')));
  const filters = input.filters || {};

  return {
    raw,
    // 检索 query 最多 8000 字符，并不是一个可持久化 Error Signature。
    // 这里复用稳定化规则，但不能复用单条签名的 2000 字符字段校验。
    normalizedText: stabilizeErrorText(raw),
    signatures,
    symbols,
    errorCodes,
    exceptionTypes,
    tokens: unique(tokenize(raw)),
    filters: {
      language: normalizeFilterText(filters.language, 'filters.language'),
      framework: normalizeFilterText(filters.framework, 'filters.framework'),
      versions: normalizeFilterList(filters.versions, 'filters.versions'),
      tags: normalizeFilterList(filters.tags, 'filters.tags')
    }
  };
}

function contextCompatibility(query, bugCase) {
  const context = bugCase.context || {};
  const checks = [];
  for (const field of ['language', 'framework']) {
    const expected = query.filters[field];
    if (!expected) continue;
    const actual = String(context[field] || '').trim().toLocaleLowerCase('en-US');
    checks.push(actual ? actual === expected : null);
  }
  if (query.filters.versions.length) {
    const versions = new Set(
      (Array.isArray(context.versions) ? context.versions : [])
        .map((value) => String(value).trim().toLocaleLowerCase('en-US'))
    );
    checks.push(versions.size
      ? query.filters.versions.some((version) => versions.has(version))
      : null);
  }
  if (query.filters.tags.length) {
    const tags = new Set(
      (Array.isArray(bugCase.tags) ? bugCase.tags : [])
        .map((value) => String(value).trim().toLocaleLowerCase('en-US'))
    );
    checks.push(tags.size ? query.filters.tags.every((tag) => tags.has(tag)) : null);
  }
  if (!checks.length) return null;
  if (checks.includes(false)) return false;
  if (checks.includes(null)) return null;
  return true;
}

function signatureMatches(querySignature, storedSignature) {
  if (querySignature === storedSignature) return true;
  // 多行/带前后说明的粘贴内容仍可命中其中一条完整稳定签名。
  return querySignature.includes(storedSignature) || storedSignature.includes(querySignature);
}

export function matchExactBugSignatures(query, bugCases) {
  const matches = [];
  for (const bugCase of bugCases) {
    const stored = unique(
      (Array.isArray(bugCase.errorSignatures) ? bugCase.errorSignatures : [])
        .map(normalizeErrorSignature)
    );
    let best = null;
    for (const storedSignature of stored) {
      for (const querySignature of query.signatures) {
        if (!signatureMatches(querySignature, storedSignature)) continue;
        const fullSignature = querySignature === storedSignature;
        const quality = fullSignature ? 2 : 1;
        if (!best || quality > best.quality) {
          best = {
            storedSignature,
            fullSignature,
            ambiguityKey: storedSignature,
            quality
          };
        }
      }
      if (best?.quality === 2) continue;
      // 完整文本不一致时，稳定错误码、异常类型或 stack symbol 仍是 document 级 exact 信号。
      // 它的质量低于完整 signature，因此不会越过一个上下文兼容的完整命中。
      const marker = [
        ...query.errorCodes,
        ...query.exceptionTypes,
        ...query.symbols
      ].find((value) => storedSignature.includes(value));
      if (marker && (!best || best.quality < 1)) {
        best = {
          storedSignature,
          fullSignature: false,
          ambiguityKey: marker,
          quality: 1
        };
      }
    }
    if (!best) continue;
    matches.push({
      documentId: bugCase.id,
      matchedSignature: best.storedSignature,
      ambiguityKey: best.ambiguityKey,
      fullSignature: best.fullSignature,
      contextCompatible: contextCompatibility(query, bugCase),
      quality: best.quality
    });
  }

  const contextOrder = (value) => value === true ? 0 : value === null ? 1 : 2;
  return matches
    .sort((left, right) =>
      contextOrder(left.contextCompatible) - contextOrder(right.contextCompatible)
      || right.quality - left.quality
      || left.documentId.localeCompare(right.documentId)
    )
    .map((match, index) => ({ ...match, rank: index + 1 }));
}
