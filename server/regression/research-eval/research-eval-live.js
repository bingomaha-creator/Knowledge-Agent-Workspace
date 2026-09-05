/**
 * Phase 0 live 评测入口（env-gated）：用真实 Qwen Planner/Writer、真实博查
 * 联网 Provider 与真实 SourceReader 执行全部 fixture case，产出当前质量/时延/
 * 成本基线 JSON（docs/artifacts/research-harness/phase0-baseline.json，本地产物）。
 *
 * 启用条件：RESEARCH_EVAL_LIVE=1 且 .env.local 配置了 QWEN_API_KEY/BOCHA_API_KEY。
 *
 * 与生产链路的两点已知差异（均为有意为之，不影响 Phase 0 度量目标）：
 * 1. web 检索直接适配真实的 createWebSearchProvider，不经过 MCP transport——
 *    transport 语义由现有集成测试覆盖，本入口度量研究质量/时延/成本；
 * 2. 本地检索以空结果 stub 代替——Phase 0 case 全部使用空知识库范围，真实的
 *    本地检索与 MCP 知识链路由既有回归覆盖；生产 search 服务在所有模式下启动
 *    本地检索的偏差（research-search-service.js）已在 Plan Phase 2 记录待修。
 *
 * Captured run 录制暂不实现；若未来实现，须满足 Plan 歧义 2 的脱敏与凭据清除约束。
 * 用法：RESEARCH_EVAL_LIVE=1 node server/regression/research-eval/research-eval-live.js [--case <id>]
 */
import dotenv from 'dotenv';
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

const enabled = process.env.RESEARCH_EVAL_LIVE === '1';
const apiKey = process.env.QWEN_API_KEY || '';
const model = process.env.QWEN_MODEL || 'qwen-plus';

if (!enabled || !apiKey) {
  console.error('live 评测未启用：需要 RESEARCH_EVAL_LIVE=1 且 .env.local 配置 QWEN_API_KEY。');
  process.exit(2);
}

const caseFilter = (() => {
  const index = process.argv.indexOf('--case');
  return index >= 0 ? process.argv[index + 1] : null;
})();

const casesDir = path.join(here, 'cases');
const allCases = fs.readdirSync(casesDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .flatMap((name) => JSON.parse(fs.readFileSync(path.join(casesDir, name), 'utf8')).cases);
const selectedCases = caseFilter ? allCases.filter((item) => item.id === caseFilter) : allCases;
if (!selectedCases.length) {
  console.error(`没有匹配的评测 case：${caseFilter || '(空 case 集)'}`);
  process.exit(2);
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
      metricsList.push({ caseId: testCase.id, mode: 'live', status: 'eval_error', error: String(error?.message || error) });
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
  return {
    caseCount: metricsList.length,
    completedCount: completed.length,
    qualityDistribution,
    avgLatencyMs: completed.length
      ? Math.round(sum((item) => item.latencyMs) / completed.length)
      : null,
    totals: {
      inputTokens: sum((item) => item.tokens?.inputTokens),
      outputTokens: sum((item) => item.tokens?.outputTokens),
      webSearchRequests: sum((item) => item.externalCalls?.webSearchRequests),
      readerReads: sum((item) => item.externalCalls?.readerSuccesses),
      readerFailures: sum((item) => item.externalCalls?.readerFailures)
    },
    avgCitationTraceableRatio: completed.length
      ? Number((sum((item) => item.citationTraceableRatio) / completed.length).toFixed(4))
      : null
  };
}

const { runEvalCase } = await import('./harness.js');
const metricsList = await runAll();
const outputDir = path.join(repoRoot, 'docs/artifacts/research-harness');
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'phase0-baseline.json');
const payload = {
  generatedAt: new Date().toISOString(),
  env: { model, webProvider: 'bocha', claimSupportRate: 'not_evaluated（人工/Judge 口径，Phase 0 无自动化判定）' },
  summary: summarize(metricsList),
  cases: metricsList
};
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`\n基线已写入 ${outputPath}`);
console.log(JSON.stringify(payload.summary, null, 2));
