const LIMITATION_PATTERN = /证据不足|未解决|局限|限制/u;

function citedEvidenceIds(report) {
  return [...String(report || '').matchAll(/\[(E\d+)\]/gu)].map((match) => match[1]);
}

export function verifyResearchNewDelivery({ report, tracks, sources, evidence, writerEvidenceIds }) {
  const sourceIds = new Set(sources.map((source) => source.id));
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const cited = citedEvidenceIds(report);
  const failures = [];

  if (evidence.some((item) => !sourceIds.has(item.sourceId))) failures.push('evidence_source_membership');
  if (cited.some((id) => !evidenceIds.has(id))) failures.push('citation_membership');
  if (new Set(writerEvidenceIds).size !== evidenceIds.size
    || writerEvidenceIds.some((id) => !evidenceIds.has(id))) {
    failures.push('writer_input_boundary');
  }
  if (tracks.some((track) => !['answered', 'partial', 'unresolved'].includes(track.status))) {
    failures.push('track_status');
  }
  for (const track of tracks.filter((item) => item.status !== 'unresolved')) {
    const trackEvidence = evidence.filter((item) => item.trackId === track.id).map((item) => item.id);
    if (trackEvidence.length && !trackEvidence.some((id) => cited.includes(id))) {
      failures.push(`track_citation:${track.id}`);
    }
  }
  if (tracks.some((track) => track.status !== 'answered') && !LIMITATION_PATTERN.test(report)) {
    failures.push('unresolved_disclosure');
  }
  if (evidence.length === 0 && (!LIMITATION_PATTERN.test(report) || cited.length > 0)) {
    failures.push('zero_evidence_delivery');
  }
  if (evidence.some((item) => !['workspace', 'web'].includes(item.origin))) {
    failures.push('origin_preservation');
  }
  return { valid: failures.length === 0, failures: [...new Set(failures)], citedEvidenceIds: cited };
}

export function resultQualityFor(tracks, evidence) {
  if (!evidence.length || tracks.every((track) => track.status === 'unresolved')) return 'insufficient';
  if (tracks.every((track) => track.status === 'answered')) return 'sufficient';
  return 'limited';
}
