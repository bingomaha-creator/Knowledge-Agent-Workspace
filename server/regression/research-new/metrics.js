export const RESEARCH_NEW_METRICS = Object.freeze({
  requiredTrackCoverage: '必答 Track 中 answered 的比例',
  fullTextEvidenceRate: '入选 Evidence 中来自 full_text/partial_text 的比例',
  snippetEvidenceRate: '入选 Evidence 中来自 search_snippet 的比例',
  citationValidityRate: '报告引用中可映射到本轮 Evidence 的比例',
  lineageCompletenessRate: 'Evidence 可回溯到本轮 SourceDocument 的比例',
  replanCoverageDelta: 'Targeted Replan 后 required Track 覆盖率的变化',
  unresolvedDisclosureRate: 'partial/unresolved Track 在报告中披露的比例',
  sourceOriginIntegrityRate: 'Workspace/Web 来源类别保持正确的比例',
  webSearchCalls: '实际发起的 Web Search 次数',
  webReadSuccessRate: '实际尝试读取的 Web 来源中成功取得正文的比例',
  modelCalls: '本轮实际模型调用次数',
  durationMs: 'Run 总耗时'
});

export function safeRatio(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  if (!Number.isFinite(numerator) || numerator < 0) return null;
  return Number((numerator / denominator).toFixed(4));
}
