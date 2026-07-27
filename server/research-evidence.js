import { expandCjkBigrams, tokenize } from './rag-utils.js';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function signals(value) {
  return unique(expandCjkBigrams(tokenize(value)))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1);
}

function paragraphs(content) {
  return String(content || '')
    .replace(/\r/g, '')
    .split(/\n{2,}|(?<=[。！？.!?])\s+/u)
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value) => value.length >= 32)
    .slice(0, 80);
}

function rankPassages(source, content) {
  const wanted = new Set(signals([
    ...(Array.isArray(source.queries) ? source.queries : []),
    source.selectedFor || '',
    ...(Array.isArray(source.facets) ? source.facets : [])
  ].join(' ')));
  return paragraphs(content)
    .map((passage, index) => {
      const passageSignals = new Set(signals(passage));
      const overlap = [...wanted].filter((token) => passageSignals.has(token)).length;
      return { passage, index, overlap };
    })
    .sort((left, right) => right.overlap - left.overlap || left.index - right.index)
    .slice(0, 2)
    .map((item) => item.passage.slice(0, 1_600));
}

function claimFromPassage(passage) {
  const normalized = String(passage || '').trim();
  const sentence = normalized.match(/^.{1,360}?[.!?。！？](?:\s|$)/u)?.[0];
  return (sentence || normalized.slice(0, 360)).trim();
}

/**
 * Source 与 Passage 解耦：同一来源可贡献多段证据，但报告引用仍共享一个 [n]。
 * 完整正文只在内存参与筛选，artifacts 仅保存入选段落与读取诊断。
 */
export function assembleResearchEvidence({
  sources,
  documents,
  maxPassages = 12
}) {
  const documentBySource = new Map(
    (Array.isArray(documents) ? documents : []).map((document) => [document.sourceId, document])
  );
  const citations = [];
  const evidence = [];

  for (const source of Array.isArray(sources) ? sources : []) {
    if (evidence.length >= maxPassages) break;
    const citationNumber = citations.length + 1;
    const citation = {
      id: `${source.kind || 'source'}-${source.id || `research-citation-${citationNumber}`}`,
      index: citationNumber,
      title: source.title,
      url: source.url,
      snippet: source.snippet,
      source: source.source,
      kind: source.kind,
      knowledgeBaseId: source.knowledgeBaseId,
      documentId: source.documentId,
      sourceKind: source.sourceKind,
      discoveryMethod: source.discoveryMethod,
      sourceType: source.sourceType,
      provenance: source.provenance,
      sourceDomain: source.sourceDomain,
      publishedAt: source.publishedAt,
      providerRank: source.providerRank,
      score: source.score,
      retrieval: source.retrieval,
      queries: [...(source.queries || [])]
    };
    const document = documentBySource.get(source.id);
    const content = document?.content || source.snippet;
    const selected = rankPassages(source, content);
    const selectedPassages = selected.length ? selected : [String(source.snippet || '').slice(0, 1_000)];
    const usable = selectedPassages.filter(Boolean).slice(0, maxPassages - evidence.length);
    if (!usable.length) continue;
    citations.push(citation);
    usable.forEach((passage, passageIndex) => {
      evidence.push({
        id: `${citation.id}-passage-${passageIndex + 1}`,
        citationId: citation.id,
        citationNumber,
        claim: claimFromPassage(passage),
        passage,
        snippet: passage,
        sourceId: source.id,
        title: source.title,
        kind: source.kind,
        provenance: source.provenance,
        sourceType: source.sourceType,
        subquestionId: source.subquestionId || '',
        facets: Array.isArray(source.facets) ? source.facets : [],
        queries: [...(source.queries || [])],
        readerKind: document?.readerKind || 'search_snippet'
      });
    });
  }

  return {
    citations,
    evidence,
    diagnostics: {
      citationCount: citations.length,
      passageCount: evidence.length,
      totalCharacters: evidence.reduce((sum, item) => sum + item.passage.length, 0),
      readPassageCount: evidence.filter((item) => item.readerKind !== 'search_snippet').length,
      snippetFallbackCount: evidence.filter((item) => item.readerKind === 'search_snippet').length
    }
  };
}
