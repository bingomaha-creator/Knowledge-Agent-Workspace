/**
 * Phase 0 live 评测入口（env-gated，fail closed）：用真实 Qwen Planner/Writer、
 * 真实博查联网 Provider 与真实 SourceReader 执行全部 fixture case，产出基线 JSON。
 *
 * 启用条件（缺一即退出，不产出基线）：RESEARCH_EVAL_LIVE=1、QWEN_API_KEY、
 * BOCHA_API_KEY。运行中任一 case 出现 eval_error/未完成，或 web/hybrid case 的
 * 联网整体不可用/出错时：诊断保留、baseline 标记 valid=false 并以非零码退出——
 * invalid 的基线不得用于 Phase 3 阈值校准。
 *
 * 输出：server/regression/research-eval/baselines/phase0-baseline.json（纳入版本
 * 控制：聚合指标、无敏感 payload；权威留档位置，docs/artifacts 不再保存基线）。
 *
 * 与生产链路的两点已知差异（provenance.deviation 同步记录）：
 * 1. web 检索直接适配真实的 createWebSearchProvider，绕过生产 Search service 与
 *    MCP transport——transport 语义由现有集成测试覆盖；
 * 2. 本地检索为空结果 stub（Phase 0 case 均为空知识库范围）。
 * 因此当前结果只是 **web 为主的探索性基线**：可用于观察真实链路的质量/时延/成本
 * 量级，但不能单独满足 Phase 3 representative 校准前置（还缺真实 local/hybrid
 * 代表样本或等价脱敏回放，见 Plan 歧义 2）。
 *
 * 用法：RESEARCH_EVAL_LIVE=1 node server/regression/research-eval/research-eval-live.js [--case <id>]
 */
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatQwenClient } from '../../infrastructure/qwen-client.js';
import { createResearchStore } from '../../research-store.js';
import { createResearchWorker } from '../../research-worker.js';
import { createResearchAiService } from '../../services/research-ai-service.js';
import { createResearchSourceReader } from '../../services/research-source-reader.js';
import { createResearchRepositoryResolver } from '../../services/research-repository-resolver.js';
import { createWebSearchProvider } from '../../web-search-provider.js';
import { computeCaseMetrics } from './metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

const apiKey = process.env.QWEN_API_KEY || '';
const bochaKey = process.env.BOCHA_API_KEY || '';
const model = process.env.QWEN_MODEL || 'qwen-plus';

function failClosed(reason) {
  console.error(`live 评测未启动（fail closed）：${reason}`);
  process.exit(2);
}

if (process.env.RESEARCH_EVAL_LIVE !== '1') {
  failClosed('需要 RESEARCH_EVAL_LIVE=1 显式启用。');
}
if (!apiKey) {
  failClosed('缺少 QWEN_API_KEY（.env.local）。');
}
if (!bochaKey) {
  failClosed('缺少 BOCHA_API_KEY（.env.local），联网 Provider 将整体不可用。');
}

const caseFilter = (() => {
  const index = process.argv.indexOf('--case');
  return index >= 0 ? process.argv[index + 1] : null;
})();

const casesDir = path.join(here, 'cases');
const caseFileNames = fs.readdirSync(casesDir).filter((name) => name.endsWith('.json')).sort();
const allCases = caseFileNames
  .flatMap((name) => JSON.parse(fs.readFileSync(path.join(casesDir, name), 'utf8')).cases);
const selectedCases = caseFilter ? allCases.filter((item) => item.id === caseFilter) : allCases;
if (!selectedCases.length) {
  failClosed(`没有匹配的评测 case：${caseFilter || '(空 case 集)'}`);
}

function createLiveAdapters(counters) {
  const qwenClient = createChatQwenClient({ apiKey, baseUrl: process.env.QWEN_BASE_URL || undefined });
  const aiService = createResearchAiService({ qwenClient, model, logger: console });
  const sourceReader = createResearchSourceReader();
  const repositoryResolver = createResearchRepositoryResolver();
  const webProvider = createWebSearchProvider();

  return {
    planResearch: async (request) => {
      counters.plannerCalls += 1;
      return aiService.planResearch(request);
    },

    writeResearchReport: async (request) => {
      counters.writerCalls += 1;
      return aiService.writeResearchReport(request);
    },

    readResearchSources: async (request) => {
      const result = await sourceReader.readSelected(request);
      counters.readAttempts += Array.isArray(request.sources) ? request.sources.length : 0;
      counters.readerSuccesses += Array.isArray(result.documents) ? result.documents.length : 0;
      counters.readerFailures += Array.isArray(result.failures) ? result.failures.length : 0;
      return result;
    },

    resolveResearchRepositories: (request) => repositoryResolver.resolveRepositories(request),

    searchSources: async ({ query, searchMode, signal }) => {
      counters.searchCalls += 1;
      // 本地检索 stub：空知识库范围下与生产行为等价（无本地命中），见文件头说明。
      counters.localSearchCalls += 1;
      const localSearch = Promise.resolve({ evidence: [] });

      if (searchMode === 'local') {
        const { evidence } = await localSearch;
        return { local: evidence, web: [], webSearchStatus: 'not_requested' };
      }

      counters.webSearchRequests += 1;
      const webSearch = webProvider.search(query, { topK: 6, signal })
        .then((result) => ({
          available: result.available,
          status: result.status,
          message: result.message || '',
          results: Array.isArray(result.results) ? result.results : []
        }))
        .catch((error) => {
          if (signal?.aborted || error?.name === 'AbortError') throw error;
          return { available: false, status: 'error', message: String(error?.message || error), results: [] };
        });

      const [{ evidence }, web] = await Promise.all([localSearch, webSearch]);
      const webSearchStatus = web.available
        ? 'available'
        : (web.status === 'error' ? 'error' : 'unavailable');
      if (webSearchStatus !== 'available') counters.webSearchDegradedQueries += 1;
      return { local: evidence, web: web.results, webSearchStatus };
    }
  };
}

async function runAll() {
  const metricsList = [];
  for (const testCase of selectedCases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-eval-live-'));
    const dbPath = path.join(dir, 'eval.sqlite');
    try {
      const metrics = await runEvalCase({
        testCase,
        adapters: createLiveAdapters,
        mode: 'live',
        dbPath
      });
      metricsList.push(metrics);
      console.log(`[live] ${metrics.caseId}: status=${metrics.status} quality=${metrics.resultQuality} coverage=${metrics.coverageRatio} latency=${metrics.latencyMs}ms`);
    } catch (error) {
      console.error(`[live] case ${testCase.id} 执行失败：${error?.message || error}`);
      metricsList.push({
        caseId: testCase.id,
        mode: 'live',
        status: 'eval_error',
        error: String(error?.message || error)
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return metricsList;
}

function summarize(metricsList) {
  const completed = metricsList.filter((item) => item.status === 'completed');
  const qualityDistribution = {};
  for (const item of completed) {
    qualityDistribution[item.resultQuality] = (qualityDistribution[item.resultQuality] || 0) + 1;
  }
  const sum = (pick) => completed.reduce((total, item) => total + (pick(item) || 0), 0);
  // 平均只对有值的样本计算：零证据 case 的引用指标为 null，不应把平均拉低。
  const avg = (pick) => {
    const values = completed.map(pick).filter((value) => typeof value === 'number' && Number.isFinite(value));
    return values.length ? Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(4)) : null;
  };

  // Writer 降级观测：模型报告被拒 → 确定性 fallback 接管，是 Phase 1 repair_report 的基线。
  const attempted = completed.filter((item) => item.writerModelAttempted);
  const accepted = attempted.filter((item) => item.writerMode === 'model');
  const fallbacks = attempted.filter((item) => item.writerMode !== 'model');
  const fallbackReasonCodes = {};
  for (const item of fallbacks) {
    const code = item.writerReasonCode || 'unknown';
    fallbackReasonCodes[code] = (fallbackReasonCodes[code] || 0) + 1;
  }

  // Partial Web Search 统计：valid=true 只表示基线整体可用于观察与对比，
  // 不代表每次外部调用都成功——部分降级的 case/request 在此显式计数。
  const partialCases = completed.filter((item) => (item.webSearch?.degradedQueries || 0) > 0);

  return {
    caseCount: metricsList.length,
    completedCount: completed.length,
    qualityDistribution,
    avgLatencyMs: completed.length ? Math.round(sum((item) => item.latencyMs) / completed.length) : null,
    citation: {
      // 引用有效性与证据使用率是两个口径：前者要求被引用的引用全部有效（Ledger 验收口径，
      // 非法数字引用与符号 marker 都计入无效），后者允许候选 citation 不被全部使用。
      avgValidityRate: avg((item) => item.citationValidityRate),
      avgEvidenceUsageRate: avg((item) => item.evidenceUsageRate),
      structureValidCount: completed.filter((item) => item.citationStructureValid).length
    },
    writerFallback: {
      modelAttemptedCount: attempted.length,
      modelAcceptedCount: accepted.length,
      fallbackCount: fallbacks.length,
      fallbackRatio: attempted.length ? Number((fallbacks.length / attempted.length).toFixed(4)) : null,
      fallbackReasonCodes
    },
    webSearch: {
      requestCount: sum((item) => item.externalCalls?.webSearchRequests),
      degradedQueryCount: sum((item) => item.webSearch?.degradedQueries),
      partialCaseCount: partialCases.length,
      partialCaseIds: partialCases.map((item) => item.caseId)
    },
    totals: {
      inputTokens: sum((item) => item.tokens?.inputTokens),
      outputTokens: sum((item) => item.tokens?.outputTokens),
      webSearchRequests: sum((item) => item.externalCalls?.webSearchRequests),
      readerReads: sum((item) => item.externalCalls?.readerSuccesses),
      readerFailures: sum((item) => item.externalCalls?.readerFailures)
    }
  };
}

function invalidReasonsOf(metricsList) {
  const reasons = [];
  for (const item of metricsList) {
    if (item.status === 'eval_error') {
      reasons.push(`case ${item.caseId}: eval_error — ${item.error || '未知错误'}`);
    } else if (item.status !== 'completed') {
      reasons.push(`case ${item.caseId}: 未完成（status=${item.status}，failedStage=${item.failedStage || '-'}）`);
    } else if (item.searchMode !== 'local' && (item.webSearchStatus === 'unavailable' || item.webSearchStatus === 'error')) {
      reasons.push(`case ${item.caseId}: 联网 Provider 整体不可用/出错（webSearchStatus=${item.webSearchStatus}）`);
    }
  }
  return reasons;
}

const { runEvalCase } = await import('./harness.js');
const metricsList = await runAll();
const invalidReasons = invalidReasonsOf(metricsList);
const valid = invalidReasons.length === 0;

function gitInfo() {
  try {
    return {
      sourceCommit: execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim(),
      branch: execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot }).toString().trim()
    };
  } catch {
    return { sourceCommit: 'unknown', branch: 'unknown' };
  }
}

// 工作树 dirty 状态：排除 canonical baseline 自身——重跑并更新它正是本次运行的目的，
// 不能因此把每次基线生成都标成 dirty。
function worktreeStatus() {
  const baselineRel = 'server/regression/research-eval/baselines/phase0-baseline.json';
  try {
    const lines = execSync('git status --porcelain', { cwd: repoRoot }).toString().split('\n').filter(Boolean);
    const dirtyPaths = lines.filter((line) => !line.endsWith(baselineRel)).map((line) => line.slice(3));
    return { worktreeDirty: dirtyPaths.length > 0, dirtyPaths: dirtyPaths.slice(0, 10) };
  } catch {
    return { worktreeDirty: null, dirtyPaths: [] };
  }
}

const fileHash = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
const caseSetHash = fileHash(caseFileNames
  .map((name) => `${name}:${crypto.createHash('sha256').update(fs.readFileSync(path.join(casesDir, name))).digest('hex')}`)
  .join('\n'));
// 实际执行的 case 子集：--case 单查时不得用完整 caseSetHash 描述本次运行。
const selectedCaseIds = selectedCases.map((item) => item.id);
const selectedCaseSetHash = fileHash(selectedCaseIds
  .map((id) => {
    const testCase = selectedCases.find((item) => item.id === id);
    return `${id}:${crypto.createHash('sha256').update(JSON.stringify(testCase)).digest('hex')}`;
  })
  .sort()
  .join('\n'));
const runnerHash = fileHash(['harness.js', 'metrics.js', 'research-eval-live.js']
  .map((name) => `${name}:${crypto.createHash('sha256').update(fs.readFileSync(path.join(here, name))).digest('hex')}`)
  .join('\n'));

const payload = {
  valid,
  invalidReasons,
  generatedAt: new Date().toISOString(),
  provenance: {
    ...gitInfo(),
    ...worktreeStatus(),
    nodeVersion: process.version,
    runnerHash,
    caseSetHash,
    selectedCaseIds,
    selectedCaseSetHash,
    model,
    provider: 'bocha',
    providerConfigured: true,
    config: {
      topK: 6,
      concurrency: 1,
      searchModes: [...new Set(selectedCases.map((item) => item.searchMode))],
      knowledgeBaseScope: 'empty（本地检索为空 stub，见 deviations）'
    },
    deviations: [
      'web 检索直连 createWebSearchProvider，绕过生产 Search service 与 MCP transport',
      'local 检索为空结果 stub（Phase 0 case 均为空知识库范围）'
    ],
    scope: 'web 为主的探索性基线：可观察真实链路的质量/时延/成本量级，不能单独满足 Phase 3 representative 校准前置（缺真实 local/hybrid 代表样本或等价脱敏回放）'
  },
  summary: summarize(metricsList),
  cases: metricsList
};

const outputDir = path.join(here, 'baselines');
fs.mkdirSync(outputDir, { recursive: true });
let outputPath;
if (caseFilter) {
  // --case 单查只写诊断文件，绝不覆盖 canonical baseline。
  const diagDir = path.join(outputDir, 'diagnostics');
  fs.mkdirSync(diagDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  outputPath = path.join(diagDir, `${stamp}_${selectedCaseIds.join('_')}.json`);
} else {
  outputPath = path.join(outputDir, 'phase0-baseline.json');
}
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

console.log(`\n已写入 ${outputPath}（valid=${valid}${caseFilter ? '，诊断文件：不影响 canonical baseline' : '，canonical baseline 已更新'}）`);
console.log(JSON.stringify(payload.summary, null, 2));
if (!valid) {
  console.error(`\nbaseline invalid，不能作为校准依据：\n- ${invalidReasons.join('\n- ')}`);
  process.exitCode = 1;
}
