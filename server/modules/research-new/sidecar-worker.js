import { createHash } from 'node:crypto';
import { createResearchNewError, RESEARCH_NEW_STAGE_PROGRESS } from './domain.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'budget_exhausted']);

function stageFor(remote) {
  const stage = String(remote?.current_stage || remote?.status || '').toLowerCase();
  if (stage.includes('report')) return 'reporting';
  if (stage.includes('verify')) return 'verifying';
  if (stage.includes('execut') || stage.includes('research') || stage.includes('tool')) return 'researching';
  if (stage.includes('assess') || stage.includes('replan')) return 'assessing';
  return 'planning';
}

function hash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function projectEvidence(run, payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const sources = [];
  const evidence = [];
  const trace = [];
  items.forEach((item, index) => {
    const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    const extra = metadata.extra && typeof metadata.extra === 'object' ? metadata.extra : {};
    const sourceId = `sidecar-source-${item.evidence_id || index + 1}`;
    const origin = item.source_mode === 'web' ? 'web' : 'workspace';
    const passage = String(item.summary || '').trim();
    const chunkId = extra.chunk_id || item.source_id || '';
    const documentId = extra.document_id || item.title || '';
    const contentLevel = origin === 'workspace' && (metadata.source_type === 'chunk' || extra.chunk_id)
      ? 'full_text'
      : item.artifact_id ? 'full_text' : 'summary';
    sources.push({
      id: sourceId,
      trackId: item.task_id || 'sidecar',
      origin,
      title: item.title || item.source_id || 'Sidecar evidence',
      url: metadata.url || (origin === 'web' ? item.source_id : ''),
      snippet: passage,
      query: run.question,
      sourceKind: item.provider || 'sidecar',
      knowledgeBaseId: origin === 'workspace' ? extra.knowledge_base_id || '' : '',
      documentId: origin === 'workspace' ? documentId : '',
      chunkId: origin === 'workspace' ? chunkId : item.evidence_id || '',
      content: passage,
      contentHash: item.content_hash || hash(passage),
      readerKind: item.provider || 'sidecar',
      contentLevel,
      fetchedAt: Date.parse(item.created_at || '') || Date.now()
    });
    evidence.push({
      id: item.evidence_id || `sidecar-evidence-${index + 1}`,
      trackId: item.task_id || 'sidecar',
      sourceId,
      origin,
      passage,
      passageHash: hash(passage),
      supports: [],
      contradicts: [],
      relevance: Number(item.score) || 0,
      sourceRole: 'unknown',
      contentLevel
    });
    trace.push({
      evidenceId: item.evidence_id || `sidecar-evidence-${index + 1}`,
      documentId,
      chunkId,
      position: Number.isInteger(extra.position) ? extra.position : null,
      contentHash: item.content_hash || hash(passage)
    });
  });
  return { sources, evidence, trace };
}

function projectBudget(current, remote, sourcesRead = current.sourcesRead) {
  const usage = remote?.usage?.usage || {};
  const limits = remote?.usage?.limits || {};
  return {
    ...current,
    maxRounds: Number.isFinite(Number(limits.max_replans))
      ? Number(limits.max_replans) + 1
      : current.maxRounds,
    maxSearchCalls: Number.isFinite(Number(limits.max_tool_calls))
      ? Number(limits.max_tool_calls)
      : current.maxSearchCalls,
    roundsUsed: Number.isFinite(Number(usage.replans))
      ? Number(usage.replans) + 1
      : current.roundsUsed,
    searchCalls: Number.isFinite(Number(usage.tool_calls))
      ? Number(usage.tool_calls)
      : current.searchCalls,
    sourcesRead
  };
}

function resultQuality(report, evidence) {
  const required = Array.isArray(report?.verification)
    ? report.verification.filter((check) => check.required)
    : [];
  if (!evidence.length) return 'insufficient';
  if (required.some((check) => check.passed !== true)) return 'limited';
  return 'sufficient';
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

export function createResearchNewSidecarWorker({ store, client, pollMs = 1_000 }) {
  const active = new Map();

  async function poll(run, controller) {
    let current = run;
    let mapping = current.diagnostics?.sidecar;
    if (!mapping?.runId) {
      const started = await client.startRun({
        question: current.question,
        mode: current.mode,
        clientMessageId: current.id,
        retrievalBackend: current.diagnostics.retrievalBackend || 'workspace',
        signal: controller.signal
      });
      mapping = {
        sessionId: started.sessionId,
        runId: started.runId,
        sourceMode: current.mode === 'web' ? 'web' : 'graphrag',
        corpus: current.mode === 'hybrid' ? 'selected_knowledge_base' : 'web',
        retrievalBackend: current.diagnostics.retrievalBackend || 'workspace'
      };
      current = store.checkpoint(current.id, current.attempt, {
        stage: 'planning',
        progress: RESEARCH_NEW_STAGE_PROGRESS.planning,
        diagnostics: { ...current.diagnostics, engine: 'sidecar', sidecar: mapping }
      });
      if (!current) return store.get(run.id);
    }

    const deadline = current.startedAt + current.budget.maxWallTimeMs;
    while (!controller.signal.aborted) {
      const authoritative = store.get(run.id);
      if (!authoritative || authoritative.status !== 'running' || authoritative.attempt !== run.attempt) return authoritative;
      if (authoritative.cancelRequested) {
        await client.cancelRun(mapping.runId).catch(() => null);
        return store.cancel(run.id, run.attempt);
      }
      if (Date.now() > deadline) {
        await client.cancelRun(mapping.runId).catch(() => null);
        throw createResearchNewError('RESEARCH_NEW_BUDGET_EXHAUSTED', 'Research Sidecar 超过最大执行时间', 409);
      }

      let remote;
      try {
        remote = await client.getRun(mapping.runId, controller.signal);
      } catch (error) {
        if (!error?.retryable) throw error;
        await sleep(pollMs, controller.signal);
        continue;
      }
      const afterPoll = store.get(run.id);
      if (!afterPoll || afterPoll.status !== 'running' || afterPoll.attempt !== run.attempt) return afterPoll;
      if (afterPoll.cancelRequested || controller.signal.aborted) {
        await client.cancelRun(mapping.runId).catch(() => null);
        return store.cancel(run.id, run.attempt);
      }
      const stage = stageFor(remote);
      current = store.checkpoint(run.id, run.attempt, {
        stage,
        progress: RESEARCH_NEW_STAGE_PROGRESS[stage],
        budget: projectBudget(afterPoll.budget, remote),
        diagnostics: {
          ...afterPoll.diagnostics,
          engine: 'sidecar',
          sidecar: { ...mapping, status: remote.status, currentStage: remote.current_stage }
        }
      });
      if (!current) return store.get(run.id);
      if (!TERMINAL.has(remote.status)) {
        await sleep(pollMs, controller.signal);
        continue;
      }
      if (remote.status === 'cancelled') return store.cancel(run.id, run.attempt);
      if (remote.status === 'failed') {
        throw createResearchNewError(
          remote.error_code || 'RESEARCH_SIDECAR_RUN_FAILED',
          remote.error_message || 'Research Sidecar 执行失败',
          502
        );
      }

      const [evidencePayload, report] = await Promise.all([
        client.getEvidence(mapping.runId, controller.signal),
        client.getReport(mapping.runId, controller.signal)
      ]);
      const projected = projectEvidence(current, evidencePayload);
      const reportContent = String(report?.content || '').trim();
      if (!reportContent) {
        throw createResearchNewError('RESEARCH_SIDECAR_REPORT_MISSING', 'Research Sidecar 未生成可交付报告', 502);
      }
      current = store.checkpoint(run.id, run.attempt, {
        stage: 'verifying',
        progress: RESEARCH_NEW_STAGE_PROGRESS.verifying,
        sources: projected.sources,
        evidence: projected.evidence,
        report: reportContent,
        budget: projectBudget(current.budget, remote, projected.sources.length),
        diagnostics: {
          ...current.diagnostics,
          engine: 'sidecar',
          sidecar: {
            ...mapping,
            status: remote.status,
            currentStage: remote.current_stage,
            reportMode: report.report_mode,
            verification: report.verification || [],
            evidenceTrace: projected.trace
          }
        }
      });
      if (!current) return store.get(run.id);
      return store.complete(run.id, run.attempt, {
        report: reportContent,
        diagnostics: current.diagnostics,
        resultQuality: remote.status === 'budget_exhausted'
          ? 'insufficient'
          : resultQuality(report, projected.evidence)
      });
    }
    return store.cancel(run.id, run.attempt);
  }

  async function execute(id, controller) {
    const run = store.claim(id);
    if (!run) return store.get(id);
    try {
      return await poll(run, controller);
    } catch (error) {
      if (controller.signal.aborted) return store.cancel(id, run.attempt);
      const current = store.get(id);
      if (!current || current.status !== 'running' || current.attempt !== run.attempt) return current;
      return store.fail(id, run.attempt, error);
    }
  }

  function enqueue(id) {
    if (active.has(id)) return active.get(id).promise;
    const controller = new AbortController();
    const promise = execute(id, controller).finally(() => active.delete(id));
    active.set(id, { controller, promise });
    return promise;
  }

  function cancel(id) {
    const current = store.requestCancel(id);
    const runId = current?.diagnostics?.sidecar?.runId;
    if (runId) void client.cancelRun(runId).catch(() => null);
    active.get(id)?.controller.abort(new Error('cancelled'));
    return current;
  }

  async function resume() {
    await Promise.all(store.listRecoverable('sidecar').map((run) => enqueue(run.id)));
  }

  return { enqueue, cancel, resume };
}
