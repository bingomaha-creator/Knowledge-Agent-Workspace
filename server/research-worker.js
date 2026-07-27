/**
 * 异步深度研究的轻量执行器与进程内队列。
 *
 * Worker 按固定阶段把一个大问题拆成计划、检索、证据、大纲、写作和引用校验，
 * 每一步的 artifacts 都经 Store 持久化，因此页面刷新或进程重启后仍可续跑。
 * 本模块不拥有任务真相：SQLite 状态机才是权威；内存中的 active/pending 只负责
 * 当前进程调度。第一版也不做定时任务、分布式锁、模型审稿回炉或语义事实核验。
 */
import {
  RESEARCH_STAGE_PROGRESS,
  RESEARCH_STAGE_VALUES,
  RESEARCH_WEB_SEARCH_STATUS_VALUES
} from './research-domain.js';
import {
  assessResearchQuality,
  inferResearchEvidencePolicy,
  screenResearchSources,
  selectResearchEvidence
} from './research-quality.js';
import {
  createFallbackResearchPlan,
  normalizeResearchPlan
} from './services/research-ai-service.js';
import { assembleResearchEvidence } from './research-evidence.js';
import { buildOutline, buildSections, verifyReport } from './research-report.js';

const WEB_SEARCH_STATUSES = new Set(RESEARCH_WEB_SEARCH_STATUS_VALUES);

// 使用专用错误类型把“用户主动取消”与真正执行失败分开，避免误写 failed。
class ResearchCancelledError extends Error {
  constructor() {
    super('研究任务已取消');
    this.name = 'ResearchCancelledError';
    this.code = 'RESEARCH_CANCELLED';
  }
}

function nextTurn() {
  // 阶段之间主动让出事件循环，使取消请求/进度轮询有机会被处理。
  return new Promise((resolve) => setImmediate(resolve));
}

function readableError(error) {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error || '研究任务失败');
  }
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeQuestion(question) {
  return String(question || '').replace(/\s+/g, ' ').trim();
}

/**
 * 报告只接受 HTTPS 来源链接。即使检索适配器返回 javascript:/http:/畸形 URL，
 * 最终 Markdown 也只显示标题文本，不生成可点击的不安全链接。
 */
function safeSourceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function sourceChannel(value, fallback) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'web' || normalized === 'internet' || normalized === '联网') {
    return 'web';
  }
  return fallback;
}

function normalizeSource(source, context) {
  // 统一本地知识库与联网 provider 的不同字段名，输出后续阶段唯一的 Source 形状。
  if (!source || typeof source !== 'object') return null;
  const snippet = String(
    source.snippet ?? source.text ?? source.content ?? source.excerpt ?? ''
  ).replace(/\s+/g, ' ').trim().slice(0, 1000);
  const title = String(
    source.title ?? source.documentName ?? source.name ?? '未命名资料'
  ).trim().slice(0, 240);
  if (!snippet && !title) return null;

  const channel = sourceChannel(source.kind ?? source.channel ?? source.source, context.channel);
  const rawId = String(source.id ?? source.chunkId ?? source.documentId ?? '').trim();
  const retrieval = source.retrieval && typeof source.retrieval === 'object'
    ? {
      vectorScore: Number.isFinite(Number(source.retrieval.vectorScore))
        ? Number(source.retrieval.vectorScore)
        : undefined,
      lexicalScore: Number.isFinite(Number(source.retrieval.lexicalScore))
        ? Number(source.retrieval.lexicalScore)
        : undefined,
      bm25Score: Number.isFinite(Number(source.retrieval.bm25Score))
        ? Number(source.retrieval.bm25Score)
        : undefined,
      rrfScore: Number.isFinite(Number(source.retrieval.rrfScore))
        ? Number(source.retrieval.rrfScore)
        : undefined,
      sources: Array.isArray(source.retrieval.sources)
        ? uniqueStrings(source.retrieval.sources)
        : undefined
    }
    : undefined;
  return {
    id: rawId || `${channel}-source-${context.queryIndex + 1}-${context.sourceIndex + 1}`,
    title,
    url: safeSourceUrl(source.url ?? source.link),
    snippet,
    source: String(source.source || (channel === 'web' ? 'web' : '本地知识库')),
    kind: channel,
    knowledgeBaseId: typeof source.knowledgeBaseId === 'string'
      ? source.knowledgeBaseId
      : '',
    documentId: typeof source.documentId === 'string' ? source.documentId : '',
    sourceKind: String(
      source.sourceKind || (channel === 'web' ? 'public_web' : 'project_knowledge')
    ).trim().slice(0, 80),
    sourceDomain: String(source.sourceDomain || '').trim().slice(0, 240),
    publishedAt: String(source.publishedAt || '').trim().slice(0, 80),
    providerRank: Number.isInteger(Number(source.providerRank))
      ? Math.max(1, Number(source.providerRank))
      : undefined,
    discoveryMethod: String(source.discoveryMethod || '').trim().slice(0, 80),
    score: Number.isFinite(Number(source.score)) ? Number(source.score) : undefined,
    retrieval,
    queries: [context.query]
  };
}

function appendSources(target, values, channel, query, queryIndex) {
  if (!Array.isArray(values)) return;
  for (let sourceIndex = 0; sourceIndex < values.length; sourceIndex += 1) {
    const normalized = normalizeSource(values[sourceIndex], {
      channel,
      query,
      queryIndex,
      sourceIndex
    });
    if (normalized) target.push(normalized);
  }
}

function normalizeSearchResult(result, request) {
  // 兼容数组、local/web 分组和通用 results/sources；兼容逻辑集中在检索边界。
  const sources = [];
  let explicitStatus = '';

  if (Array.isArray(result)) {
    appendSources(sources, result, 'local', request.query, request.queryIndex);
  } else if (result && typeof result === 'object') {
    appendSources(sources, result.local, 'local', request.query, request.queryIndex);
    appendSources(sources, result.localResults, 'local', request.query, request.queryIndex);
    appendSources(sources, result.web, 'web', request.query, request.queryIndex);
    appendSources(sources, result.webResults, 'web', request.query, request.queryIndex);
    appendSources(sources, result.sources, 'local', request.query, request.queryIndex);
    appendSources(sources, result.results, 'local', request.query, request.queryIndex);
    appendSources(sources, result.citations, 'local', request.query, request.queryIndex);

    const proposedStatus = result.webSearchStatus ?? result.providerStatus;
    if (WEB_SEARCH_STATUSES.has(proposedStatus)) {
      explicitStatus = proposedStatus;
    } else if (result.available === false) {
      explicitStatus = 'unavailable';
    }
  }

  if (request.searchMode === 'local') {
    explicitStatus = 'not_requested';
  } else if (!explicitStatus) {
    explicitStatus = sources.some((source) => source.kind === 'web')
      ? 'available'
      : 'unavailable';
  }

  return { sources, webSearchStatus: explicitStatus };
}

/**
 * 汇总多个子问题的联网状态。只要同时出现可用和不可用就标为 partial；这不让整个
 * 研究失败，因为 hybrid 模式仍可用本地证据完成一份明确降级的报告。
 */
function mergeWebSearchStatuses(searchMode, statuses) {
  if (searchMode === 'local') return 'not_requested';
  if (statuses.includes('partial')) return 'partial';

  const hasAvailable = statuses.includes('available');
  const hasUnavailable = statuses.includes('unavailable') || statuses.includes('error');
  if (hasAvailable && hasUnavailable) return 'partial';
  if (hasAvailable) return 'available';
  if (statuses.includes('error')) return 'error';
  return 'unavailable';
}

function deduplicateSources(sources) {
  // 联网来源优先按规范化 URL 去重；无 URL 的本地块按 kind/id 去重，并合并命中 query。
  const deduplicated = new Map();
  for (const source of sources) {
    const key = source.url
      ? `url:${source.url}`
      : `${source.kind}:${source.id || `${source.title}:${source.snippet}`}`;
    const existing = deduplicated.get(key);
    if (existing) {
      existing.queries = uniqueStrings([...existing.queries, ...source.queries]);
      if (
        Number.isInteger(source.providerRank) &&
        (!Number.isInteger(existing.providerRank) || source.providerRank < existing.providerRank)
      ) {
        existing.providerRank = source.providerRank;
      }
      continue;
    }
    deduplicated.set(key, { ...source, queries: [...source.queries] });
  }
  return [...deduplicated.values()].slice(0, 32);
}

// catch 后综合 AbortSignal 与持久化任务状态判断，避免把取消竞态误记为 failed。
function cancelled(error, task, signal) {
  return signal.aborted ||
    error?.name === 'AbortError' ||
    error?.code === 'RESEARCH_CANCELLED' ||
    task?.status === 'cancelled' ||
    task?.cancelRequested;
}

/**
 * 创建研究 Worker。
 *
 * 输入：具备状态机 API 的 store、首选的统一 searchSources adapter（或兼容的
 * searchLocal）以及并发数。输出：enqueue/resume/cancel/retry/isActive 调度接口。
 * 不变量：同一进程同一 task id 至多一个 active entry；每次实际执行前仍需原子 claim；
 * 所有阶段结果先持久化再继续，取消后的迟到结果不得覆盖终态。
 */
export function createResearchWorker({
  store,
  searchSources,
  searchLocal,
  planResearch,
  resolveResearchRepositories,
  readResearchSources,
  writeResearchReport,
  concurrency = 1
}) {
  if (!store) throw new TypeError('createResearchWorker requires a store');

  /*
   * active：task id -> 当前/待执行 entry，用于同一进程内去重与取消。
   * pending：尚未开始的 FIFO entry；runningCount 控制并发。
   * 默认 concurrency=1 即轻量“单队列”，减少 SQLite 争用与外部检索突发流量；即使
   * 调用者配置错误也最多放宽到 4。真正防止重复执行仍依赖 Store.claim 的条件更新。
   */
  const active = new Map();
  const pending = [];
  const maxConcurrency = Math.max(1, Math.min(4, Number(concurrency) || 1));
  let runningCount = 0;
  const search = typeof searchSources === 'function'
    ? searchSources
    : async (request) => ({
      local: typeof searchLocal === 'function'
        ? await searchLocal(request.query, request)
        : [],
      web: [],
      webSearchStatus: request.searchMode === 'local'
        ? 'not_requested'
        : 'unavailable'
    });
  const planner = typeof planResearch === 'function'
    ? planResearch
    : async ({ question, continuationContext }) => createFallbackResearchPlan(
      question,
      '未接入研究规划模型',
      continuationContext
    );

  function plannedQuestions(task, artifacts) {
    const plan = artifacts.plan && typeof artifacts.plan === 'object'
      ? artifacts.plan
      : createFallbackResearchPlan(task.question, '缺少已持久化的研究计划', task.continuationContext);
    const entries = Array.isArray(plan.subquestions) ? plan.subquestions : [];
    const valid = entries
      .filter((item) => item && typeof item === 'object')
      .map((item, index) => ({
        id: String(item.id || `q${index + 1}`),
        subject: normalizeQuestion(item.subject),
        question: normalizeQuestion(item.question),
        searchQuery: normalizeQuestion(item.searchQuery || item.question),
        intent: String(item.intent || 'investigation'),
        facets: Array.isArray(item.facets) ? uniqueStrings(item.facets).slice(0, 4) : [],
        evidenceNeed: item.evidenceNeed && typeof item.evidenceNeed === 'object'
          ? item.evidenceNeed
          : null,
        rationale: normalizeQuestion(item.rationale)
      }))
      .filter((item) => item.question && item.searchQuery);
    return valid.length
      ? valid
      : createFallbackResearchPlan(task.question, '已持久化研究计划无有效子问题', task.continuationContext).subquestions;
  }

  /**
   * 每个异步边界前后重新验证运行权。AbortSignal 负责快速中止当前进程，SQLite 的
   * status/cancelRequested 则覆盖来自另一个 HTTP 请求或迟到写入的竞态。
   * 返回最新 task 快照，供下一阶段使用。
   */
  function assertRunning(id, signal) {
    if (signal.aborted) throw new ResearchCancelledError();
    const task = store.get(id);
    if (!task) throw new Error('研究任务不存在');
    if (task.status === 'cancelled' || task.cancelRequested) {
      throw new ResearchCancelledError();
    }
    if (task.status !== 'running') {
      const error = new Error(`研究任务已失去运行权：${task.status}`);
      error.code = 'RESEARCH_LEASE_LOST';
      throw error;
    }
    return task;
  }

  /**
   * 只通过 Store 的 running 守卫保存阶段结果。updateRunning 返回 null 表示任务已被
   * 取消或失去 lease，此时不能继续把旧结果写回终态记录。
   */
  function persistStage(id, patch, signal) {
    if (signal.aborted) throw new ResearchCancelledError();
    const updated = store.updateRunning(id, patch);
    if (!updated) {
      const current = store.get(id);
      if (current?.status === 'cancelled' || current?.cancelRequested) {
        throw new ResearchCancelledError();
      }
      throw new Error('无法保存研究阶段：任务已不在运行');
    }
    return updated;
  }

  /**
   * 最多三个子问题受控并行检索。Promise.all 保留计划顺序，因此网络完成先后不会
   * 改变来源去重、引用编号和报告结果；单次查询内部的 local/web 也可并行执行。
   */
  async function retrieve(task, artifacts, signal) {
    const planned = plannedQuestions(task, artifacts);
    const subquestions = planned.map((item) => item.question);
    const queryResults = await Promise.all(planned.map(async (item, queryIndex) => {
      assertRunning(task.id, signal);
      const startedAt = Date.now();
      const repositoryRequested = item.evidenceNeed?.preferredSourceTypes?.includes('official_repo');
      const [searchResult, repositorySources] = await Promise.all([
        search({
          query: item.searchQuery,
          question: task.question,
          subquestion: item.question,
          queryIndex,
          knowledgeBaseIds: [...task.knowledgeBaseIds],
          searchMode: task.searchMode,
          signal
        }),
        repositoryRequested && typeof resolveResearchRepositories === 'function'
          ? resolveResearchRepositories({
            subject: item.subject,
            question: item.question,
            signal,
            limit: 1
          })
          : []
      ]);
      const result = Array.isArray(searchResult)
        ? { local: searchResult, web: repositorySources }
        : {
          ...(searchResult || {}),
          web: [
            ...(Array.isArray(searchResult?.web) ? searchResult.web : []),
            ...(Array.isArray(repositorySources) ? repositorySources : [])
          ]
        };
      assertRunning(task.id, signal);
      const normalized = normalizeSearchResult(result, {
        query: item.question,
        queryIndex,
        searchMode: task.searchMode
      });
      return {
        ...normalized,
        diagnostics: {
          id: item.id,
          query: item.searchQuery,
          durationMs: Date.now() - startedAt,
          sourceCount: normalized.sources.length,
          status: normalized.webSearchStatus === 'error' ? 'degraded' : 'success'
        }
      };
    }));

    const allSources = queryResults.flatMap((result) => result.sources);
    const statuses = queryResults.map((result) => result.webSearchStatus);
    const webSearchStatus = mergeWebSearchStatuses(task.searchMode, statuses);
    const policy = artifacts.plan?.evidencePolicy || inferResearchEvidencePolicy(task);
    const screened = screenResearchSources(task.question, deduplicateSources(allSources), {
      plannedQuestions: planned,
      policy
    });
    return {
      artifacts: {
        ...artifacts,
        subquestions,
        sources: screened.accepted,
        excludedSources: screened.excluded,
        search: {
          mode: task.searchMode,
          queries: planned,
          webSearchStatus,
          diagnostics: queryResults.map((result) => result.diagnostics)
        }
      },
      webSearchStatus
    };
  }

  /**
   * 执行一个纯阶段，并返回本阶段新增的持久化 patch。每一步都在旧 artifacts 上追加：
   * planning.subquestions -> retrieving.sources -> extracting.evidence/citations ->
   * outlining.outline -> writing.draftReport -> verifying.verifiedReport。
   * 函数本身不改 status，统一由 run() 在阶段边界落库。
   */
  async function executeStage(stage, task, artifacts, signal) {
    if (stage === 'planning') {
      let plan;
      try {
        const proposedPlan = await planner({
          question: task.question,
          knowledgeBaseIds: [...task.knowledgeBaseIds],
          searchMode: task.searchMode,
          continuationContext: task.continuationContext,
          signal
        });
        plan = proposedPlan?.planner && Array.isArray(proposedPlan.subquestions)
          ? proposedPlan
          : normalizeResearchPlan(task.question, proposedPlan, task.continuationContext);
      } catch (error) {
        if (signal.aborted || error?.code === 'RESEARCH_CANCELLED') throw error;
        plan = createFallbackResearchPlan(task.question, '规划模型执行失败', task.continuationContext);
      }
      const subquestions = plan.subquestions.map((item) => item.question);
      return {
        artifacts: {
          ...artifacts,
          subquestions,
          plan: {
            ...plan,
            subquestionCount: subquestions.length,
            knowledgeBaseIds: [...task.knowledgeBaseIds],
            searchMode: task.searchMode,
            evidencePolicy: inferResearchEvidencePolicy(task),
            continuation: task.continuationContext
              ? {
                parentTaskId: task.continuationContext.parent?.taskId || '',
                inheritedCitationCount: Array.isArray(task.continuationContext.citations)
                  ? task.continuationContext.citations.length
                  : 0,
                inheritedLimitationCount: Array.isArray(task.continuationContext.parent?.limitations)
                  ? task.continuationContext.parent.limitations.length
                  : 0
              }
              : null
          }
        }
      };
    }

    if (stage === 'retrieving') {
      return retrieve(task, artifacts, signal);
    }

    if (stage === 'extracting') {
      const acceptedSources = Array.isArray(artifacts.sources) ? artifacts.sources : [];
      const policy = artifacts.plan?.evidencePolicy || inferResearchEvidencePolicy(task);
      const selected = selectResearchEvidence({
        sources: acceptedSources,
        plannedQuestions: artifacts.plan?.subquestions || artifacts.subquestions,
        policy
      });
      // Evidence Pack 是 Writer 唯一可见的来源集合，最多 8 条，避免把未筛选候选或
      // 全量工具输出重新塞回模型上下文。
      const evidenceSources = selected.selected.slice(0, 8).map((source) => {
        const subquestion = (artifacts.plan?.subquestions || []).find(
          (item) => item?.question === source.selectedFor
        );
        return {
          ...source,
          subquestionId: subquestion?.id || '',
          facets: Array.isArray(subquestion?.facets) ? subquestion.facets : []
        };
      });
      const reading = typeof readResearchSources === 'function'
        ? await readResearchSources({
          sources: evidenceSources,
          plan: artifacts.plan,
          signal
        })
        : {
          documents: [],
          failures: [],
          diagnostics: {
            selectedSourceCount: evidenceSources.length,
            readSourceCount: 0,
            failedSourceCount: 0,
            durationMs: 0
          }
        };
      const assembled = assembleResearchEvidence({
        sources: evidenceSources,
        documents: reading.documents
      });
      const { citations, evidence } = assembled;
      return {
        artifacts: {
          ...artifacts,
          citations,
          evidence,
          reading: {
            ...reading.diagnostics,
            failures: reading.failures
          },
          evidencePack: {
            candidateCount: acceptedSources.length + (Array.isArray(artifacts.excludedSources) ? artifacts.excludedSources.length : 0),
            acceptedCount: acceptedSources.length,
            excludedCount: (Array.isArray(artifacts.excludedSources) ? artifacts.excludedSources.length : 0) + selected.excluded.length,
            includedCount: evidence.length,
            citationCount: citations.length,
            readSourceCount: reading.diagnostics.readSourceCount,
            passageCount: assembled.diagnostics.passageCount,
            totalCharacters: assembled.diagnostics.totalCharacters,
            snippetFallbackCount: assembled.diagnostics.snippetFallbackCount,
            policy: policy.id,
            policyLabel: policy.label,
            selectionExcluded: selected.excluded,
            exclusionReasons: Array.from(new Set(
              [
                ...(Array.isArray(artifacts.excludedSources) ? artifacts.excludedSources : []),
                ...selected.excluded
              ]
                .map((source) => source.reason)
                .filter(Boolean)
            ))
          }
        },
        citations
      };
    }

    if (stage === 'outlining') {
      return {
        artifacts: {
          ...artifacts,
          outline: buildOutline(
            Array.isArray(artifacts.subquestions) ? artifacts.subquestions : []
          )
        }
      };
    }

    if (stage === 'writing') {
      const fallback = buildSections(task, artifacts);
      const citations = Array.isArray(artifacts.citations) ? artifacts.citations : [];
      const evidence = Array.isArray(artifacts.evidence) ? artifacts.evidence : [];
      let report = fallback.report;
      let writer = {
        mode: 'fallback',
        status: 'degraded',
        reasonCode: 'model_unavailable',
        fallbackReason: '未接入受证据约束的报告写作者',
        evidenceCount: evidence.length,
        evidenceCharacters: evidence.reduce(
          (sum, item) => sum + String(item?.passage || item?.snippet || '').length,
          0
        )
      };
      if (typeof writeResearchReport === 'function' && evidence.length) {
        try {
          const generatedResult = await writeResearchReport({
            question: task.question,
            plan: artifacts.plan,
            evidence,
            continuationContext: task.continuationContext,
            signal
          });
          const generated = typeof generatedResult === 'string'
            ? generatedResult
            : generatedResult?.draftReport;
          const diagnostics = typeof generatedResult === 'object'
            ? generatedResult?.diagnostics
            : null;
          const checked = generated ? verifyReport(generated, citations) : null;
          if (checked?.verification.valid && checked.verification.referencedCitationIds.length) {
            report = generated;
            writer = {
              ...(diagnostics || {}),
              mode: 'model',
              status: 'success',
              reasonCode: '',
              fallbackReason: ''
            };
          } else {
            writer = {
              ...(diagnostics || writer),
              mode: 'fallback',
              status: 'degraded',
              reasonCode: generated ? 'invalid_citations' : diagnostics?.reasonCode || 'empty_output',
              fallbackReason: '模型报告缺少有效的证据引用，已使用确定性证据摘要'
            };
          }
        } catch (error) {
          if (signal.aborted || error?.code === 'RESEARCH_CANCELLED') throw error;
          writer = {
            ...writer,
            reasonCode: 'upstream_error',
            fallbackReason: '报告模型执行失败，已使用确定性证据摘要'
          };
        }
      }
      return {
        artifacts: {
          ...artifacts,
          sections: fallback.sections,
          draftReport: report,
          writer,
          diagnostics: {
            ...(artifacts.diagnostics || {}),
            planning: artifacts.plan?.diagnostics || null,
            retrieval: artifacts.search?.diagnostics || [],
            reading: artifacts.reading || null,
            writing: writer
          }
        }
      };
    }

    if (stage === 'verifying') {
      const citations = Array.isArray(artifacts.citations) ? artifacts.citations : [];
      const verified = verifyReport(artifacts.draftReport || '', citations);
      return {
        artifacts: {
          ...artifacts,
          verifiedReport: verified.report,
          verification: verified.verification
        },
        citations,
        report: verified.report
      };
    }

    return { artifacts };
  }

  /**
   * claim 后从数据库保存的 stage/artifacts 开始执行。每一阶段先写“正在此阶段”，
   * 产出完成后再原子写入 artifacts 与 nextStage；若中途崩溃，重启只会重做当前阶段。
   * 成功走到 completed 后由 Store 写 100%；非取消异常则连同 failedStage 和现有产物
   * 持久化为 failed。取消由 Store 已保存的 cancelled 终态为准，这里直接返回而不覆盖。
   */
  async function run(id, signal) {
    let task = store.claim(id);
    if (!task) return store.get(id);
    let artifacts = task.artifacts || {};
    let currentStage = RESEARCH_STAGE_VALUES.includes(task.stage) ? task.stage : 'planning';

    try {
      while (currentStage !== 'completed') {
        assertRunning(id, signal);
        task = persistStage(id, {
          stage: currentStage,
          progress: RESEARCH_STAGE_PROGRESS[currentStage],
          artifacts
        }, signal);
        await nextTurn();
        assertRunning(id, signal);

        const result = await executeStage(currentStage, task, artifacts, signal);
        assertRunning(id, signal);
        artifacts = result.artifacts || artifacts;
        const currentIndex = RESEARCH_STAGE_VALUES.indexOf(currentStage);
        const nextStage = RESEARCH_STAGE_VALUES[currentIndex + 1] || 'completed';
        const patch = {
          stage: nextStage,
          progress: RESEARCH_STAGE_PROGRESS[nextStage],
          artifacts
        };
        if (result.webSearchStatus) patch.webSearchStatus = result.webSearchStatus;
        if (result.citations) patch.citations = result.citations;
        if (typeof result.report === 'string') patch.report = result.report;
        task = persistStage(id, patch, signal);
        currentStage = nextStage;
      }

      assertRunning(id, signal);
      const citations = Array.isArray(artifacts.citations) ? artifacts.citations : [];
      const report = typeof artifacts.verifiedReport === 'string'
        ? artifacts.verifiedReport
        : verifyReport(artifacts.draftReport || '', citations).report;
      task = assertRunning(id, signal);
      const quality = assessResearchQuality(task, artifacts);
      artifacts = { ...artifacts, quality };
      return store.complete(id, {
        artifacts,
        citations,
        report,
        resultQuality: quality.quality,
        limitations: quality.limitations
      }) || store.get(id);
    } catch (error) {
      const current = store.get(id);
      if (cancelled(error, current, signal)) return current;
      return store.fail(id, {
        failedStage: currentStage,
        error: readableError(error),
        artifacts
      }) || store.get(id);
    }
  }

  /**
   * 在并发额度内从 FIFO 队列启动任务。entry 只有在 Promise settle 后才从 active 删除，
   * 因此同一个 id 的普通重复 enqueue 会复用同一 Promise，不会并行 claim 两次。
   */
  function drainQueue() {
    while (runningCount < maxConcurrency && pending.length) {
      const entry = pending.shift();
      if (!entry || active.get(entry.id) !== entry) continue;
      entry.started = true;
      runningCount += 1;
      Promise.resolve()
        .then(() => run(entry.id, entry.controller.signal))
        .then((result) => {
          runningCount -= 1;
          if (active.get(entry.id) === entry) active.delete(entry.id);
          drainQueue();
          entry.resolve(result);
        }, (error) => {
          runningCount -= 1;
          if (active.get(entry.id) === entry) active.delete(entry.id);
          drainQueue();
          entry.reject(error);
        });
    }
  }

  /**
   * 将任务加入当前进程队列并返回最终 task Promise。
   *
   * 特殊竞态：运行任务 cancel 后，用户可能在旧 run 的 settle 清理回调删除
   * active 之前立即 retry。此时数据库已经重新 queued，但 active 仍指向旧
   * Promise；必须等待旧 Promise settle 后再次 enqueue，若直接复用旧 Promise，
   * 新尝试将永远没有人 claim。实现使用 `.then(success, error)` 的两个 settle
   * 分支做对称清理，这里并没有 `.finally()` 调用。
   */
  function enqueue(id) {
    const existing = active.get(id);
    if (existing) {
      // 这里检查持久化状态，而不是 entry.started：数据库才决定是否已经产生新尝试。
      if (store.get(id)?.status === 'queued') {
        return existing.promise.then(
          () => enqueue(id),
          () => enqueue(id)
        );
      }
      return existing.promise;
    }

    const controller = new AbortController();
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry = {
      id,
      controller,
      promise,
      resolve,
      reject,
      started: false
    };
    active.set(id, entry);
    pending.push(entry);
    queueMicrotask(drainQueue);
    return promise;
  }

  /** 启动时先让 Store 收敛旧 running，再把所有可恢复 queued 任务重新放入 FIFO。 */
  function resume() {
    return Promise.all(store.resume().map((task) => enqueue(task.id)));
  }

  /**
   * 先持久化 cancelled，再 abort 运行中的 adapter。若任务还在 pending，则直接移出队列
   * 并 resolve；已经 started 的任务会在 assertRunning/catch 路径读取到取消终态。
   */
  function cancel(id) {
    const task = store.cancel(id);
    const entry = active.get(id);
    entry?.controller.abort();
    if (entry && !entry.started) {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
      active.delete(id);
      entry.resolve(task);
    }
    return task;
  }

  /** Store 校验只有 failed/cancelled 可重试；成功转回 queued 后复用统一 enqueue 路径。 */
  function retry(id) {
    const task = store.retry(id);
    if (!task) return Promise.resolve(null);
    return enqueue(task.id);
  }

  return {
    enqueue,
    resume,
    cancel,
    retry,
    isActive(id) {
      return active.has(id);
    }
  };
}

// 暴露纯校验函数供 API/测试复用；输入会防御性地把非数组 citations 当作空列表。
export function verifyResearchReport(report, citations) {
  return verifyReport(report, Array.isArray(citations) ? citations : []);
}
