import { randomUUID } from 'node:crypto';
import {
  buildBugFactSummary,
  buildCandidateDraft,
  deriveInvestigationTitle,
  evaluateCandidateReadiness,
  evaluateEvidenceQuality,
  extractBugFacts,
  normalizeBugEvidenceInput
} from './bug-investigation-domain.js';

const ANALYSIS_POLICY_VERSION = 'bug-investigation-grounding-v4';

function createServiceError(code, message, status = 400, details = '') {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function requireDraft(investigation) {
  if (investigation.status !== 'draft') {
    throw createServiceError(
      'BUG_INVESTIGATION_NOT_EDITABLE',
      '只有调查中的记录可以继续补充或分析',
      409
    );
  }
}

function searchTextFor(investigation) {
  const facts = investigation.facts;
  const evidenceText = investigation.evidence
    .filter((item) => ['error', 'network', 'test_failure', 'code'].includes(item.type))
    .map((item) => item.content)
    .join('\n');
  return [
    ...facts.errorSignatures,
    ...(facts.errorCodes || []),
    ...facts.messages,
    ...facts.files,
    evidenceText
  ].join('\n').slice(0, 8_000);
}

function snapshotSimilarCases(response) {
  return (response?.results || [])
    .filter((result) => result?.bugCase?.reviewStatus === 'confirmed')
    .slice(0, 5)
    .map((result) => ({
      id: result.bugCase.id,
      title: result.bugCase.title,
      symptom: result.bugCase.symptom,
      scope: result.bugCase.scope,
      sourceProjectRef: result.bugCase.sourceProjectRef,
      rootCause: result.bugCase.rootCause,
      fix: result.bugCase.fix,
      verification: result.bugCase.verification,
      matchedChannels: result.matchedChannels || [],
      rank: result.rank,
      score: result.score
    }));
}

function mergeMissingEvidence(deterministic, model) {
  return [...new Set([
    ...(deterministic || []),
    ...(model || [])
  ])].slice(0, 12);
}

function evidenceTypeFor(description) {
  const value = String(description || '');
  if (/源码|代码|函数|调用点|文件片段/u.test(value)) return 'code';
  if (/网络|请求|响应|response|header|状态码|请求体|响应体/iu.test(value)) return 'network';
  if (/复现|操作步骤|触发步骤/u.test(value)) return 'reproduction';
  if (/环境|版本|浏览器|运行时/u.test(value)) return 'environment';
  if (/验证|观察结果|日志/u.test(value)) return 'verification';
  if (/error|stack|异常|报错|失败输出/iu.test(value)) return 'error';
  return 'note';
}

function nextActionTitle(evidenceType) {
  return {
    error: '补充完整错误',
    network: '补充网络现场',
    test_failure: '补充测试失败输出',
    code: '补充代码上下文',
    environment: '补充运行环境',
    reproduction: '补充复现步骤',
    verification: '执行一次定向验证',
    note: '补充关键证据'
  }[evidenceType] || '补充关键证据';
}

function deriveNextAction(evidenceGate, output) {
  const primaryVerification = output?.verificationSteps?.[0];
  if (
    evidenceGate?.quality === 'sufficient'
    && output?.hypotheses?.length
    && primaryVerification?.instruction
  ) {
    return {
      title: '执行一次定向验证',
      description: primaryVerification.instruction,
      evidenceType: 'verification'
    };
  }
  const missingEvidence = [
    ...(output?.missingEvidence || []),
    ...(evidenceGate?.missingEvidence || [])
  ];
  const description = missingEvidence.find(Boolean)
    || output?.verificationSteps?.[0]?.instruction
    || '';
  if (!description) return null;
  const evidenceType = missingEvidence.length
    ? evidenceTypeFor(description)
    : 'verification';
  return {
    title: nextActionTitle(evidenceType),
    description,
    evidenceType
  };
}

/**
 * Investigation 的唯一外部 seam。调用者不需要知道脱敏、解析、RAG、模型降级或
 * Candidate DTO 的细节；测试也只通过这些行为验证完整纵切面。
 */
export function createBugInvestigationService({
  store,
  projectExists = async () => true,
  searchBugCases,
  analyzeEvidence,
  createBugCase,
  idFactory = (prefix) => `${prefix}-${randomUUID()}`,
  now = () => Date.now()
}) {
  if (!store) throw new TypeError('BugInvestigationService requires store');
  if (!searchBugCases) throw new TypeError('BugInvestigationService requires searchBugCases');
  if (!analyzeEvidence) throw new TypeError('BugInvestigationService requires analyzeEvidence');
  if (!createBugCase) throw new TypeError('BugInvestigationService requires createBugCase');

  function get(id) {
    const investigation = store.get(String(id || '').trim());
    if (!investigation) {
      throw createServiceError('BUG_INVESTIGATION_NOT_FOUND', 'Bug 调查不存在', 404);
    }
    return investigation;
  }

  function list(options = {}) {
    return store.list({
      projectRef: typeof options.projectRef === 'string' ? options.projectRef.trim() : '',
      status: typeof options.status === 'string' ? options.status.trim() : '',
      limit: options.limit
    });
  }

  function createEvidence(input) {
    const normalized = normalizeBugEvidenceInput(input);
    return {
      id: idFactory('evidence'),
      ...normalized,
      createdAt: now()
    };
  }

  async function create(input = {}) {
    const projectRef = typeof input.projectRef === 'string' ? input.projectRef.trim() : '';
    if (!projectRef) {
      throw createServiceError('BUG_PROJECT_REF_REQUIRED', 'projectRef 不能为空', 422);
    }
    if (!await projectExists(projectRef)) {
      throw createServiceError('BUG_PROJECT_NOT_FOUND', 'Bug 项目不存在', 404);
    }
    const evidence = [createEvidence(input.evidence)];
    const facts = extractBugFacts(evidence);
    const candidateReadiness = evaluateCandidateReadiness(facts, evidence);
    const timestamp = now();
    return store.create({
      id: idFactory('bug-investigation'),
      projectRef,
      title: deriveInvestigationTitle(facts, evidence, input.title),
      status: 'draft',
      evidence,
      facts,
      analysis: {
        policyVersion: '',
        status: 'idle',
        evidenceQuality: 'pending',
        summary: '',
        hypotheses: [],
        verificationSteps: [],
        missingEvidence: [],
        nextAction: null,
        similarCases: [],
        retrievalTrace: null,
        reasonCode: ''
      },
      runs: [],
      candidateReadiness,
      candidateBugCaseId: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  function appendEvidence(id, input = {}) {
    const current = get(id);
    requireDraft(current);
    const evidence = [...current.evidence, createEvidence(input)].slice(-50);
    const facts = extractBugFacts(evidence);
    return store.update(current.id, {
      evidence,
      facts,
      candidateReadiness: evaluateCandidateReadiness(facts, evidence),
      // 新事实到达后旧分析仍保留供对照，但显式标记为 stale。
      analysis: { ...current.analysis, status: 'stale' }
    });
  }

  async function analyze(id, signal) {
    const current = get(id);
    requireDraft(current);
    const facts = extractBugFacts(current.evidence);
    const evidenceGate = evaluateEvidenceQuality(facts, current.evidence);
    const startedAt = now();
    let similarCases = [];
    let retrievalTrace = null;

    if (evidenceGate.quality !== 'insufficient') {
      const response = await searchBugCases({
        query: searchTextFor({ ...current, facts }),
        projectRef: current.projectRef,
        includeCommon: true,
        additionalProjectRefs: [],
        filters: {},
        topK: 5
      }, signal);
      similarCases = snapshotSimilarCases(response);
      retrievalTrace = response?.trace || null;
    }

    if (evidenceGate.quality === 'insufficient') {
      const run = {
        id: idFactory('investigation-run'),
        status: 'insufficient',
        mode: 'deterministic',
        reasonCode: 'evidence_insufficient',
        durationMs: now() - startedAt,
        inputTokens: 0,
        outputTokens: 0,
        evidenceCount: current.evidence.length,
        similarCaseCount: 0,
        createdAt: now()
      };
      return store.update(current.id, {
        facts,
        candidateReadiness: evaluateCandidateReadiness(facts, current.evidence),
        analysis: {
          policyVersion: ANALYSIS_POLICY_VERSION,
          status: 'insufficient',
          evidenceQuality: evidenceGate.quality,
          summary: '当前证据不足，系统未生成根因假设。',
          hypotheses: [],
          verificationSteps: [],
          missingEvidence: evidenceGate.missingEvidence,
          nextAction: deriveNextAction(evidenceGate, null),
          similarCases: [],
          retrievalTrace: null,
          reasonCode: 'evidence_insufficient'
        },
        runs: [...current.runs, run].slice(-20)
      });
    }

    const modelResult = await analyzeEvidence({
      facts,
      evidence: current.evidence,
      similarCases,
      quality: evidenceGate.quality
    }, signal);
    const output = modelResult?.output;
    const diagnostics = modelResult?.diagnostics || {};
    const status = output ? 'success' : 'degraded';
    const run = {
      id: idFactory('investigation-run'),
      status,
      mode: diagnostics.mode || (output ? 'model' : 'deterministic'),
      reasonCode: diagnostics.reasonCode || '',
      durationMs: Number.isFinite(diagnostics.durationMs)
        ? diagnostics.durationMs
        : now() - startedAt,
      inputTokens: Number(diagnostics.inputTokens || 0),
      outputTokens: Number(diagnostics.outputTokens || 0),
      evidenceCount: current.evidence.length,
      similarCaseCount: similarCases.length,
      createdAt: now()
    };
    return store.update(current.id, {
      facts,
      candidateReadiness: evaluateCandidateReadiness(facts, current.evidence),
      analysis: {
        policyVersion: ANALYSIS_POLICY_VERSION,
        status,
        evidenceQuality: evidenceGate.quality,
        summary: buildBugFactSummary(facts, current.evidence),
        hypotheses: output?.hypotheses || [],
        verificationSteps: output?.verificationSteps || [],
        missingEvidence: mergeMissingEvidence(
          evidenceGate.missingEvidence,
          output?.missingEvidence
        ),
        nextAction: deriveNextAction(evidenceGate, output),
        similarCases,
        retrievalTrace,
        reasonCode: output ? '' : diagnostics.reasonCode || 'model_unavailable'
      },
      runs: [...current.runs, run].slice(-20)
    });
  }

  async function convertToCandidate(id) {
    const current = get(id);
    requireDraft(current);
    const readiness = evaluateCandidateReadiness(current.facts, current.evidence);
    if (!readiness.ready) {
      throw createServiceError(
        'BUG_INVESTIGATION_NOT_READY_FOR_CANDIDATE',
        '当前调查尚未达到候选案例的最低证据门槛',
        422,
        readiness.checks.filter((check) => !check.passed).map((check) => check.label).join('、')
      );
    }
    const result = await createBugCase(buildCandidateDraft({ ...current, candidateReadiness: readiness }));
    const bugCase = result?.bugCase || result;
    if (!bugCase?.id) {
      throw createServiceError(
        'BUG_INVESTIGATION_CANDIDATE_CREATE_FAILED',
        '创建 Candidate 后未返回有效 BugCase',
        502
      );
    }
    return store.update(current.id, {
      status: 'converted',
      candidateReadiness: readiness,
      candidateBugCaseId: bugCase.id
    });
  }

  function close(id) {
    const current = get(id);
    if (current.status === 'converted') {
      throw createServiceError(
        'BUG_INVESTIGATION_ALREADY_CONVERTED',
        '已转为 Candidate 的调查不能关闭',
        409
      );
    }
    return store.update(current.id, { status: 'closed' });
  }

  return {
    list,
    get,
    create,
    appendEvidence,
    analyze,
    convertToCandidate,
    close
  };
}
