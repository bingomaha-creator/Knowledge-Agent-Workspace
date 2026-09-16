import { assessTracks, buildPassageCandidates, materializeEvidence } from './evidence.js';
import { createResearchNewError, RESEARCH_NEW_STAGE_PROGRESS } from './domain.js';
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
          webSearchStatuses: []
        })
      });
      if (!current) return store.get(run.id);
    }

    if (current.stage === 'researching') {
      const completedTrackIds = new Set(current.diagnostics.completedTrackIds || []);
      let sources = [...current.sources];
      let evidence = [...current.evidence];
      let budget = { ...current.budget };
      const webSearchStatuses = [...(current.diagnostics.webSearchStatuses || [])];

      for (let trackIndex = 0; trackIndex < current.tracks.length; trackIndex += 1) {
        const track = current.tracks[trackIndex];
        if (completedTrackIds.has(track.id)) continue;
        ensureRunnable(store, run.id, attempt, signal);
        if (budget.searchCalls >= budget.maxSearchCalls) break;

        const query = track.searchQueries?.[0] || track.question;
        const searchResult = await search.search({
          trackId: track.id,
          query,
          mode: current.mode,
          knowledgeBaseIds: current.knowledgeBaseIds,
          signal
        });
        budget.searchCalls += 1;
        webSearchStatuses.push({ trackId: track.id, query, status: searchResult.webStatus });

        const remainingReads = Math.max(0, budget.maxSourcesRead - budget.sourcesRead);
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
        sources.push(...readResults);
        const candidates = buildPassageCandidates(readable);
        const selections = await aiService.selectEvidence({ track, candidates, signal });
        const selectedEvidence = materializeEvidence({ track, candidates, selections });
        selectedEvidence.forEach((item) => {
          item.id = `E${evidence.length + 1}`;
          evidence.push(item);
        });
        completedTrackIds.add(track.id);
        budget.roundsUsed = 1;
        current = store.checkpoint(run.id, attempt, {
          stage: 'researching',
          progress: Math.min(55, 25 + Math.round((completedTrackIds.size / current.tracks.length) * 30)),
          sources,
          evidence,
          budget,
          diagnostics: mergeDiagnostics(current.diagnostics, {
            completedTrackIds: [...completedTrackIds],
            webSearchStatuses
          })
        });
        if (!current) return store.get(run.id);
      }

      const assessedTracks = assessTracks(current.tracks, evidence);
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
      current = store.checkpoint(run.id, attempt, {
        stage: 'reporting',
        progress: RESEARCH_NEW_STAGE_PROGRESS.reporting
      });
      if (!current) return store.get(run.id);
    }

    if (current.stage === 'reporting') {
      let verification = null;
      let report = '';
      let budget = { ...current.budget };
      while (budget.writerAttempts < budget.maxWriterAttempts) {
        ensureRunnable(store, run.id, attempt, signal);
        budget.writerAttempts += 1;
        current = store.checkpoint(run.id, attempt, {
          stage: 'reporting',
          progress: RESEARCH_NEW_STAGE_PROGRESS.reporting,
          budget
        });
        if (!current) return store.get(run.id);
        const writerEvidenceIds = current.evidence.map((item) => item.id);
        report = await aiService.writeReport({
          brief: current.brief,
          tracks: current.tracks,
          evidence: current.evidence,
          sources: current.sources,
          previousFailure: verification?.failures,
          signal
        });
        verification = verifyResearchNewDelivery({
          report,
          tracks: current.tracks,
          sources: current.sources,
          evidence: current.evidence,
          writerEvidenceIds
        });
        if (verification.valid) break;
      }
      if (!verification?.valid) {
        throw createResearchNewError(
          'RESEARCH_NEW_REPORT_INVALID',
          `报告验证失败：${verification?.failures.join(', ') || 'unknown'}`,
          502
        );
      }
      current = store.checkpoint(run.id, attempt, {
        stage: 'verifying',
        progress: RESEARCH_NEW_STAGE_PROGRESS.verifying,
        report,
        budget,
        diagnostics: mergeDiagnostics(current.diagnostics, { verification })
      });
      if (!current) return store.get(run.id);
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
    await Promise.all(store.listRecoverable().map((run) => enqueue(run.id)));
  }

  return { enqueue, cancel, resume };
}
