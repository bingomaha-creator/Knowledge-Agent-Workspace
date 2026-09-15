/**
 * Phase 0 评测基线的输出路径与文件名安全。
 *
 * 约束（Plan Phase 0 执行记录 / Codex 二次评审）：
 * - 完整 case 集运行才允许写 canonical baseline；--case 子集运行只能写
 *   diagnostics 诊断文件，绝不覆盖 canonical。
 * - 诊断文件名包含 caseId：caseId 来自 JSON 内容，必须经过 slug 消毒，
 *   防止路径穿越与异常字符进入文件系统。
 */

const SAFE_ID_PATTERN = /[^a-z0-9_-]+/g;
const MAX_SINGLE_ID_LENGTH = 40;
const MAX_JOINED_LENGTH = 120;

/**
 * 把 caseId 列表消毒成可安全拼进文件名的 slug。
 * 非法字符折叠为 '-'，单段截断到 40 字符，整体截断到 120 字符；空集合回退为 'partial'。
 */
export function slugCaseIds(caseIds) {
  const slugged = (Array.isArray(caseIds) ? caseIds : [])
    .map((id) => String(id || '').toLowerCase().replace(SAFE_ID_PATTERN, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .map((id) => id.slice(0, MAX_SINGLE_ID_LENGTH));
  if (!slugged.length) return 'partial';
  return slugged.join('_').slice(0, MAX_JOINED_LENGTH) || 'partial';
}

/**
 * 解析本次 live 运行/报告生成的输出位置。
 *
 * @param {object} input
 * @param {string} input.baselineDir baselines 目录绝对路径
 * @param {boolean} input.partialRun true 表示 --case 子集运行（只允许 diagnostics）
 * @param {string[]} input.caseIds 实际执行的 caseId（用于诊断文件名）
 * @param {Date} input.timestamp 运行完成时间（诊断文件名时间戳）
 * @param {string} [input.fileName='phase0-baseline.json'] canonical 文件名
 *   （差异报告生成器传 'ledger-would-be-diff-report.json'，守卫语义相同：
 *   子集运行只允许 diagnostics，绝不覆盖 canonical）。
 * @returns {{ path: string, kind: 'canonical' | 'diagnostics' }}
 */
export function resolveBaselineOutputPath({
  baselineDir,
  partialRun,
  caseIds,
  timestamp,
  fileName = 'phase0-baseline.json'
}) {
  if (!baselineDir) throw new TypeError('resolveBaselineOutputPath requires baselineDir');
  if (!partialRun) {
    return { path: `${baselineDir}/${fileName}`, kind: 'canonical' };
  }
  const stamp = (timestamp instanceof Date ? timestamp : new Date())
    .toISOString()
    .replace(/[:.]/g, '-');
  return {
    path: `${baselineDir}/diagnostics/${stamp}_${slugCaseIds(caseIds)}.json`,
    kind: 'diagnostics'
  };
}
