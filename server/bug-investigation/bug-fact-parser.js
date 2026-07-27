import { normalizeErrorSignature } from '../bug-knowledge/bug-case-domain.js';

const FACT_BEARING_EVIDENCE_TYPES = new Set(['error', 'network', 'test_failure']);

function unique(values, limit = 20) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function evidenceText(item) {
  return typeof item?.content === 'string' ? item.content : '';
}

function detectFrameworks(text) {
  const checks = [
    ['Vue', /\bvue(?:\.runtime)?\b|\.vue:\d+|pinia/iu],
    ['Pinia', /\bpinia\b|defineStore|storeToRefs/iu],
    ['React', /\breact(?:-dom)?\b|useEffect|useState/iu],
    ['Vite', /\bvite\b|@vite/iu],
    ['SSE', /\bSSE\b|EventSource|text\/event-stream|event block/iu],
    ['Axios', /\baxios\b|AxiosError/iu],
    ['Playwright', /\bplaywright\b|page\.locator|expect\(/iu],
    ['Vitest', /\bvitest\b|vi\.fn|vitest run/iu]
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function detectEnvironments(text) {
  const checks = [
    ['browser', /\b(?:chrome|firefox|safari|browser|viewport|window|document)\b/iu],
    ['node', /\bnode(?:\.js)?\b|node:internal|npm run/iu],
    ['test', /\b(?:vitest|jest|playwright|test failed|assertion)\b/iu],
    ['development', /\b(?:localhost|development|dev server)\b/iu],
    ['production', /\bproduction\b|线上|生产环境/iu]
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function detectLanguages(text) {
  const checks = [
    ['TypeScript', /\btypescript\b|\bTS\d{4}\b|(?:^|[/\\])[^/\n\\]+\.tsx?(?::\d+)?/imu],
    ['JavaScript', /\bjavascript\b|(?:^|[/\\])[^/\n\\]+\.[cm]?jsx?(?::\d+)?/imu],
    ['CSS', /\bcss\b|(?:^|[/\\])[^/\n\\]+\.(?:css|scss|sass|less)(?::\d+)?/imu]
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function extractErrorTypes(text) {
  return unique(
    text.match(/\b(?:[A-Za-z_$][\w$]*(?:Error|Exception)|Error|Exception)\b/g) || [],
    12
  );
}

function extractErrorCodes(text) {
  return unique(
    text.match(/\b(?:TS\d{4}|ERR_[A-Z0-9_]+|E[A-Z]{2,}[A-Z0-9_]*)\b/g) || [],
    12
  );
}

function extractLocations(text) {
  return unique(
    text.match(
      /(?:(?:[A-Za-z]:)?[A-Za-z0-9_./@\\-]+\.(?:[cm]?[jt]sx?|vue|json|css|scss|sass|less)):\d+(?::\d+)?/g
    ) || [],
    30
  );
}

function isFailureLine(line) {
  if (/\b(?:TS\d{4}|ERR_[A-Z0-9_]+|E[A-Z]{2,}[A-Z0-9_]*)\b/.test(line)) return true;
  if (
    /\b(?:4\d{2}|5\d{2})\b/.test(line)
    && /\b(?:http|request|response|fetch|network)\b/iu.test(line)
  ) {
    return true;
  }

  return /(?:error|exception|failed|failure|timeout|unexpected|cannot|undefined|null|refused|not found|net::)/iu.test(
    line
  );
}

function candidateSignatureLines(evidence) {
  return unique(
    evidence.flatMap((item) =>
      evidenceText(item)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) =>
          line.length >= 6
          && line.length <= 500
          && !/^at\s+/u.test(line)
          && isFailureLine(line)
        )
    ),
    12
  );
}

function metadataLanguages(evidence) {
  return unique(
    evidence.map((item) => item?.metadata?.language?.trim()).filter(Boolean),
    12
  );
}

/**
 * 前端优先的事实解析器。
 * 只从错误、网络和测试失败证据中提取错误事实；代码证据只用于技术上下文，
 * 避免把变量名、注释和实现文本污染为 Error Signature。
 */
export function parseBugFacts(evidence = []) {
  const safeEvidence = Array.isArray(evidence) ? evidence : [];
  const factEvidence = safeEvidence.filter((item) => FACT_BEARING_EVIDENCE_TYPES.has(item?.type));
  const factText = factEvidence.map(evidenceText).join('\n');
  const contextText = safeEvidence.map(evidenceText).join('\n');
  const signatureLines = candidateSignatureLines(factEvidence);
  const locations = extractLocations(factText);

  return {
    errorTypes: extractErrorTypes(factText),
    errorCodes: extractErrorCodes(factText),
    messages: signatureLines,
    files: unique(locations.map((location) => location.split(':')[0]), 30),
    locations,
    languages: unique([...metadataLanguages(safeEvidence), ...detectLanguages(contextText)], 12),
    frameworks: unique(detectFrameworks(contextText), 12),
    environments: unique(detectEnvironments(contextText), 12),
    errorSignatures: unique(signatureLines.map(normalizeErrorSignature).filter(Boolean), 12),
    reproductionSteps: safeEvidence
      .filter((item) => item.type === 'reproduction')
      .flatMap((item) =>
        evidenceText(item)
          .split('\n')
          .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/u, '').trim())
          .filter(Boolean)
      )
      .slice(0, 30),
    verificationNotes: safeEvidence
      .filter((item) => item.type === 'verification')
      .map(evidenceText)
      .filter(Boolean)
      .slice(0, 20),
    evidenceIds: safeEvidence.map((item) => item?.id).filter(Boolean)
  };
}
