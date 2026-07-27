import { expandCjkBigrams, tokenize } from './rag-utils.js';

const GENERIC_TERMS = new Set([
  '什么', '如何', '哪些', '为什么', '是否', '相关', '问题', '研究', '核心', '概念',
  '背景', '边界', '风险', '限制', '下一步', 'what', 'which', 'why', 'how', 'research'
]);
const INTENTS = new Set([
  'definition',
  'comparison',
  'decision',
  'risk',
  'implementation',
  'current_state',
  'investigation'
]);
const SOURCE_TYPES = new Set([
  'project_knowledge',
  'official_docs',
  'official_repo',
  'paper',
  'standard',
  'government_document',
  'public_web'
]);
const SOURCE_QUERY_TERMS = Object.freeze({
  project_knowledge: '',
  official_docs: 'official docs',
  official_repo: 'official GitHub',
  paper: 'paper',
  standard: 'official standard',
  government_document: 'government official',
  public_web: ''
});
const UNSUPPORTED_SCENARIO_TERMS = ['金融', '医疗', '法律', '教育', '政府', '电商', '审计', '合规'];
const LEADING_IMPLEMENTATION_ASSUMPTION =
  /是否.{0,160}(?:通过|依赖|基于|采用|内置|具备|支持|共享|还是|而非|而是)|(?:是否通过|是否依赖|是否基于)/iu;

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactText(value, length) {
  return normalizedText(value).slice(0, length);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function meaningfulTokens(value) {
  return unique(expandCjkBigrams(tokenize(value)))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !GENERIC_TERMS.has(token));
}

function hasTopicAnchor(question, candidate) {
  const anchors = meaningfulTokens(question);
  if (!anchors.length) return true;
  const candidateTokens = new Set(meaningfulTokens(candidate));
  return anchors.some((token) => candidateTokens.has(token));
}

function materiallyDifferent(left, right) {
  const leftTokens = new Set(meaningfulTokens(left));
  const rightTokens = new Set(meaningfulTokens(right));
  if (!leftTokens.size || !rightTokens.size) return normalizedText(left) !== normalizedText(right);
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return shared / Math.min(leftTokens.size, rightTokens.size) < 0.78;
}

function introducesUnsupportedScenario(question, candidate) {
  const original = normalizedText(question);
  const proposed = normalizedText(candidate);
  return UNSUPPORTED_SCENARIO_TERMS.some((term) => proposed.includes(term) && !original.includes(term));
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const raw = String(value || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function normalizeIntent(value) {
  const intent = normalizedText(value).toLowerCase();
  return INTENTS.has(intent) ? intent : 'investigation';
}

function inferSubject(objective) {
  const latinTerms = objective.match(/[a-z][a-z0-9+.#-]*/giu) || [];
  const meaningfulLatinTerms = unique(latinTerms)
    .filter((term) => !['github', 'official', 'docs', 'research'].includes(term.toLowerCase()))
    .slice(0, 3);
  if (meaningfulLatinTerms.length) return meaningfulLatinTerms.join(' ');
  return compactText(
    objective
      .replace(/[?？]/g, '')
      .replace(/^(?:请|帮我|研究|比较|对比|分析)+/u, ''),
    72
  );
}

function normalizeSubject(objective, value) {
  const proposed = compactText(value, 120);
  if (proposed && hasTopicAnchor(objective, proposed)) return proposed;
  return inferSubject(objective);
}

function normalizeFacets(value, intent) {
  const raw = Array.isArray(value) ? value : [];
  const facets = unique(raw
    .map((item) => compactText(item, 64))
    .map((item) => item.replace(/[?？。！!]/g, ''))
    .filter((item) => item.length > 1 && !LEADING_IMPLEMENTATION_ASSUMPTION.test(item)))
    .slice(0, 4);
  if (facets.length) return facets;
  const defaults = {
    definition: ['definition', 'scope'],
    comparison: ['capabilities', 'differences'],
    decision: ['tradeoffs', 'decision_criteria'],
    risk: ['risks', 'limitations'],
    implementation: ['implementation'],
    current_state: ['current_state']
  };
  return defaults[intent] || ['evidence'];
}

function explicitSourceTypes(question) {
  const types = [];
  if (/github|开源项目|开源仓库|源码|repository/iu.test(question)) {
    types.push('official_repo', 'official_docs');
  }
  if (/论文|学术|paper|arxiv|研究文献/iu.test(question)) types.push('paper');
  if (/标准|规范|RFC|standard/iu.test(question)) types.push('standard', 'official_docs');
  if (/法规|法条|政策|政府|government/iu.test(question)) {
    types.push('government_document');
  }
  if (/本地资料|项目资料|知识库|上传文件|当前项目/iu.test(question)) {
    types.push('project_knowledge');
  }
  return unique(types);
}

function defaultSourceTypes(intent) {
  if (intent === 'implementation') return ['official_docs', 'official_repo'];
  if (intent === 'comparison') return ['official_docs', 'official_repo', 'paper'];
  if (intent === 'definition') return ['official_docs', 'paper'];
  if (intent === 'risk' || intent === 'decision') return ['official_docs', 'paper'];
  if (intent === 'current_state') return ['official_docs', 'public_web'];
  return ['official_docs', 'paper', 'public_web'];
}

function resolvePreferredSourceTypes(question, rawTypes, intent) {
  const proposed = Array.isArray(rawTypes)
    ? unique(rawTypes.map((item) => normalizedText(item).toLowerCase()))
      .filter((item) => SOURCE_TYPES.has(item))
    : [];
  const explicit = explicitSourceTypes(question);
  return unique([
    ...explicit,
    ...proposed,
    ...(explicit.length || proposed.length ? [] : defaultSourceTypes(intent))
  ]).slice(0, 4);
}

function resolveFreshness(question, proposed) {
  if (/最新|当前|目前|现行|现在|today|current|latest|20\d{2}/iu.test(question)) return 'current';
  if (/历史|演变|过去|historical|history/iu.test(question)) return 'historical';
  return ['current', 'historical', 'any'].includes(proposed) ? proposed : 'any';
}

function sanitizeSubquestion(subject, question, facets) {
  if (!LEADING_IMPLEMENTATION_ASSUMPTION.test(question)) return question;
  const readableFacets = facets
    .slice(0, 3)
    .map((facet) => facet.replace(/[_-]+/g, ' '))
    .join('、');
  return compactText(
    `${subject} 在${readableFacets || '相关机制'}方面的实际实现方式是什么？`,
    360
  );
}

function isReferentialFollowUp(question) {
  return /这(?:个|些|两|2)|那(?:个|些|两|2)|上述|上轮|前面|之前|引用|它们|这些|分别|二者|两者|该项目|这个项目/iu
    .test(String(question || ''));
}

function fallbackSearchQuery(question) {
  const objective = compactText(question, 4000);
  if (/github|开源项目|开源代码|源码参考/iu.test(objective)) {
    const englishTerms = objective.match(/[a-z][a-z0-9+.#-]*/giu) || [];
    const uniqueTerms = unique(englishTerms.map((term) => term.toLowerCase()))
      .filter((term) => term !== 'github')
      .slice(0, 5);
    if (uniqueTerms.length) return `${uniqueTerms.join(' ')} GitHub`;
  }
  return objective.slice(0, 180);
}

function fallbackSearchQueryWithContext(question, continuationContext) {
  const directQuery = fallbackSearchQuery(question);
  const citations = Array.isArray(continuationContext?.citations)
    ? continuationContext.citations
    : [];
  if (!isReferentialFollowUp(question) || !citations.length) return directQuery;
  const titles = citations
    .map((citation) => compactText(citation?.title, 180))
    .filter(Boolean)
    .slice(0, 3);
  return titles.length
    ? compactText(`${directQuery} ${titles.join(' ')}`, 500)
    : directQuery;
}

export function buildResearchSearchQuery(subquestion, objective = '') {
  const subject = compactText(subquestion?.subject || inferSubject(objective), 120);
  const sourceTerms = unique(
    (subquestion?.evidenceNeed?.preferredSourceTypes || [])
      .map((type) => SOURCE_QUERY_TERMS[type])
      .filter(Boolean)
  );
  const facetTerms = unique((subquestion?.facets || [])
    .slice(0, 3)
    .map((facet) => compactText(facet, 48).replace(/[_-]+/g, ' '))
    .filter(Boolean));
  return compactText(unique([subject, ...sourceTerms, ...facetTerms]).join(' '), 180);
}

function createSingleBranchPlan(question, planner, fallbackReason, continuationContext) {
  const objective = compactText(question, 4000);
  const intent = 'investigation';
  const evidenceNeed = {
    preferredSourceTypes: resolvePreferredSourceTypes(objective, [], intent),
    freshness: resolveFreshness(objective, 'any')
  };
  const subject = inferSubject(objective);
  return {
    schemaVersion: 2,
    objective,
    planner,
    fallbackReason: compactText(fallbackReason, 160),
    subquestions: [{
      id: 'q1',
      subject,
      question: objective,
      searchQuery: planner === 'fallback'
        ? fallbackSearchQueryWithContext(objective, continuationContext)
        : buildResearchSearchQuery({
          subject,
          facets: ['evidence'],
          evidenceNeed
        }, objective),
      intent,
      facets: ['evidence'],
      evidenceNeed,
      rationale: planner === 'fallback'
        ? isReferentialFollowUp(objective) && continuationContext?.citations?.length
          ? '规划器不可用时保持单分支，并用上一轮明确引用的标题锚定指代性追问；继承资料不直接作为本轮证据。'
          : '规划器不可用时保持原问题单分支，避免生成未经验证的模板分支。'
        : '简单事实型研究直接使用单分支，减少不必要的规划延迟。'
    }]
  };
}

export function createFallbackResearchPlan(question, reason = '', continuationContext = null) {
  return createSingleBranchPlan(question, 'fallback', reason, continuationContext);
}

export function createDirectResearchPlan(question) {
  return createSingleBranchPlan(question, 'direct', '', null);
}

export function shouldUseDirectResearchPlan(question, continuationContext = null) {
  const value = compactText(question, 4000);
  if (!value || continuationContext || isReferentialFollowUp(value)) return false;
  if (/比较|对比|分别|差异|区别|综合|报告|方案|如何做好|怎么设计|有哪些.+(?:以及|和)/u.test(value)) {
    return false;
  }
  return value.length <= 64 && /(?:是什么|是谁|多少|何时|哪一年|定义是什么)[?？]?$/u.test(value);
}

export function normalizeResearchPlan(question, value, continuationContext = null) {
  const objective = compactText(question, 4000);
  const parsed = parseJsonObject(value);
  if (parsed?.planner === 'fallback') {
    return createFallbackResearchPlan(
      objective,
      parsed.fallbackReason || '规划器主动降级',
      continuationContext
    );
  }
  if (parsed?.planner === 'direct') return createDirectResearchPlan(objective);
  const rawItems = Array.isArray(parsed?.subquestions) ? parsed.subquestions : [];
  const subquestions = [];

  for (const raw of rawItems) {
    if (subquestions.length >= 3 || !raw || typeof raw !== 'object') continue;
    const proposedQuestion = compactText(raw.question, 360);
    if (!proposedQuestion || !hasTopicAnchor(objective, proposedQuestion)) continue;
    if (introducesUnsupportedScenario(objective, proposedQuestion)) continue;

    const subject = normalizeSubject(objective, raw.subject);
    const intent = normalizeIntent(raw.intent);
    const facets = normalizeFacets(raw.facets, intent);
    const questionValue = sanitizeSubquestion(subject, proposedQuestion, facets);
    if (subquestions.some((item) =>
      normalizedText(item.subject).toLowerCase() === normalizedText(subject).toLowerCase() &&
      !materiallyDifferent(item.question, questionValue)
    )) continue;
    const rawSourceTypes = raw.evidenceNeed?.preferredSourceTypes || raw.preferredSourceTypes;
    const evidenceNeed = {
      preferredSourceTypes: resolvePreferredSourceTypes(objective, rawSourceTypes, intent),
      freshness: resolveFreshness(
        objective,
        normalizedText(raw.evidenceNeed?.freshness || raw.freshness).toLowerCase()
      )
    };
    const normalized = {
      id: `q${subquestions.length + 1}`,
      subject,
      question: questionValue,
      searchQuery: '',
      intent,
      facets,
      evidenceNeed,
      rationale: compactText(raw.rationale || raw.why || '覆盖研究问题的一个独立角度。', 240)
    };
    normalized.searchQuery = buildResearchSearchQuery(normalized, objective);
    if (!normalized.searchQuery) continue;
    subquestions.push(normalized);
  }

  return subquestions.length
    ? {
      schemaVersion: 2,
      objective,
      planner: 'model',
      fallbackReason: '',
      diagnostics: parsed?.diagnostics || null,
      subquestions
    }
    : createFallbackResearchPlan(objective, '模型规划未通过结构、范围或差异性校验');
}
