/**
 * 异步研究领域词汇的唯一来源。
 *
 * Store 用这些值校验持久化状态，Worker 用相同顺序推进流水线，避免两处分别维护
 * 字符串后发生“数据库接受、执行器不认识”的漂移。本模块只描述合法词汇和展示
 * 进度，不执行状态转换；哪些状态能互相转换由 research-store.js 约束。
 */

// 任务级生命周期：queued/running 是非终态，其余三种是终态（重试会重新回到 queued）。
export const RESEARCH_STATUS_VALUES = Object.freeze([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled'
]);

// 顺序即 Worker 的执行顺序；completed 是收尾哨兵，不对应外部检索或写作操作。
export const RESEARCH_STAGE_VALUES = Object.freeze([
  'planning',
  'retrieving',
  'extracting',
  'outlining',
  'writing',
  'verifying',
  'completed'
]);

// local 只查知识库；hybrid 合并本地与联网；web 表示请求联网资料。
export const RESEARCH_SEARCH_MODE_VALUES = Object.freeze([
  'local',
  'hybrid',
  'web'
]);

// 该状态描述联网通道质量，与整个研究任务成功/失败是两个不同维度。
export const RESEARCH_WEB_SEARCH_STATUS_VALUES = Object.freeze([
  'not_requested',
  'pending',
  'available',
  'unavailable',
  'partial',
  'error'
]);

// 结果质量与任务是否成功执行是两个维度。pending 用于尚未形成最终报告的任务；
// completed 任务必须由质量评估器收敛到其余三种状态之一。
export const RESEARCH_RESULT_QUALITY_VALUES = Object.freeze([
  'pending',
  'sufficient',
  'limited',
  'insufficient'
]);

// 进度是阶段级、单调前进的 UI 提示，不是假装精确的剩余时间估算。
export const RESEARCH_STAGE_PROGRESS = Object.freeze({
  planning: 5,
  retrieving: 20,
  extracting: 45,
  outlining: 60,
  writing: 75,
  verifying: 90,
  completed: 99
});
