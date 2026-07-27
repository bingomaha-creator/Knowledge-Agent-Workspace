import { expandCjkBigrams, tokenize } from './rag-utils.js';

const GENERIC_SIGNALS = new Set([
  '如何', '什么', '哪些', '为什么', '是否', '当前', '相关', '问题', '研究', '核心',
  '概念', '背景', '边界', '风险', '限制', 'what', 'which', 'why', 'how'
]);
const GENERIC_ENTITY_TERMS = new Set([
  'agent', 'agents', 'coding', 'code', 'task', 'test', 'testing', 'official',
  'github', 'docs', 'implementation'
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function signals(value) {
  return unique(expandCjkBigrams(tokenize(value)))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !GENERIC_SIGNALS.has(token));
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function githubRepository(url) {
  if (url?.hostname !== 'github.com') return false;
  return url.pathname.split('/').filter(Boolean).length === 2;
}

/**
 * 资料“是什么”和“是否为一手来源”分开表达。搜索结果只能给出候选判断；
 * 仅因为来自 GitHub 或带有 official_docs 标签，不会直接升级成已验证一手资料。
 */
export function classifyResearchSource(source) {
  if (source?.kind !== 'web') {
    return {
      sourceType: 'project_knowledge',
      provenance: 'verified_primary',
      confidence: 1,
      reasons: ['scoped_project_knowledge']
    };
  }

  const url = safeUrl(source?.url);
  const sourceKind = String(source?.sourceKind || '').toLowerCase();
  if (githubRepository(url)) {
    const githubIndex = source?.discoveryMethod === 'github_repository_search';
    return {
      sourceType: 'repository',
      provenance: 'candidate_primary',
      confidence: githubIndex ? 0.95 : 0.85,
      reasons: [
        'github_repository_url',
        ...(githubIndex ? ['github_repository_index'] : []),
        'ownership_not_verified'
      ]
    };
  }
  if (sourceKind === 'official_docs' || /(^|\.)docs?\./iu.test(url?.hostname || '')) {
    return {
      sourceType: 'documentation',
      provenance: 'candidate_primary',
      confidence: 0.7,
      reasons: ['documentation_url', 'publisher_not_verified']
    };
  }
  if (sourceKind === 'paper' || /arxiv\.org$|doi\.org$/iu.test(url?.hostname || '')) {
    return {
      sourceType: 'paper',
      provenance: 'candidate_primary',
      confidence: 0.75,
      reasons: ['paper_index_or_identifier']
    };
  }
  if (sourceKind === 'standard') {
    return {
      sourceType: 'standard',
      provenance: 'candidate_primary',
      confidence: 0.65,
      reasons: ['provider_standard_label', 'publisher_not_verified']
    };
  }
  return {
    sourceType: 'web_page',
    provenance: sourceKind === 'secondary' ? 'secondary' : 'unknown',
    confidence: 0.45,
    reasons: ['generic_web_result']
  };
}

export function scoreResearchSource(question, source, preferredSourceTypes = []) {
  const classification = source?.classification || classifyResearchSource(source);
  const querySignals = signals(question);
  const title = String(source?.title || '').toLowerCase();
  const url = String(source?.url || '').toLowerCase();
  const textSignals = new Set(signals(`${source?.title || ''}\n${source?.snippet || ''}`));
  const matched = querySignals.filter((token) => textSignals.has(token));
  const lexicalCoverage = querySignals.length ? matched.length / querySignals.length : 0;
  const latinEntities = unique(
    String(question || '').match(/[a-z][a-z0-9+.#-]{2,}/giu) || []
  )
    .map((token) => token.toLowerCase())
    .filter((token) => !GENERIC_ENTITY_TERMS.has(token));
  const entityAnchors = latinEntities.length
    ? latinEntities
    : querySignals.filter((token) => token.length >= 4).slice(0, 3);
  const exactEntity = entityAnchors.some((token) => title.includes(token) || url.includes(token));
  const preferred = preferredSourceTypes.some((type) => {
    if (type === 'official_repo') return classification.sourceType === 'repository';
    if (type === 'official_docs') return classification.sourceType === 'documentation';
    if (type === 'project_knowledge') return classification.sourceType === 'project_knowledge';
    return type === classification.sourceType;
  });
  const providerRank = Number.isInteger(Number(source?.providerRank))
    ? Math.max(1, Number(source.providerRank))
    : null;
  const providerScore = providerRank ? Math.max(0, (7 - Math.min(7, providerRank)) / 6) : 0;
  const provenanceScore = classification.provenance === 'verified_primary'
    ? 1
    : classification.provenance === 'candidate_primary'
      ? 0.7
      : classification.provenance === 'secondary'
        ? 0.3
        : 0;
  const qualityScore =
    lexicalCoverage * 0.45 +
    (exactEntity ? 0.2 : 0) +
    (preferred ? 0.15 : 0) +
    providerScore * 0.1 +
    provenanceScore * 0.1 +
    (source?.discoveryMethod === 'github_repository_search' ? 0.12 : 0);

  return {
    lexicalCoverage: Number(lexicalCoverage.toFixed(4)),
    exactEntity,
    preferredSourceType: preferred,
    providerRank,
    qualityScore: Number(qualityScore.toFixed(4))
  };
}
