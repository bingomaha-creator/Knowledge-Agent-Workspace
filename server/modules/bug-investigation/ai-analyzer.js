function compact(value, limit) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function readContent(result) {
  return result?.choices?.[0]?.message?.content || result?.choices?.[0]?.text || '';
}

function parseJsonObject(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeStringList(value, limit, itemLimit) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.map((item) => compact(item, itemLimit)).filter(Boolean)
  )].slice(0, limit);
}

const TECHNOLOGY_TERMS = [
  'SSE',
  'EventSource',
  'Service Worker',
  'CORS',
  'fetch',
  'Axios',
  'WebSocket',
  'GraphQL',
  'React',
  'Vue',
  'Pinia',
  'Vite',
  'Vitest',
  'Playwright',
  'Node.js'
];

function containsUngroundedTechnology(value, groundingText) {
  const text = String(value || '').toLocaleLowerCase();
  const grounded = String(groundingText || '').toLocaleLowerCase();
  return TECHNOLOGY_TERMS.some((term) => {
    const normalized = term.toLocaleLowerCase();
    return text.includes(normalized) && !grounded.includes(normalized);
  });
}

function distinctSupportIds(hypothesis) {
  return new Set([
    ...hypothesis.supportingEvidenceIds.map((id) => `evidence:${id}`),
    ...hypothesis.relatedCaseIds.map((id) => `case:${id}`)
  ]);
}

function selectGovernedHypotheses(hypotheses) {
  if (!hypotheses.length) return [];
  const selected = [hypotheses[0]];
  const primarySupport = distinctSupportIds(hypotheses[0]);
  const alternative = hypotheses.slice(1).find((hypothesis) =>
    [...distinctSupportIds(hypothesis)].some((id) => !primarySupport.has(id))
  );
  if (alternative) selected.push(alternative);
  return selected;
}

function evidenceRequestAlreadySatisfied(request, evidence, facts) {
  const text = String(request || '');
  const lowerText = text.toLocaleLowerCase();
  const types = new Set(evidence.map((item) => item.type));

  if (/复现|操作步骤|触发步骤/u.test(text) && types.has('reproduction')) return true;
  if (
    /环境|版本|浏览器|运行时/u.test(text)
    && (
      types.has('environment')
      || (facts.frameworks || []).length
      || (facts.environments || []).length
      || (facts.languages || []).length
    )
  ) {
    return true;
  }
  if (/network|网络|请求|响应|header|状态码|请求体|响应体/iu.test(text) && types.has('network')) {
    return true;
  }
  if (/验证结果|人工验证/u.test(text) && types.has('verification')) return true;

  if (/源码|代码|函数|调用点|文件片段/u.test(text)) {
    const codeText = evidence
      .filter((item) => item.type === 'code')
      .map((item) => item.content)
      .join('\n')
      .toLocaleLowerCase();
    if (!codeText) return false;
    const identifiers = [...lowerText.matchAll(/\b[A-Za-z_$][\w$]{2,}\b/g)]
      .map((match) => match[0])
      .filter((identifier) =>
        !['code', 'file', 'function', 'source', 'context'].includes(identifier)
      );
    return identifiers.length > 0 && identifiers.some((identifier) => codeText.includes(identifier));
  }

  return false;
}

function normalizeAnalysis(value, evidence, relatedCaseIds, groundingText, facts) {
  if (!value) return null;
  const allowedIds = new Set(evidence.map((item) => item.id));
  const allowedCaseIds = new Set(relatedCaseIds);
  const normalizedHypotheses = Array.isArray(value.hypotheses)
    ? value.hypotheses.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const title = compact(item.title, 240);
      const reasoning = compact(item.reasoning, 1_800);
      if (!title || !reasoning) return [];
      if (containsUngroundedTechnology(`${title}\n${reasoning}`, groundingText)) {
        return [];
      }
      const supportingEvidenceIds = normalizeStringList(item.supportingEvidenceIds, 20, 160)
        .filter((id) => allowedIds.has(id));
      if (!supportingEvidenceIds.length) return [];
      const confidenceLabel = ['supported', 'plausible', 'weak'].includes(item.confidenceLabel)
        ? item.confidenceLabel
        : 'weak';
      return [{
        title,
        reasoning,
        confidenceLabel,
        supportingEvidenceIds,
        counterEvidenceIds: normalizeStringList(item.counterEvidenceIds, 20, 160)
          .filter((id) => allowedIds.has(id)),
        relatedCaseIds: normalizeStringList(item.relatedCaseIds, 10, 160)
          .filter((id) => allowedCaseIds.has(id))
      }];
    })
    : [];
  const hypotheses = selectGovernedHypotheses(normalizedHypotheses)
    .slice(0, 2);
  const verificationSteps = Array.isArray(value.verificationSteps)
    ? value.verificationSteps.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const title = compact(item.title, 200);
      const instruction = compact(item.instruction, 1_000);
      const supportingSignal = compact(
        item.supportingSignal || item.expectedSignal,
        600
      );
      const refutingSignal = compact(item.refutingSignal, 600);
      if (!title || !instruction || !supportingSignal || !refutingSignal) return [];
      return [{
        title,
        instruction,
        supportingSignal,
        refutingSignal
      }];
    }).slice(0, 8)
    : [];
  return {
    hypotheses,
    verificationSteps,
    missingEvidence: normalizeStringList(value.missingEvidence, 10, 500)
      .filter((item) => !containsUngroundedTechnology(item, groundingText))
      .filter((item) => !evidenceRequestAlreadySatisfied(item, evidence, facts))
  };
}

function analyzerMessages({ facts, evidence, similarCases, quality }) {
  return [
    {
      role: 'system',
      content: [
        '你是前端 Bug 调查分析器，只能基于给定的已脱敏证据、确定性事实和已确认历史案例进行分析。',
        '严格区分事实与假设；绝不能声称根因已经确认，也不能虚构文件、日志、调用链或测试结果。',
        '不得引入输入中没有出现的框架、协议、运行环境或工具名；例如证据未出现 SSE、Service Worker、CORS 时不得自行补造。',
        '优先输出 1 个最值得验证的主假设；仅当存在机制明显不同且有独立证据支持的备选方向时，才输出第 2 个假设。',
        '最多输出 2 个根因假设；证据有限时使用 plausible/weak，不得伪造 supported。',
        '每个假设必须解释推理，并通过 supportingEvidenceIds 引用输入证据；若历史案例相关可填写 relatedCaseIds。',
        '验证步骤必须具体、可执行，并分别填写 supportingSignal 与 refutingSignal。',
        'supportingSignal 必须描述“观察到什么会提高主假设可信度”；refutingSignal 必须描述“观察到什么会降低或排除主假设”，不得把错误消失写成证伪导致该错误的机制。',
        'missingEvidence 按优先级排列，第一项必须是用户下一步最值得补充的一份具体证据；已知函数或文件名时应直接点名。',
        '不得把输入 evidence 中已经提供的代码、复现步骤、环境、网络记录或验证结果再次列为缺失证据。',
        '只输出 JSON，不输出 Markdown。',
        'JSON Schema: {"hypotheses":[{"title":"...","reasoning":"...","confidenceLabel":"supported|plausible|weak","supportingEvidenceIds":["..."],"counterEvidenceIds":["..."],"relatedCaseIds":["..."]}],"verificationSteps":[{"title":"...","instruction":"...","supportingSignal":"...","refutingSignal":"..."}],"missingEvidence":["..."]}'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        evidenceQuality: quality,
        facts,
        evidence: evidence.map((item) => ({
          id: item.id,
          type: item.type,
          content: compact(item.content, item.type === 'code' ? 6_000 : 4_000),
          metadata: item.metadata
        })),
        confirmedSimilarCases: similarCases.map((item) => ({
          id: item.id,
          title: item.title,
          scope: item.scope,
          rootCause: compact(item.rootCause, 1_000),
          fix: compact(item.fix, 1_000),
          matchedChannels: item.matchedChannels
        }))
      })
    }
  ];
}

/**
 * 模型只是 Investigation 深模块的一个可选内部 adapter。返回值携带降级原因，
 * 调用方即使拿不到模型结果，也能继续交付确定性事实和历史案例。
 */
export function createBugInvestigationAiService({
  qwenClient,
  model,
  logger = console,
  now = () => Date.now()
}) {
  const available = Boolean(qwenClient && model);

  async function analyze(input, signal) {
    const baseline = {
      mode: available ? 'model' : 'deterministic',
      status: available ? 'failed' : 'degraded',
      reasonCode: available ? 'unknown' : 'model_unavailable',
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0
    };
    if (!available) return { output: null, diagnostics: baseline };

    const startedAt = now();
    try {
      const result = await qwenClient.chatCompletions({
        model,
        stream: false,
        temperature: 0.1,
        max_tokens: 1_600,
        messages: analyzerMessages(input)
      }, { stream: false, signal });
      const output = normalizeAnalysis(
        parseJsonObject(readContent(result)),
        input.evidence,
        input.similarCases.map((item) => item.id),
        JSON.stringify({
          facts: input.facts,
          evidence: input.evidence,
          similarCases: input.similarCases
        }),
        input.facts
      );
      if (!output) {
        return {
          output: null,
          diagnostics: {
            ...baseline,
            status: 'degraded',
            reasonCode: 'invalid_model_output',
            durationMs: now() - startedAt,
            inputTokens: Number(result?.usage?.prompt_tokens || 0),
            outputTokens: Number(result?.usage?.completion_tokens || 0)
          }
        };
      }
      return {
        output,
        diagnostics: {
          ...baseline,
          status: 'success',
          reasonCode: '',
          durationMs: now() - startedAt,
          inputTokens: Number(result?.usage?.prompt_tokens || 0),
          outputTokens: Number(result?.usage?.completion_tokens || 0)
        }
      };
    } catch (error) {
      if (signal?.aborted || error?.code === 'REQUEST_ABORTED') throw error;
      logger.warn?.(`[bug-investigation] analyzer degraded: ${error?.message || error}`);
      return {
        output: null,
        diagnostics: {
          ...baseline,
          status: 'degraded',
          reasonCode: error?.code || 'upstream_error',
          durationMs: now() - startedAt
        }
      };
    }
  }

  return { analyze };
}
