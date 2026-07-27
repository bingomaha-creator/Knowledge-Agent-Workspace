import { expandCjkBigrams, tokenize } from './rag-utils.js';
import {
  classifyResearchSource,
  scoreResearchSource
} from './research-source-governance.js';

const GENERIC_QUERY_SIGNALS = new Set([
  '如何', '什么', '哪些', '为什么', '是否', '当前', '相关', '问题', '核心', '概念',
  '背景', '边界', '事实', '证据', '观点', '风险', '限制', '下一步', 'what', 'which',
  'why', 'how', 'current', 'related', 'question', 'overview', 'background'
]);

const PROJECT_DIAGNOSTIC_SIGNALS = /我们(?:的)?项目|当前项目|本项目|这个项目|代码库|现有实现|为什么会误召回|为何会误召回/u;
const FIXTURE_SIGNALS = /测试暗号|测试问题建议|fixture|test[-_ ]?data|示例占位/u;

const WEB_LIMITATION = Object.freeze({
  unavailable: {
    code: 'public_search_unavailable',
    message: '公开一手资料搜索不可用，本次结果只使用了项目资料。'
  },
  error: {
    code: 'public_search_failed',
    message: '公开一手资料搜索失败，本次结果只保留了项目资料。'
  },
  partial: {
    code: 'public_search_partial',
    message: '公开一手资料搜索仅部分成功，外部证据可能不完整。'
  }
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function querySignals(value) {
  return unique(expandCjkBigrams(tokenize(value)))
    .filter((token) => token.length > 1 && !GENERIC_QUERY_SIGNALS.has(token));
}

function sourceText(source) {
  return `${source?.title || ''}\n${source?.snippet || ''}`;
}

function documentKey(source) {
  return String(source?.documentId || source?.title || source?.id || 'unknown')
    .split(' / ')[0]
    .trim()
    .slice(0, 240);
}

/**
 * 资料角色不是由模型临时猜测，而是由用户问题的意图决定。泛化研究优先公开资料，
 * 项目诊断优先本地资料；local 模式不改变用户明确关闭公网的选择。
 */
export function inferResearchEvidencePolicy(task) {
  const question = String(task?.question || '');
  if (task?.searchMode === 'local') {
    return {
      id: 'local_only',
      label: '指定项目资料优先',
      sourcePriority: ['local'],
      maxLocalSources: 8,
      maxSourcesPerDocument: 2,
      maxEvidencePerSubquestion: 2
    };
  }
  if (PROJECT_DIAGNOSTIC_SIGNALS.test(question)) {
    return {
      id: 'project_diagnosis',
      label: '项目资料主证据，公开资料仅补充',
      sourcePriority: ['local', 'web'],
      maxLocalSources: 6,
      maxSourcesPerDocument: 2,
      maxEvidencePerSubquestion: 2
    };
  }
  return {
    id: 'general_research',
    label: '公开资料主证据，项目资料仅作案例',
    sourcePriority: ['web', 'local'],
    maxLocalSources: 1,
    maxSourcesPerDocument: 1,
    maxEvidencePerSubquestion: 2
  };
}

function lexicalCoverage(question, source) {
  const signals = querySignals(question);
  if (!signals.length) return 0;
  const sourceSignals = new Set(unique(expandCjkBigrams(tokenize(sourceText(source)))));
  const matched = signals.filter((token) => sourceSignals.has(token));
  return matched.length / signals.length;
}

function strongVectorSignal(source) {
  const score = Number(source?.retrieval?.vectorScore);
  return Number.isFinite(score) && score >= 0.35;
}

function providerRankedWebSignal(source, score, question, classification) {
  // Provider 排名只是弱信号，不能再让任意 HTTPS 摘要无条件进入证据候选。
  if (source?.kind !== 'web') return false;
  const snippet = String(source?.snippet || '').trim();
  try {
    return new URL(String(source?.url || '')).protocol === 'https:' &&
      snippet.length >= 48 &&
      Number(score?.providerRank) <= 3 &&
      (
        score?.exactEntity ||
        score?.qualityScore >= 0.3 ||
        (classification?.provenance === 'candidate_primary' && /github|开源仓库|开源项目/iu.test(question))
      );
  } catch {
    return false;
  }
}

function sourceRelevance(question, source, policy, preferredSourceTypes = []) {
  const coverage = lexicalCoverage(question, source);
  const vector = strongVectorSignal(source);
  const classification = classifyResearchSource(source);
  const quality = scoreResearchSource(question, {
    ...source,
    classification
  }, preferredSourceTypes);
  const providerRankedWeb = providerRankedWebSignal(source, quality, question, classification);
  const trustedRepositoryCandidate =
    source?.discoveryMethod === 'github_repository_search' &&
    classification.sourceType === 'repository' &&
    quality.exactEntity &&
    quality.preferredSourceType &&
    quality.qualityScore >= 0.6;
  const requiresNamedPrimary = source?.kind === 'web' &&
    preferredSourceTypes.some((type) => ['official_repo', 'official_docs'].includes(type));
  const rejectedWeakPrimary = requiresNamedPrimary &&
    classification.provenance === 'unknown' &&
    !quality.exactEntity;
  return {
    // 语义召回仍可把表述不同但有价值的来源送进候选池；是否能进入 Writer 则由下面
    // 的子问题配额和来源角色策略决定，避免误伤项目诊断中的真实证据。
    accepted: !rejectedWeakPrimary && (
      coverage >= 0.18 ||
      vector ||
      providerRankedWeb ||
      trustedRepositoryCandidate
    ),
    lexicalCoverage: Number(coverage.toFixed(4)),
    vectorScore: Number.isFinite(Number(source?.retrieval?.vectorScore))
      ? Number(source.retrieval.vectorScore)
      : null,
    providerRankedWeb,
    trustedRepositoryCandidate,
    qualityScore: quality.qualityScore,
    exactEntity: quality.exactEntity,
    preferredSourceType: quality.preferredSourceType,
    providerRank: quality.providerRank,
    rejectedWeakPrimary,
    classification
  };
}

/**
 * Phase A 的确定性相关性闸门。它只淘汰明显无关来源，不替代后续 Context Builder 的
 * rerank；被排除项仍保留摘要和原因，便于前端解释与回归测试。
 */
export function screenResearchSources(question, sources, {
  plannedQuestions = [],
  policy = inferResearchEvidencePolicy({ question, searchMode: 'local' })
} = {}) {
  const accepted = [];
  const excluded = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const sourceQuestions = Array.isArray(source?.queries) && source.queries.length
      ? source.queries
      : [question];
    const preferredTypesFor = (candidate) => {
      const planned = plannedQuestions.find((item) =>
        typeof item === 'object' && item?.question === candidate
      );
      return planned?.evidenceNeed?.preferredSourceTypes || [];
    };
    const matchedQuestions = sourceQuestions.filter((candidate) =>
      sourceRelevance(candidate, source, policy, preferredTypesFor(candidate)).accepted
    );
    const focusedQuestion = matchedQuestions[0] || sourceQuestions[0] || question;
    const relevance = sourceRelevance(
      focusedQuestion,
      source,
      policy,
      preferredTypesFor(focusedQuestion)
    );
    const isFixture = policy.id === 'general_research' && FIXTURE_SIGNALS.test(sourceText(source));
    if (isFixture) {
      excluded.push({
        id: String(source?.id || ''),
        title: String(source?.title || '未命名资料'),
        kind: source?.kind === 'web' ? 'web' : 'local',
        reason: 'template_or_fixture',
        relevance
      });
      continue;
    }
    if (relevance.accepted) {
      accepted.push({
        ...source,
        sourceType: relevance.classification.sourceType,
        provenance: relevance.classification.provenance,
        classification: relevance.classification,
        relevance,
        matchedQuestions
      });
      continue;
    }
    excluded.push({
      id: String(source?.id || ''),
      title: String(source?.title || '未命名资料'),
      kind: source?.kind === 'web' ? 'web' : 'local',
      reason: 'low_relevance',
      relevance
    });
  }
  return { accepted, excluded };
}

function sourcePriority(source, policy) {
  const channel = source?.kind === 'web' ? 'web' : 'local';
  const rank = policy.sourcePriority.indexOf(channel);
  return rank < 0 ? 99 : rank;
}

/**
 * 将通过相关性闸门的候选按“子问题 + 来源角色 + 文档配额”装入 Evidence Pack。
 * 它不会删除 accepted candidates，而是持久化为何因配额未进入 Writer 的理由。
 */
export function selectResearchEvidence({ sources, plannedQuestions, policy }) {
  const accepted = Array.isArray(sources) ? sources : [];
  const questions = Array.isArray(plannedQuestions) ? plannedQuestions : [];
  const selected = [];
  const excluded = [];
  const selectedIds = new Set();
  const documentCounts = new Map();
  let localCount = 0;

  for (const item of questions) {
    const question = typeof item === 'string' ? item : item?.question;
    if (!question) continue;
    let candidates = accepted
      .filter((source) => !selectedIds.has(source.id) && (source.matchedQuestions || source.queries || []).includes(question));
    const prefersRepository = typeof item === 'object' &&
      item?.evidenceNeed?.preferredSourceTypes?.includes('official_repo');
    const indexedRepositories = prefersRepository
      ? candidates.filter((source) => source.discoveryMethod === 'github_repository_search')
      : [];
    if (indexedRepositories.length) {
      candidates
        .filter((source) => source.discoveryMethod !== 'github_repository_search')
        .forEach((source) => excluded.push({
          id: source.id,
          title: source.title,
          kind: source.kind === 'web' ? 'web' : 'local',
          reason: 'superseded_by_repository_index'
        }));
      candidates = indexedRepositories;
    }
    candidates.sort((left, right) => {
        const channelDifference = sourcePriority(left, policy) - sourcePriority(right, policy);
        if (channelDifference) return channelDifference;
        const qualityDifference =
          (right.relevance?.qualityScore || 0) - (left.relevance?.qualityScore || 0);
        if (qualityDifference) return qualityDifference;
        return (left.providerRank || 99) - (right.providerRank || 99);
      });
    let selectedForQuestion = 0;
    for (const source of candidates) {
      if (selectedForQuestion >= policy.maxEvidencePerSubquestion || selected.length >= 8) break;
      const key = documentKey(source);
      const channel = source.kind === 'web' ? 'web' : 'local';
      if (channel === 'local' && localCount >= policy.maxLocalSources) {
        excluded.push({ id: source.id, title: source.title, kind: channel, reason: 'source_quota' });
        continue;
      }
      if ((documentCounts.get(key) || 0) >= policy.maxSourcesPerDocument) {
        excluded.push({ id: source.id, title: source.title, kind: channel, reason: 'document_quota' });
        continue;
      }
      selected.push({ ...source, selectedFor: question });
      selectedIds.add(source.id);
      documentCounts.set(key, (documentCounts.get(key) || 0) + 1);
      if (channel === 'local') localCount += 1;
      selectedForQuestion += 1;
    }
  }

  return { selected, excluded };
}

function coveredSubquestions(subquestions, sources) {
  const covered = new Set();
  for (const source of sources) {
    for (const query of Array.isArray(source?.queries) ? source.queries : []) {
      if (subquestions.includes(query)) covered.add(query);
    }
  }
  return covered.size;
}

function addLimitation(target, limitation) {
  if (!limitation || target.some((item) => item.code === limitation.code)) return;
  target.push(limitation);
}

/**
 * 把最终报告的证据覆盖、联网降级和引用结构收敛为一个稳定质量结果。这里只判断
 * “是否有足够相关证据形成报告”，不声称已经完成模型审稿或事实真实性验证。
 */
export function assessResearchQuality(task, artifacts = {}) {
  // extracting 阶段之后，最终 Evidence Pack（citations）才是报告实际可用的证据；
  // 不能再用更大的召回候选集给质量结论“加分”。保留旧 fallback 是为了兼容独立测试和
  // 尚未进入 extracting 的中间态。
  const sources = artifacts.evidencePack
    ? (Array.isArray(artifacts.citations) ? artifacts.citations : [])
    : (Array.isArray(artifacts.sources) ? artifacts.sources : []);
  const subquestions = Array.isArray(artifacts.subquestions) ? artifacts.subquestions : [];
  const coveredCount = coveredSubquestions(subquestions, sources);
  const coverageRatio = subquestions.length ? coveredCount / subquestions.length : 0;
  const verificationValid = artifacts.verification?.valid === true;
  const unverifiedPublicSources = sources.filter(
    (source) => source?.kind === 'web' &&
      !['verified_primary', 'candidate_primary'].includes(source?.provenance)
  );
  const limitations = [];

  if (!sources.length) {
    addLimitation(limitations, {
      code: 'no_relevant_evidence',
      message: '没有找到与研究问题足够相关的证据，因此不应据此形成事实性结论。'
    });
  } else if (coverageRatio < 0.75) {
    addLimitation(limitations, {
      code: 'low_subquestion_coverage',
      message: `只有 ${coveredCount}/${subquestions.length || 0} 个子问题获得了相关证据。`
    });
  }

  if (task?.searchMode !== 'local') {
    addLimitation(limitations, WEB_LIMITATION[task?.webSearchStatus]);
  }

  const policy = artifacts?.plan?.evidencePolicy || inferResearchEvidencePolicy(task);
  if (policy.id === 'general_research' && task?.searchMode !== 'local' && sources.length &&
    !sources.some((source) => source?.kind === 'web')) {
    addLimitation(limitations, {
      code: 'public_evidence_not_included',
      message: '本题采用公开资料主证据策略，但最终 Evidence Pack 未纳入公开来源，结论仅能作为项目案例参考。'
    });
  }

  if (unverifiedPublicSources.length) {
    addLimitation(limitations, {
      code: 'public_source_provenance_unverified',
      message: `有 ${unverifiedPublicSources.length} 条外部来源尚未被确认属于公开一手资料。`
    });
  }

  const evidenceCharacters = Number(artifacts?.evidencePack?.totalCharacters || 0);
  if (sources.length && artifacts.evidencePack && evidenceCharacters < 500) {
    addLimitation(limitations, {
      code: 'thin_evidence_pack',
      message: `最终证据包只有 ${evidenceCharacters} 个字符，报告只能给出简要结论。`
    });
  }

  if (artifacts?.writer?.finishReason === 'length') {
    addLimitation(limitations, {
      code: 'writer_output_truncated',
      message: '报告写作达到输出上限，末尾内容可能不完整。'
    });
  }

  if (!verificationValid) {
    addLimitation(limitations, {
      code: 'citation_verification_failed',
      message: '报告中的引用编号与结构化来源没有完整对应。'
    });
  }

  let quality = 'sufficient';
  if (!sources.length || !verificationValid || coverageRatio === 0) {
    quality = 'insufficient';
  } else if (limitations.length) {
    quality = 'limited';
  }

  return {
    quality,
    limitations,
    metrics: {
      relevantEvidenceCount: sources.length,
      excludedEvidenceCount: Array.isArray(artifacts.excludedSources)
        ? artifacts.excludedSources.length
        : 0,
      unverifiedPublicSourceCount: unverifiedPublicSources.length,
      evidenceCharacters,
      coveredSubquestionCount: coveredCount,
      totalSubquestionCount: subquestions.length,
      coverageRatio: Number(coverageRatio.toFixed(4)),
      citationStructureValid: verificationValid
    }
  };
}
