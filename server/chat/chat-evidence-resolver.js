/**
 * Chat 对资料库证据的准入规则。
 *
 * KnowledgeService 负责“召回并排序”，本模块只回答“这些候选能否作为本轮回答的
 * 可信资料”。这样 ChatOrchestrator 不需要理解向量/FTS 的实现细节，也不会把所有
 * 召回结果直接塞进模型上下文。
 */

import { expandCjkBigrams, tokenize } from '../rag-utils.js';

const COMMON_QUERY_SIGNALS = new Set([
  '什么', '如何', '哪些', '为什么', '是否', '当前', '相关', '问题', '内容', '信息',
  '项目', '技术', '代码', '文档', '系统', '功能', '回答', '这个', '那个', '这些',
  '我的', '你的', '我们', '他们', '帮助', '说明', '介绍', '怎么', '怎样', '是一', '一个',
  '是一个', 'what',
  'which', 'why', 'how', 'current', 'project', 'code', 'docs', 'document', 'system'
]);

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function evidenceSignals(value) {
  return unique(expandCjkBigrams(tokenize(value)))
    .map((signal) => signal.toLowerCase())
    .filter((signal) => signal.length > 1);
}

function sourceText(citation) {
  return [
    citation?.title,
    citation?.snippet,
    ...(Array.isArray(citation?.headingPath) ? citation.headingPath : [])
  ].filter(Boolean).join('\n').toLowerCase();
}

function hasMeaningfulPhraseOverlap(query, source) {
  const normalizedQuery = String(query || '').toLowerCase();
  const cjkRuns = String(source || '').match(/[\u4e00-\u9fff]{3,}/g) || [];
  for (const run of cjkRuns) {
    const length = Math.min(8, run.length);
    for (let start = 0; start <= run.length - 3; start += 1) {
      for (let size = 3; size <= Math.min(length, run.length - start); size += 1) {
        const phrase = run.slice(start, start + size);
        if (!COMMON_QUERY_SIGNALS.has(phrase) && normalizedQuery.includes(phrase)) return true;
      }
    }
  }
  return false;
}

function hasKeywordEvidence(citation) {
  return Array.isArray(citation?.retrieval?.sources)
    && citation.retrieval.sources.includes('keyword');
}

/**
 * 关键词通道只说明“检索时有匹配”，不代表片段足以支撑本轮结论。
 * 例如“你记得我的偏好吗”可能与 README 中的“技术”偶然重叠；这里要求至少一个
 * 非通用的 query signal 也出现在标题、正文或章节路径里，才允许它成为可引用证据。
 * 对长中文句子，单个双字组（例如“一个”）极易偶然重叠，因此必须至少命中两个；
 * 只有明确的三字以上短语或短查询可以用单个命中通过。
 */
function hasQuerySpecificEvidence(citation, query) {
  const querySignals = evidenceSignals(query)
    .filter((signal) => !COMMON_QUERY_SIGNALS.has(signal));
  if (!querySignals.length) return false;
  const text = sourceText(citation);
  const sourceSignals = new Set(evidenceSignals(text));
  const matchedSignals = querySignals.filter((signal) => sourceSignals.has(signal));
  const directSignals = tokenize(query)
    .map((signal) => signal.toLowerCase())
    .filter((signal) => signal.length > 1 && !COMMON_QUERY_SIGNALS.has(signal));

  return hasMeaningfulPhraseOverlap(query, text)
    || directSignals.some((signal) => sourceSignals.has(signal))
    || matchedSignals.length >= (querySignals.length <= 2 ? 1 : 2);
}

function safeCitationCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * 已启用 RAG 且资料范围内存在 ready 文档时，本轮必须先做一次受控检索。
 * 不再根据问题表面是否出现“知识库/文档”等词决定，避免项目事实类问题漏检索。
 */
export function shouldResolveScopedKnowledge({
  retrievalEnabled,
  hasReadyKnowledge,
  query
}) {
  return Boolean(retrievalEnabled && hasReadyKnowledge && String(query || '').trim());
}

/**
 * 第一版采用保守证据门：至少要有关键词通道命中，才允许资料片段进入模型上下文。
 *
 * 这并不否定向量检索；它仍参与混合排序、保留在 trace 中。只是当前没有校准过
 * embedding 分数阈值时，不能把“仅语义相近”的片段伪装成可引用证据。后续可依据
 * eval 结果为 vector-only 候选加入经验证的阈值，而不改变调用方接口。
 */
export function resolveChatKnowledgeEvidence({
  citations,
  retrievalTrace,
  query = '',
  isError = false
}) {
  const candidates = Array.isArray(citations) ? citations : [];
  const keywordCandidates = candidates.filter(hasKeywordEvidence);
  const querySpecificKeywordCandidates = keywordCandidates.filter((citation) =>
    hasQuerySpecificEvidence(citation, query)
  );
  const admitted = isError ? [] : querySpecificKeywordCandidates.slice(0, 4);
  const candidateCount = safeCitationCount(candidates);
  const filteredCount = Math.max(0, candidateCount - admitted.length);
  let status = 'evidence_gap';
  let reason = 'no_candidates';

  if (isError) {
    status = 'unavailable';
    reason = 'retrieval_error';
  } else if (admitted.length) {
    status = 'evidence';
    reason = admitted.some((citation) => citation.retrieval?.sources?.includes('vector'))
      ? 'hybrid_match'
      : 'lexical_match';
  } else if (candidateCount) {
    reason = 'weak_candidates';
  }

  return {
    status,
    citations: admitted,
    trace: {
      policyVersion: 'chat-evidence-v3',
      status,
      reason,
      candidateCount,
      selectedCount: admitted.length,
      filteredCount,
      // 只存来源类型与数量，不把被拒绝片段正文写进运行记录。
      channels: {
        keywordCandidates: keywordCandidates.length,
        querySpecificKeywordCandidates: querySpecificKeywordCandidates.length,
        vectorOnlyCandidates: candidates.filter((citation) =>
          citation?.retrieval?.sources?.includes('vector') && !hasKeywordEvidence(citation)
        ).length,
        degradedChannels: Array.isArray(retrievalTrace?.degradedChannels)
          ? retrievalTrace.degradedChannels
          : []
      }
    }
  };
}

export function describeKnowledgeEvidence(trace) {
  if (trace?.status === 'evidence') {
    return `已采用 ${trace.selectedCount} 个可信资料片段，过滤 ${trace.filteredCount} 个弱候选。`;
  }
  if (trace?.status === 'unavailable') {
    return '资料库检索暂不可用，本轮未注入资料片段。';
  }
  if (trace?.reason === 'weak_candidates') {
    return `检索到 ${trace.candidateCount} 个候选，但均未达到证据准入条件。`;
  }
  return '当前资料范围内未找到可用证据。';
}
