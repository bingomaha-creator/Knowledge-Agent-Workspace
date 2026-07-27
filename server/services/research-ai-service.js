import {
  createDirectResearchPlan,
  createFallbackResearchPlan,
  normalizeResearchPlan,
  shouldUseDirectResearchPlan
} from '../research-plan.js';

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactText(value, length) {
  return normalizedText(value).slice(0, length);
}

function readContent(result) {
  return result?.choices?.[0]?.message?.content || result?.choices?.[0]?.text || '';
}
export { createFallbackResearchPlan, normalizeResearchPlan } from '../research-plan.js';

function safeContinuationContext(value) {
  if (!value || typeof value !== 'object') return null;
  const parent = value.parent && typeof value.parent === 'object' ? value.parent : {};
  return {
    originQuestion: compactText(value.originQuestion, 800),
    parent: {
      question: compactText(parent.question, 800),
      reportExcerpt: compactText(parent.reportExcerpt, 1_800),
      limitations: Array.isArray(parent.limitations)
        ? parent.limitations.slice(0, 6).map((item) => compactText(item?.message, 500)).filter(Boolean)
        : []
    },
    citations: Array.isArray(value.citations)
      ? value.citations.slice(0, 6).map((item) => ({
        title: compactText(item?.title, 240),
        snippet: compactText(item?.snippet, 800),
        originTaskId: compactText(item?.originTaskId, 120)
      }))
      : []
  };
}

function plannerMessages(question, continuationContext) {
  return [
    {
      role: 'system',
      content: [
        '你是一个研究规划器。只输出 JSON，不回答用户问题，不提供 URL，不调用工具。',
        '围绕原问题产出 1 到 3 个真正不同、仍紧扣同一主题的证据问题。',
        '每一项都必须显式保留主题实体；subject 只写实体名，facets 只写要核验的维度。',
        '问题必须保持开放，不得预设某个实现、架构或结论已经成立。',
        '不得加入原问题未提及的行业、组织、地区、法规或合规场景；信息不足时保持问题原有边界。',
        'preferredSourceTypes 只能从 project_knowledge、official_docs、official_repo、paper、standard、government_document、public_web 中选择。',
        '不要生成搜索词；系统会用实体、资料类型和 facets 构建短查询。',
        'JSON Schema: {"subquestions":[{"subject":"...","question":"...","intent":"definition|comparison|decision|risk|implementation|current_state|investigation","facets":["..."],"preferredSourceTypes":["..."],"freshness":"current|historical|any","rationale":"..."}]}'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        question: compactText(question, 4000),
        priorResearch: safeContinuationContext(continuationContext),
        instruction: 'priorResearch 仅用于理解追问的范围和缺口，不是本轮可引用证据。'
      })
    }
  ];
}

function writerMessages({ question, plan, evidence, continuationContext }) {
  const safeEvidence = evidence.map((item) => ({
    citationNumber: item.citationNumber,
    title: compactText(item.title, 240),
    kind: item.kind === 'web' ? '公开网页' : '项目资料',
    passage: compactText(item.passage || item.snippet, 1800),
    supports: compactText(item.claim, 300),
    facets: Array.isArray(item.facets) ? item.facets.slice(0, 4) : [],
    provenance: compactText(item.provenance, 40),
    plannedQuestions: Array.isArray(item.queries) ? item.queries.map((query) => compactText(query, 360)) : []
  }));
  return [
    {
      role: 'system',
      content: [
        '你是受证据约束的研究报告写作者。只能使用给定 Evidence Pack 中明确出现的信息。',
        '不能补充常识、猜测、未给出的事实、URL 或新的来源。每个事实性表述后必须使用已有的 [n] 引用。',
        '若某个计划问题没有证据，直接写“证据不足，无法下结论”。',
        '按研究问题组织完整的 Markdown 报告：先给结论摘要，再逐项回答计划问题；比较题使用一致的比较维度，最后说明证据边界和下一步。',
        '报告详略应由 Evidence Pack 的段落数量与覆盖面决定，不要为了简短而省略已有证据，也不要为了长度重复同一事实。',
        '输出 Markdown 正文；不要输出“参考资料”章节，也不要使用任何未提供的引用编号。'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        question: compactText(question, 4000),
        plan: plan?.subquestions || [],
        evidencePack: safeEvidence,
        priorResearch: safeContinuationContext(continuationContext),
        instruction: 'priorResearch 仅供理解本轮追问；不得把其中的结论或来源作为本轮事实和引用。'
      })
    }
  ];
}

/**
 * 这是模型边界：Planner 和 Writer 均只得到各自最小必要输入。Worker 不依赖它才能
 * 完成任务，因而模型暂时不可用时不会丢失研究任务或产生虚构报告。
 */
export function createResearchAiService({ qwenClient, model, logger = console }) {
  const available = Boolean(qwenClient && model);

  async function planResearch({ question, continuationContext, signal }) {
    if (shouldUseDirectResearchPlan(question, continuationContext)) {
      return {
        ...createDirectResearchPlan(question),
        diagnostics: {
          mode: 'direct',
          status: 'success',
          reasonCode: '',
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0
        }
      };
    }
    if (!available) {
      return {
        ...createFallbackResearchPlan(question, '未配置研究规划模型', continuationContext),
        diagnostics: {
          mode: 'fallback',
          status: 'degraded',
          reasonCode: 'model_unavailable',
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0
        }
      };
    }
    const startedAt = Date.now();
    try {
      const result = await qwenClient.chatCompletions({
        model,
        stream: false,
        temperature: 0.15,
        max_tokens: 900,
        messages: plannerMessages(question, continuationContext)
      }, { stream: false, signal });
      const plan = normalizeResearchPlan(question, readContent(result), continuationContext);
      const diagnostics = {
        mode: plan.planner,
        status: plan.planner === 'fallback' ? 'degraded' : 'success',
        reasonCode: plan.planner === 'fallback' ? 'invalid_plan' : '',
        durationMs: Date.now() - startedAt,
        inputTokens: Number(result?.usage?.prompt_tokens || 0),
        outputTokens: Number(result?.usage?.completion_tokens || 0)
      };
      return plan.planner === 'fallback'
        ? {
          ...createFallbackResearchPlan(question, plan.fallbackReason, continuationContext),
          diagnostics
        }
        : { ...plan, diagnostics };
    } catch (error) {
      if (signal?.aborted || error?.code === 'REQUEST_ABORTED') throw error;
      logger.warn?.(`[research] planner fallback: ${error?.message || error}`);
      return {
        ...createFallbackResearchPlan(question, '规划模型暂时不可用', continuationContext),
        diagnostics: {
          mode: 'fallback',
          status: 'degraded',
          reasonCode: error?.code === 'REQUEST_TIMEOUT' ? 'request_timeout' : 'upstream_error',
          durationMs: Date.now() - startedAt,
          inputTokens: 0,
          outputTokens: 0
        }
      };
    }
  }

  async function writeResearchReport({ question, plan, evidence, continuationContext, signal }) {
    const evidenceCharacters = Array.isArray(evidence)
      ? evidence.reduce(
        (sum, item) => sum + String(item?.passage || item?.snippet || '').length,
        0
      )
      : 0;
    const baseline = {
      mode: 'fallback',
      status: 'degraded',
      reasonCode: '',
      durationMs: 0,
      evidenceCount: Array.isArray(evidence) ? evidence.length : 0,
      evidenceCharacters,
      inputTokens: 0,
      outputTokens: 0,
      outputCharacters: 0,
      finishReason: ''
    };
    if (!available || !Array.isArray(evidence) || !evidence.length) {
      return {
        draftReport: null,
        diagnostics: {
          ...baseline,
          reasonCode: available ? 'empty_evidence_pack' : 'model_unavailable'
        }
      };
    }
    const startedAt = Date.now();
    try {
      const result = await qwenClient.chatCompletions({
        model,
        stream: false,
        temperature: 0.1,
        max_tokens: 3200,
        messages: writerMessages({ question, plan, evidence, continuationContext })
      }, { stream: false, signal });
      const report = String(readContent(result) || '')
        .replace(/\u0000/g, '')
        .trim()
        .slice(0, 18_000);
      return {
        draftReport: report || null,
        diagnostics: {
          ...baseline,
          mode: report ? 'model' : 'fallback',
          status: report ? 'success' : 'degraded',
          reasonCode: report ? '' : 'empty_output',
          durationMs: Date.now() - startedAt,
          inputTokens: Number(result?.usage?.prompt_tokens || 0),
          outputTokens: Number(result?.usage?.completion_tokens || 0),
          outputCharacters: report.length,
          finishReason: compactText(result?.choices?.[0]?.finish_reason, 40)
        }
      };
    } catch (error) {
      if (signal?.aborted || error?.code === 'REQUEST_ABORTED') throw error;
      logger.warn?.(`[research] writer fallback: ${error?.message || error}`);
      return {
        draftReport: null,
        diagnostics: {
          ...baseline,
          reasonCode: error?.code === 'REQUEST_TIMEOUT' ? 'request_timeout' : 'upstream_error',
          durationMs: Date.now() - startedAt
        }
      };
    }
  }

  return { planResearch, writeResearchReport };
}
