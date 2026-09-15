const RRF_K = 60;
const CHANNEL_ORDER = ['exact', 'fts', 'vector'];

function collapseChannel(matches) {
  const byDocument = new Map();
  for (const match of matches || []) {
    const existing = byDocument.get(match.documentId);
    if (!existing) {
      byDocument.set(match.documentId, {
        best: match,
        matches: [match]
      });
      continue;
    }
    existing.matches.push(match);
    if (match.rank < existing.best.rank) existing.best = match;
  }
  return byDocument;
}

function citationFromMatch(match, channel) {
  if (!match.chunk) return null;
  return {
    id: match.chunk.id,
    documentId: match.documentId,
    knowledgeBaseId: match.chunk.knowledgeBaseId,
    headingPath: match.chunk.headingPath || [],
    snippet: match.chunk.text,
    channel,
    rank: match.rank,
    ...(typeof match.bm25Score === 'number' ? { bm25Score: match.bm25Score } : {}),
    ...(typeof match.vectorScore === 'number' ? { vectorScore: match.vectorScore } : {})
  };
}

function exactTier(match) {
  if (!match) return 3;
  if (match.fullSignature && match.contextCompatible === true) return 0;
  if (match.fullSignature && match.contextCompatible === null) return 1;
  return 2;
}

function scopePriority(bugCase, preferredProjectRef) {
  if (!preferredProjectRef) return 0;
  if (bugCase.scope === 'project' && bugCase.sourceProjectRef === preferredProjectRef) return 0;
  if (bugCase.scope === 'common') return 1;
  return 2;
}

/**
 * 三个通道先各自按 documentId 折叠，再把 document rank 输入 RRF。这样一个长 BugCase
 * 即使命中很多 chunk，也只获得一次该通道名次，不会挤掉其他候选或与 exact 文档身份错位。
 */
export function rankBugCases({
  bugCases,
  exactMatches = [],
  keywordMatches = [],
  vectorMatches = [],
  preferredProjectRef,
  topK = 5
}) {
  const casesById = new Map((bugCases || []).map((bugCase) => [bugCase.id, bugCase]));
  const channels = {
    exact: collapseChannel(exactMatches),
    fts: collapseChannel(keywordMatches),
    vector: collapseChannel(vectorMatches)
  };
  const candidateIds = new Set();
  for (const channel of Object.values(channels)) {
    for (const id of channel.keys()) {
      if (casesById.has(id)) candidateIds.add(id);
    }
  }

  const ranked = [...candidateIds].map((documentId) => {
    const bugCase = casesById.get(documentId);
    const exact = channels.exact.get(documentId)?.best;
    const matchedChannels = CHANNEL_ORDER.filter((channel) => channels[channel].has(documentId));
    const rrfScore = matchedChannels.reduce(
      (score, channel) => score + 1 / (RRF_K + channels[channel].get(documentId).best.rank),
      0
    );
    const citations = [];
    const citationIds = new Set();
    for (const channel of ['fts', 'vector']) {
      const collapsed = channels[channel].get(documentId);
      for (const match of (collapsed?.matches || []).sort((a, b) => a.rank - b.rank).slice(0, 3)) {
        const citation = citationFromMatch(match, channel);
        if (!citation || citationIds.has(citation.id)) continue;
        citationIds.add(citation.id);
        citations.push(citation);
      }
    }
    return {
      bugCase,
      matchedChannels,
      citations,
      rrfScore,
      exactTier: exactTier(exact),
      scopePriority: scopePriority(bugCase, preferredProjectRef)
    };
  }).sort((left, right) =>
    left.exactTier - right.exactTier
    || left.scopePriority - right.scopePriority
    || right.rrfScore - left.rrfScore
    || left.bugCase.id.localeCompare(right.bugCase.id)
  );

  const ambiguityGroups = new Map();
  for (const match of exactMatches.filter((item) => item.contextCompatible !== false)) {
    const key = match.ambiguityKey || match.matchedSignature || '__same-signature__';
    if (!ambiguityGroups.has(key)) ambiguityGroups.set(key, []);
    ambiguityGroups.get(key).push(match);
  }
  const ambiguous = [...ambiguityGroups.values()].some((matches) => {
    const compatible = matches.filter((match) => match.contextCompatible === true);
    return compatible.length > 1 || (compatible.length === 0 && matches.length > 1);
  });

  return {
    results: ranked.slice(0, Math.max(1, Math.min(20, Number(topK) || 5))).map(
      ({ exactTier: _exactTier, scopePriority: _scopePriority, rrfScore, ...result }, index) => ({
        ...result,
        rank: index + 1,
        score: Number(rrfScore.toFixed(6))
      })
    ),
    trace: { ambiguous }
  };
}
