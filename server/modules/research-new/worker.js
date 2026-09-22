import { assessTracks, buildPassageCandidates, materializeEvidence } from './evidence.js';
import { createResearchNewError, RESEARCH_NEW_STAGE_PROGRESS } from './domain.js';
import { createVerifiedReport } from './report-delivery.js';
import { resultQualityFor, verifyResearchNewDelivery } from './verification.js';

function isCancellation(error, signal) {
  return signal?.aborted
    || error?.code === 'WEB_READER_CANCELLED'
    || error?.code === 'REQUEST_ABORTED'
    || error?.name === 'AbortError';
}

function ensureRunnable(store, runId, attempt, signal) {
  if (signal.aborted) throw signal.reason;
  const current = store.get(runId);
  if (!current || current.status !== 'running' || current.attempt !== attempt || current.cancelRequested) {
    throw createResearchNewError('RESEARCH_NEW_EXECUTION_STALE', '研究执行权已失效', 409);
  }
  if (Date.now() - current.startedAt > current.budget.maxWallTimeMs) {
    throw createResearchNewError('RESEARCH_NEW_BUDGET_EXHAUSTED', '研究任务超过最大执行时间', 409);
  }
  return current;
}

function readingOrder(sources, mode) {
  const web = sources.filter((source) => source.origin === 'web');
  if (mode !== 'hybrid') return web;
  const workspace = sources.filter((source) => source.origin === 'workspace');
  const ordered = [];
  const length = Math.max(web.length, workspace.length);
  for (let index = 0; index < length; index += 1) {
    if (workspace[index]) ordered.push(workspace[index]);
    if (web[index]) ordered.push(web[index]);
  }
  return ordered;
}

function mergeDiagnostics(current, patch) {
  return { ...(current || {}), ...(patch || {}) };
}

function mergeSources(current, additions) {
  const byId = new Map(current.map((source) => [source.id, source]));
  additions.forEach((source) => byId.set(source.id, source));
  return [...byId.values()];
}

function evidenceGapReport({ tracks, sources }) {
  const unresolved = tracks.filter((track) => track.status !== 'answered');
  const readFailures = sources.filter((source) => source.readFailure);
  const lines = [
    '# 研究结果',
    '',
    '## 结论',
    '',
    '证据不足，当前检索与读取结果无法支持可靠的事实性研究结论。',
    '',
    '## 未解决问题',
    ''
  ];
  if (unresolved.length) {
    unresolved.forEach((track) => lines.push(`- ${track.question}`));
  } else {
    lines.push('- 本轮没有形成可引用 Evidence。');
  }
  lines.push(
    '',
    '## 获取局限',
    '',
    `- 本轮记录了 ${sources.length} 个候选来源，但没有段落通过 Evidence 选择。`,
    `- 其中 ${readFailures.length} 个来源未能取得正文或发生了读取降级。`,
    '- 需要补充与上述未解决问题直接相关、可读取且可验证的来源后再形成结论。',
    '',
    '## 来源',
    '',
    '本轮没有可安全引用的来源。'
  );
  return lines.join('\n');
}

export function createResearchNewWorker({ store, search, sourceReader, aiService, now = Date.now }) {
  const active = new Map();

  async function runResearch(run, signal) {
    const attempt = run.attempt;
    let current = run;

    if (current.stage === 'planning') {
      ensureRunnable(store, run.id, attempt, signal);
      const workspaceContext = current.mode === 'hybrid'
        ? await search.buildWorkspaceContext({
            question: current.question,
            knowledgeBaseIds: current.knowledgeBaseIds,
            signal
          })
        : [];
      const budget = {
        ...current.budget,
        searchCalls: current.budget.searchCalls + (current.mode === 'hybrid' ? 1 : 0)
      };
      const planned = await aiService.plan({
        question: current.question,
        mode: current.mode,
        workspaceContext,
        now: new Date(now()).toISOString(),
        signal
      });
      current = store.checkpoint(run.id, attempt, {
        stage: 'researching',
        progress: RESEARCH_NEW_STAGE_PROGRESS.researching,
        brief: planned.brief,
        tracks: planned.tracks,
        budget,
        diagnostics: mergeDiagnostics(current.diagnostics, {
          workspaceContextCount: workspaceContext.length,
          completedTrackIds: [],
          webSearchStatuses: [],
          sourceScreening: [],
          constraintDegradations: []
        })
      });
      if (!current) return store.get(run.id);
    }

    if (current.stage === 'researching') {
      const completedTrackIds = new Set(current.diagnostics.completedTrackIds || []);
      let sources = [...current.sources];
      let evidence = [...current.evidence];
      let budget = { ...current.budget };
      const initialRound = !(current.diagnostics.replanTargetTrackIds || []).length;
      const reservedReplanReads = initialRound && budget.maxRounds > 1
        ? Math.min(2, Math.max(0, budget.maxSourcesRead - 1))
        : 0;
      const roundReadLimit = budget.maxSourcesRead - reservedReplanReads;
      const webSearchStatuses = [...(current.diagnostics.webSearchStatuses || [])];
      const sourceScreening = [...(current.diagnostics.sourceScreening || [])];
      const constraintDegradations = [...(current.diagnostics.constraintDegradations || [])];

      for (let trackIndex = 0; trackIndex < current.tracks.length; trackIndex += 1) {
        const track = current.tracks[trackIndex];
        if (completedTrackIds.has(track.id)) continue;
        ensureRunnable(store, run.id, attempt, signal);
        if (budget.searchCalls >= budget.maxSearchCalls) break;

        const query = track.searchQueries?.[0] || track.question;
        const searchResult = await search.search({
          trackId: track.id,
          query,
          brief: current.brief,
          track,
          mode: current.mode,
          knowledgeBaseIds: current.knowledgeBaseIds,
          signal
        });
        budget.searchCalls += 1;
        webSearchStatuses.push({ trackId: track.id, query, status: searchResult.webStatus });
        sourceScreening.push({
          trackId: track.id,
          accepted: searchResult.screening?.accepted || [],
          rejected: searchResult.screening?.rejected || []
        });
        constraintDegradations.push(...(searchResult.constraintDegradations || []).map((item) => ({
          trackId: track.id,
          ...item
        })));

        const remainingReads = Math.max(0, roundReadLimit - budget.sourcesRead);
        const remainingTracks = Math.max(1, current.tracks.length - completedTrackIds.size);
        const fairShare = Math.max(1, Math.floor(remainingReads / remainingTracks));
        const selected = readingOrder(searchResult.sources, current.mode)
          .slice(0, Math.min(4, remainingReads, fairShare));
        const readResults = await Promise.all(selected.map(async (candidate) => {
          const result = await sourceReader.read(candidate, { signal, allowSnippetFallback: true });
          return {
            ...candidate,
            ...(result.document || {}),
            id: candidate.id,
            trackId: track.id,
            origin: candidate.origin,
            snippet: candidate.snippet,
            query: candidate.query,
            sourceKind: candidate.sourceKind,
            knowledgeBaseId: candidate.knowledgeBaseId,
            documentId: candidate.documentId,
            chunkId: candidate.chunkId,
            readFailure: result.failure
          };
        }));
        budget.sourcesRead += selected.length;
        const readable = readResults.filter((source) => source.content);
        sources = mergeSources(sources, readResults);
        const candidates = buildPassageCandidates(readable, track);
        const selections = await aiService.selectEvidence({ track, candidates, signal });
        const selectedEvidence = materializeEvidence({ track, candidates, selections });
        const existingEvidence = new Set(evidence.map((item) => `${item.sourceId}:${item.passageHash}`));
        selectedEvidence.forEach((item) => {
          const key = `${item.sourceId}:${item.passageHash}`;
          if (existingEvidence.has(key)) return;
          item.id = `E${evidence.length + 1}`;
          evidence.push(item);
          existingEvidence.add(key);
        });
        completedTrackIds.add(track.id);
        budget.roundsUsed = Math.max(1, budget.roundsUsed);
        current = store.checkpoint(run.id, attempt, {
          stage: 'researching',
          progress: Math.min(55, 25 + Math.round((completedTrackIds.size / current.tracks.length) * 30)),
          sources,
          evidence,
          budget,
          diagnostics: mergeDiagnostics(current.diagnostics, {
            completedTrackIds: [...completedTrackIds],
            webSearchStatuses,
            sourceScreening,
            constraintDegradations
          })
        });
        if (!current) return store.get(run.id);
      }

      const assessedTracks = assessTracks(current.tracks, evidence, sources);
      current = store.checkpoint(run.id, attempt, {
        stage: 'assessing',
        progress: RESEARCH_NEW_STAGE_PROGRESS.assessing,
        tracks: assessedTracks,
        sources,
        evidence,
        budget
      });
      if (!current) return store.get(run.id);
    }

    if (current.stage === 'assessing') {
      ensureRunnable(store, run.id, attempt, signal);
      const executedQueries = (current.diagnostics.webSearchStatuses || [])
        .map((item) => item.query)
        .filter(Boolean);
      const assessment = await aiService.assessGaps({
        brief: current.brief,
        tracks: current.tracks,
        evidence: current.evidence,
        sources: current.sources,
        executedQueries,
        signal
      });
      const resultByTrackId = new Map(assessment.trackResults.map((item) => [item.trackId, item]));
      const assessedTracks = current.tracks.map((track) => {
        const result = resultByTrackId.get(track.id);
        return result ? {
          ...track,
          status: result.status,
          gaps: result.missingEvidence.length ? result.missingEvidence : result.reason ? [result.reason] : []
        } : track;
      });
      const remainingSearches = Math.max(0, current.budget.maxSearchCalls - current.budget.searchCalls);
      const remainingReads = Math.max(0, current.budget.maxSourcesRead - current.budget.sourcesRead);
      const canReplan = assessment.shouldReplan
        && current.budget.roundsUsed < current.budget.maxRounds
        && remainingSearches > 0
        && remainingReads > 0;
      const targets = canReplan
        ? assessment.trackResults
          .filter((item) => item.status !== 'answered' && item.followUpQueries.length)
          .slice(0, Math.min(remainingSearches, remainingReads))
        : [];
      const targetByTrackId = new Map(targets.map((item) => [item.trackId, item.followUpQueries[0]]));
      const gapAssessments = [...(current.diagnostics.gapAssessments || []), assessment];

      if (targets.length) {
        const tracks = assessedTracks.map((track) => targetByTrackId.has(track.id) ? {
          ...track,
          status: 'pending',
          searchQueries: [targetByTrackId.get(track.id)]
        } : track);
        const targetIds = new Set(targets.map((item) => item.trackId));
        current = store.checkpoint(run.id, attempt, {
          stage: 'researching',
          tracks,
          budget: { ...current.budget, roundsUsed: current.budget.roundsUsed + 1 },
          diagnostics: mergeDiagnostics(current.diagnostics, {
            gapAssessments,
            completedTrackIds: tracks.filter((track) => !targetIds.has(track.id)).map((track) => track.id),
            replanTargetTrackIds: [...targetIds],
            replanQueries: Object.fromEntries(targetByTrackId)
          })
        });
        if (!current) return store.get(run.id);
        return runResearch(current, signal);
      } else {
        current = store.checkpoint(run.id, attempt, {
          stage: 'reporting',
          progress: RESEARCH_NEW_STAGE_PROGRESS.reporting,
          tracks: assessedTracks,
          diagnostics: mergeDiagnostics(current.diagnostics, { gapAssessments })
        });
      }
      if (!current) return store.get(run.id);
    }

    if (current.stage === 'reporting') {
      let verification = null;
      let report = '';
      let budget = { ...current.budget };
      if (current.evidence.length === 0) {
        report = evidenceGapReport({ tracks: current.tracks, sources: current.sources });
        verification = verifyResearchNewDelivery({
          report,
          tracks: current.tracks,
          sources: current.sources,
          evidence: [],
          writerEvidenceIds: []
        });
        if (!verification.valid) {
          throw createResearchNewError(
            'RESEARCH_NEW_EVIDENCE_GAP_REPORT_INVALID',
            `证据缺口报告验证失败：${verification.failures.join(', ')}`,
            500
          );
        }
        current = store.checkpoint(run.id, attempt, {
          stage: 'verifying',
          progress: RESEARCH_NEW_STAGE_PROGRESS.verifying,
          report,
          budget,
          diagnostics: mergeDiagnostics(current.diagnostics, {
            verification,
            deliveryMode: 'evidence_gap_report'
          })
        });
        if (!current) return store.get(run.id);
      } else {
        const delivery = await createVerifiedReport({
          brief: current.brief,
          tracks: current.tracks,
          sources: current.sources,
          evidence: current.evidence,
          mode: current.mode,
          maxAttempts: Math.max(0, budget.maxWriterAttempts - budget.writerAttempts),
          writeDraft: aiService.writeReportDraft,
          currentTime: new Date(now()).toISOString(),
          signal,
          async onAttempt() {
            ensureRunnable(store, run.id, attempt, signal);
            budget = { ...budget, writerAttempts: budget.writerAttempts + 1 };
            current = store.checkpoint(run.id, attempt, {
              stage: 'reporting',
              progress: RESEARCH_NEW_STAGE_PROGRESS.reporting,
              budget
            });
            if (!current) {
              throw createResearchNewError('RESEARCH_NEW_EXECUTION_STALE', '研究执行权已失效', 409);
            }
          }
        });
        report = delivery.report;
        verification = verifyResearchNewDelivery({
          report,
          tracks: current.tracks,
          sources: current.sources,
          evidence: current.evidence,
          writerEvidenceIds: current.evidence.map((item) => item.id)
        });
        if (!verification.valid) {
          throw createResearchNewError(
            'RESEARCH_NEW_REPORT_INVALID',
            `报告验证失败：${verification.failures.join(', ') || 'unknown'}`,
            502
          );
        }
        current = store.checkpoint(run.id, attempt, {
          stage: 'verifying',
          progress: RESEARCH_NEW_STAGE_PROGRESS.verifying,
          report,
          budget,
          diagnostics: mergeDiagnostics(current.diagnostics, {
            verification,
            reportDraft: delivery.draft
          })
        });
        if (!current) return store.get(run.id);
      }
    }

    if (current.stage === 'verifying') {
      const verification = verifyResearchNewDelivery({
        report: current.report,
        tracks: current.tracks,
        sources: current.sources,
        evidence: current.evidence,
        writerEvidenceIds: current.evidence.map((item) => item.id)
      });
      if (!verification.valid) {
        throw createResearchNewError('RESEARCH_NEW_REPORT_INVALID', '持久化报告未通过最终验证', 502);
      }
      return store.complete(run.id, attempt, {
        report: current.report,
        tracks: current.tracks,
        budget: current.budget,
        diagnostics: mergeDiagnostics(current.diagnostics, { verification }),
        resultQuality: resultQualityFor(current.tracks, current.evidence)
      });
    }

    return store.get(run.id);
  }

  async function execute(id, controller) {
    const run = store.claim(id);
    if (!run) return store.get(id);
    try {
      return await runResearch(run, controller.signal);
    } catch (error) {
      if (isCancellation(error, controller.signal)) return store.cancel(id, run.attempt);
      const current = store.get(id);
      if (!current || current.status !== 'running' || current.attempt !== run.attempt) return current;
      return store.fail(id, run.attempt, error);
    }
  }

  function enqueue(id) {
    if (active.has(id)) return active.get(id).promise;
    const controller = new AbortController();
    const promise = execute(id, controller).finally(() => {
      if (active.get(id)?.promise === promise) active.delete(id);
    });
    active.set(id, { promise, controller });
    return promise;
  }

  function cancel(id) {
    const current = store.requestCancel(id);
    active.get(id)?.controller?.abort(new Error('cancelled'));
    return current;
  }

  async function resume() {
    await Promise.all(store.listRecoverable('node').map((run) => enqueue(run.id)));
  }

  return { enqueue, cancel, resume };
}
