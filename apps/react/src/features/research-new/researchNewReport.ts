export function linkReportEvidence(report: string, evidenceIds: string[]) {
  const known = new Set(evidenceIds);
  const citedIds: string[] = [];
  const content = report.replace(/`?\[(ev_[\w-]+|E\d+)\]`?(?!\()/g, (original, id: string) => {
    if (!known.has(id)) return original;
    let number = citedIds.indexOf(id) + 1;
    if (!number) {
      citedIds.push(id);
      number = citedIds.length;
    }
    return `[${number}](#evidence-${id})`;
  });
  return { content, citedIds };
}
