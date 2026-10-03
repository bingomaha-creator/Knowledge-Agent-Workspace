import { createHash } from 'node:crypto';

export const RESEARCH_WEB_DISCOVERY_CAPABILITIES = Object.freeze({
  provider: 'unknown',
  domainFilter: false,
  temporalFilter: false,
  freshness: false,
  sourceTraits: false,
  queryOperators: false,
  fullText: false
});

function sourceId(...parts) {
  return `source-${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 20)}`;
}

function webCandidate(item, trackId, query) {
  const url = String(item?.url || '');
  return {
    id: sourceId(trackId, 'web', url || item?.id),
    trackId,
    origin: 'web',
    title: String(item?.title || '').slice(0, 500),
    url,
    snippet: String(item?.snippet || '').slice(0, 2000),
    rawContent: typeof item?.rawContent === 'string' ? item.rawContent : undefined,
    rawContentComplete: item?.rawContentComplete === true,
    query,
    sourceKind: String(item?.sourceKind || 'public_web'),
    sourceDomain: String(item?.sourceDomain || (() => {
      try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
    })()),
    publishedAt: String(item?.publishedAt || ''),
    providerRank: Number(item?.providerRank) || 0
  };
}

function workspaceCandidate(item, trackId, query) {
  const chunkId = String(item?.id || '');
  const knowledgeBaseId = String(item?.knowledgeBaseId || '');
  return {
    id: sourceId(trackId, 'workspace', knowledgeBaseId, item?.documentId, chunkId),
    trackId,
    origin: 'workspace',
    title: String(item?.title || '').slice(0, 500),
    snippet: String(item?.snippet || '').slice(0, 2000),
    content: String(item?.snippet || '').slice(0, 2000),
    query,
    sourceKind: 'project_knowledge',
    knowledgeBaseId,
    documentId: String(item?.documentId || ''),
    chunkId
  };
}

function normalized(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
}

function anchorTokens(value) {
  return normalized(value).match(/[\p{L}\p{N}][\p{L}\p{N}_.+-]*/gu) || [];
}

function sourceAnchors(brief) {
  const comparisonValues = [brief?.comparison?.left, brief?.comparison?.right].filter(Boolean);
  const values = comparisonValues.length ? comparisonValues : [];
  if (!comparisonValues.length) {
    for (const entity of brief?.entities || []) {
      values.push(entity?.name, ...(entity?.aliases || []));
    }
  }
  return values
    .map(anchorTokens)
    .filter((tokens) => tokens.length > 0);
}

const QUERY_SCREENING_STOPWORDS = new Set([
  'and', 'for', 'from', 'how', 'official', 'source', 'the', 'with',
  '公开', '外部', '官方', '来源', '资料'
]);

function queryRelevanceTokens(query) {
  return [...new Set(anchorTokens(query).filter((token) => (
    !QUERY_SCREENING_STOPWORDS.has(token)
      && (/[^a-z0-9_.+-]/u.test(token) || token.length >= 4)
  )))];
}

function matchesCurrentQuery(haystack, query) {
  const tokens = queryRelevanceTokens(query);
  if (!tokens.length) return false;
  const haystackTokens = new Set(anchorTokens(haystack));
  const matched = tokens.filter((token) => (
    /^[a-z0-9][a-z0-9_.+-]*$/u.test(token)
      ? haystackTokens.has(token)
      : haystack.includes(token)
  ));
  return matched.length >= Math.min(2, tokens.length);
}

function outsideTemporalScope(publishedAt, temporalScope) {
  if (!publishedAt || !temporalScope) return false;
  const published = Date.parse(publishedAt);
  if (!Number.isFinite(published)) return false;
  const from = temporalScope.from ? Date.parse(temporalScope.from) : NaN;
  const to = temporalScope.to ? Date.parse(temporalScope.to) : NaN;
  return (Number.isFinite(from) && published < from)
    || (Number.isFinite(to) && published > to);
}

function requestedDomain(query) {
  const match = String(query || '').match(/\bsite\s*:\s*([a-z0-9.-]+)/iu);
  if (!match) return '';
  try {
    return new URL(`https://${match[1]}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function screeningScore(source, anchors, brief, domainConstraint, query, mode) {
  if (source.origin === 'workspace') return { accepted: true, score: 100, reason: 'workspace_scope' };
  if (domainConstraint && source.sourceDomain !== domainConstraint
    && !source.sourceDomain.endsWith(`.${domainConstraint}`)) {
    return { accepted: false, score: 0, reason: 'domain_mismatch' };
  }
  const haystack = normalized([
    source.title,
    source.snippet,
    source.url,
    source.publishedAt
  ].filter(Boolean).join(' '));
  const haystackTokens = new Set(anchorTokens(haystack));
  const matchingAnchors = anchors.filter((tokens) => tokens.every((token) => (
    /^[a-z0-9][a-z0-9_.+-]*$/u.test(token)
      ? haystackTokens.has(token)
      : haystack.includes(token)
  )));
  if (anchors.length && matchingAnchors.length === 0) {
    if (mode !== 'hybrid' || !matchesCurrentQuery(haystack, query)) {
      return { accepted: false, score: 0, reason: 'entity_mismatch' };
    }
    return {
      accepted: true,
      score: 5 + (['official_docs', 'official_repo', 'paper', 'standard'].includes(source.sourceKind) ? 20 : 0)
        - Math.max(0, source.providerRank || 0),
      reason: 'track_query_match'
    };
  }
  if (outsideTemporalScope(source.publishedAt, brief?.temporalScope)) {
    return { accepted: false, score: 0, reason: 'temporal_mismatch' };
  }
  const sourceKindScore = ['official_docs', 'official_repo', 'paper', 'standard'].includes(source.sourceKind)
    ? 20
    : 0;
  return {
    accepted: true,
    score: matchingAnchors.length * 10 + sourceKindScore - Math.max(0, source.providerRank || 0),
    reason: matchingAnchors.length ? 'entity_match' : 'no_explicit_anchor'
  };
}

function screenSources(sources, brief, query, mode) {
  const anchors = sourceAnchors(brief);
  const domainConstraint = requestedDomain(query);
  const seen = new Set();
  const accepted = [];
  const rejected = [];
  for (const source of sources) {
    const duplicateKey = source.origin === 'web'
      ? `web:${source.url}`
      : `workspace:${source.knowledgeBaseId}:${source.documentId}:${source.chunkId}`;
    if (seen.has(duplicateKey)) {
      rejected.push({ sourceId: source.id, reason: 'duplicate' });
      continue;
    }
    seen.add(duplicateKey);
    const result = screeningScore(source, anchors, brief, domainConstraint, query, mode);
    if (!result.accepted) {
      rejected.push({ sourceId: source.id, reason: result.reason });
      continue;
    }
    accepted.push({ source, score: result.score, reason: result.reason });
  }
  accepted.sort((left, right) => right.score - left.score
    || (left.source.providerRank || 0) - (right.source.providerRank || 0)
    || left.source.id.localeCompare(right.source.id));
  return {
    sources: accepted.map((item) => item.source),
    screening: {
      accepted: accepted.map((item) => ({ sourceId: item.source.id, reason: item.reason })),
      rejected
    }
  };
}

function constraintDegradations({ query, brief, capabilities }) {
  const degradations = [];
  if (/\bsite\s*:/iu.test(query) && !capabilities.domainFilter) {
    degradations.push({ constraint: 'domain_filter', reason: 'provider_unsupported' });
  }
  if (brief?.temporalScope && !capabilities.temporalFilter) {
    degradations.push({ constraint: 'temporal_scope', reason: 'provider_unsupported' });
  }
  if (brief?.preferredSourceTraits?.length && !capabilities.sourceTraits) {
    degradations.push({ constraint: 'source_traits', reason: 'provider_unsupported' });
  }
  return degradations;
}

function freshnessTimeRange(value) {
  if (value === 'current') return 'month';
  if (value === 'recent') return 'year';
  return undefined;
}

export function createResearchNewSearch({ knowledgeSearch, webSearchProvider }) {
  if (!knowledgeSearch?.searchEvidence || !webSearchProvider?.search) {
    throw new TypeError('Research New Search 需要 Knowledge Search 与 Web Search Provider');
  }
  const configuredCapabilities = {
    ...RESEARCH_WEB_DISCOVERY_CAPABILITIES,
    ...(webSearchProvider.capabilities || {})
  };

  async function search({ trackId, query, track, mode, knowledgeBaseIds, brief, signal }) {
    const normalizedQuery = String(query || '').trim().slice(0, 500);
    const workspaceQuery = [
      track?.question || normalizedQuery,
      ...(Array.isArray(track?.evidenceRequirements) ? track.evidenceRequirements.slice(0, 2) : [])
    ].map((value) => String(value || '').trim()).filter(Boolean).join(' ').slice(0, 500);
    const domain = requestedDomain(normalizedQuery);
    const webPromise = webSearchProvider.search(normalizedQuery, {
      topK: 5,
      signal,
      includeDomains: domain ? [domain] : undefined,
      startDate: brief?.temporalScope?.from,
      endDate: brief?.temporalScope?.to,
      timeRange: freshnessTimeRange(brief?.temporalScope?.freshness)
    });
    const workspacePromise = mode === 'hybrid'
      ? knowledgeSearch.searchEvidence({
        query: workspaceQuery,
        knowledgeBaseIds,
        limit: 6,
        signal
      })
      : Promise.resolve({ evidence: [] });

    const [webResult, workspaceResult] = await Promise.all([webPromise, workspacePromise]);
    if (signal?.aborted) throw signal.reason;
    const webStatus = webResult?.available === false
      ? 'unavailable'
      : webResult?.status === 'success'
        ? 'available'
        : 'error';
    const candidates = [
      ...(Array.isArray(workspaceResult?.evidence) ? workspaceResult.evidence : [])
        .map((item) => workspaceCandidate(item, trackId, workspaceQuery)),
      ...(Array.isArray(webResult?.results) ? webResult.results : [])
        .map((item) => webCandidate(item, trackId, normalizedQuery))
    ];
    const screened = screenSources(candidates, brief, normalizedQuery, mode);
    const providerCapabilities = {
      ...configuredCapabilities,
      ...(webResult?.capabilities || {})
    };
    return {
      query: normalizedQuery,
      webStatus,
      providerCapabilities,
      constraintDegradations: constraintDegradations({
        query: normalizedQuery,
        brief,
        capabilities: providerCapabilities
      }),
      screening: screened.screening,
      sources: screened.sources
    };
  }

  async function buildWorkspaceContext({ question, knowledgeBaseIds, signal }) {
    const result = await knowledgeSearch.searchEvidence({
      query: String(question || '').trim().slice(0, 1000),
      knowledgeBaseIds,
      limit: 6,
      signal
    });
    return (Array.isArray(result?.evidence) ? result.evidence : []).map((item) => ({
      knowledgeBaseId: String(item.knowledgeBaseId || ''),
      documentId: String(item.documentId || ''),
      chunkId: String(item.id || ''),
      title: String(item.title || '').slice(0, 300),
      snippet: String(item.snippet || '').slice(0, 1000)
    }));
  }

  return { search, buildWorkspaceContext };
}
