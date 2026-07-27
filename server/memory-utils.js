import { expandCjkBigrams, tokenize } from './rag-utils.js';

// 长期记忆的纯业务工具层：候选预筛/解析、敏感信息拦截、语义去重、召回排名和提示词组装。
// 调用者 mcp-server 负责模型与 embedding I/O，memory-store 负责 SQLite；本文件无外部副作用。
// 重要安全边界：这些 helper 不会自动把整段对话持久化，只产生结构化候选，
// 候选必须经用户确认/纠正后才能成为可召回记忆。
const MEMORY_TYPES = new Set(['profile', 'preference', 'fact', 'event', 'pitfall']);
// 这些正则只是低成本“是否值得再问模型”信号，不是最终保存判断。
const MEMORY_SIGNALS = [
  /(?:请|帮我)?记住|以后(?:请|要)|下次(?:请|要)/i,
  /我(?:叫|是|在|来自|住在|工作于|就职于|负责)/i,
  /我(?:喜欢|偏好|习惯|不喜欢|讨厌|希望|更喜欢)/i,
  /我(?:去年|今年|上周|昨天|今天|曾经|计划|准备|参加|去了|完成)/i,
  /(?:报错|错误|失败|异常|修复|解决|根因|踩坑|bug|debug|fix)/i
];
const SENSITIVE_PATTERNS = [
  // 覆盖常见联系方式、身份标识、私钥、JWT 与主流服务 token；
  // 它是输出校验的防线，不能替代模型 prompt 中“不要提取敏感信息”的约束。
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:\+?86[-\s]?)?1[3-9]\d{9}\b/,
  /\b\d{17}[\dX]\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|pk)-[A-Z0-9_-]{16,}\b/i,
  /\bgh[pousr]_[A-Z0-9]{20,}\b/i,
  /\bgithub_pat_[A-Z0-9_]{20,}\b/i,
  /\bxox[baprs]-[A-Z0-9-]{10,}\b/i,
  /\bAIza[A-Z0-9_-]{30,}\b/i,
  /\bnpm_[A-Z0-9]{30,}\b/i,
  /\b(?:sk|pk)_(?:live|test)_[A-Z0-9]{16,}\b/i,
  /\bBearer\s+[A-Z0-9._~+\/-]{12,}/i,
  /\beyJ[A-Z0-9_-]{8,}\.[A-Z0-9_-]{8,}\.[A-Z0-9_-]{8,}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /(?:password|passwd|密码|口令|secret|api[_\s-]?key|access[_\s-]?token|refresh[_\s-]?token)\s*[:=：]\s*\S{4,}/i
];

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(values, limit = 20) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))].slice(0, limit);
}

export function shouldSuggestMemoryCandidate({ userContent = '' }) {
  // 只有用户输入能启动候选支线，避免助手自己的技术措辞反过来制造“踩坑记忆”。
  // false 意味着跳过额外模型调用；true 仍需后续模型判断、结构校验和人工审查。
  return MEMORY_SIGNALS.some((signal) => signal.test(userContent));
}

export function containsSensitiveMemory(value) {
  // JSON 序列化本身失败时按敏感处理（fail closed），不为了可用性放行无法检查的对象。
  let text = '';
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  } catch {
    return true;
  }
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function normalizeMemoryCandidate(candidate) {
  // 模型输出是不可信输入：非法 type 降级为 fact，confidence 夹到 [0,1]，
  // tags 去重限数，缺少标题/内容或命中敏感规则则整个候选作废。
  if (!candidate || typeof candidate !== 'object') return null;
  const type = clean(candidate.type).toLowerCase();
  const numericConfidence = Number(candidate.confidence);
  const normalized = {
    type: MEMORY_TYPES.has(type) ? type : 'fact',
    title: clean(candidate.title),
    content: clean(candidate.content),
    details: candidate.details && typeof candidate.details === 'object' ? candidate.details : {},
    confidence: Number.isFinite(numericConfidence)
      ? Math.max(0, Math.min(1, numericConfidence))
      : 0.5,
    tags: uniqueStrings(candidate.tags, 8)
  };
  if (!normalized.title || !normalized.content) return null;
  if (containsSensitiveMemory(normalized)) return null;
  return normalized;
}

function stripJsonFence(raw) {
  const text = clean(raw);
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

export function parseMemoryCandidateResponse(raw) {
  // 兼容模型偶尔返回 ```json 围栏或 JSON 前后解释文字；解析失败直接返回 null。
  // 记忆提取是增强功能，不应因一次非法模型输出中断主对话。
  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    return null;
  }
  if (parsed?.shouldSave === false) return null;
  return normalizeMemoryCandidate(parsed);
}

export function buildMemoryCandidatePrompt({ userContent, assistantContent }) {
  // 只请模型返回一个可审查候选，不授权它直接写库；parse/normalize 仍会在输出端复验。
  return [
    '判断这轮对话是否包含未来确实有帮助、且适合让用户审查的长期记忆候选。',
    '不要保存密码、密钥、身份号码、联系方式等敏感信息，也不要保存普通寒暄或一次性指令。',
    '候选类型只能是：profile（用户画像）、preference（偏好）、fact（稳定事实）、event（带时间事件）、pitfall（技术踩坑）。',
    '只返回 JSON，不要 Markdown。',
    '',
    '值得保存时：',
    '{"shouldSave":true,"type":"preference","title":"简短标题","content":"独立完整的记忆陈述","confidence":0.8,"details":{},"tags":[]}',
    '不值得保存时：{"shouldSave":false}',
    '',
    `用户：${userContent}`,
    '',
    `助手：${assistantContent}`
  ].join('\n');
}

export function buildMemorySearchText(memory) {
  // 将不同 type 的通用字段压平成同一 embedding/关键词检索文本，不包含来源原文。
  const details = memory?.details && typeof memory.details === 'object'
    ? JSON.stringify(memory.details)
    : '';
  return [memory?.type, memory?.title, memory?.content, details].filter(Boolean).join('\n');
}

export function buildPitfallDetailsFromContent(content, tags = []) {
  // 新通用记忆 API 与旧 pitfall API 的适配器：从“现象/根因/方案/经验”行提取 details。
  // 无结构标记时把全文同时作为 symptom/solution，确保旧界面仍有可展示的必填字段。
  const text = clean(content);
  const details = {
    symptom: '',
    cause: '',
    solution: '',
    lesson: '',
    tags: uniqueStrings(tags, 30)
  };
  const fields = {
    '现象': 'symptom',
    '根因': 'cause',
    '方案': 'solution',
    '经验': 'lesson'
  };
  for (const line of text.split(/\r?\n/)) {
    const match = /^(现象|根因|方案|经验)\s*[：:]\s*(.+)$/.exec(line.trim());
    if (match) details[fields[match[1]]] = match[2].trim();
  }
  if (!details.symptom && !details.solution) {
    details.symptom = text;
    details.solution = text;
  }
  return details;
}

function cosineSimilarity(a, b) {
  // 空向量或维度不同直接返回 0，使 embedding 不可用/模型切换时可降级到文本路径。
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] ** 2;
    normB += b[index] ** 2;
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

function lexicalScore(queryTokens, memory) {
  if (!queryTokens.length) return 0;
  const text = buildMemorySearchText(memory).toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (text.includes(token)) hits += 1;
  }
  return hits / queryTokens.length;
}

const PROFILE_QUERY_SIGNAL = /前端|后端|全栈|开发|工程师|技术栈|职业|求职|简历|面试|秋招|学习|项目|工作/u;
const EVENT_QUERY_SIGNAL = /计划|安排|进度|截止|时间|何时|什么时候|今天|明天|下周|本月|今年|秋招|面试/u;
const DIAGNOSTIC_QUERY_SIGNAL = /报错|错误|异常|失败|故障|问题|排查|诊断|修复|调试|崩溃|不工作|无法|卡住|bug/u;

function supportsCurrentQuestion({ keywordScore, vectorScore }) {
  // 有明确词法命中，或向量相似度足够高时才视作和当前问题有关。
  // 不能只凭置信度把历史记忆带入本轮上下文。
  return keywordScore > 0 || vectorScore >= 0.55;
}

function canUseMemoryForQuery(memory, query, scores) {
  const supported = supportsCurrentQuestion(scores);
  switch (memory.type) {
    case 'preference':
      // 偏好是对回答方式的软约束，而非事实证据；最多带入一条，见下方限制。
      return true;
    case 'profile':
      return PROFILE_QUERY_SIGNAL.test(query) && supported;
    case 'event':
      return EVENT_QUERY_SIGNAL.test(query) && supported;
    case 'pitfall':
      // 踩坑记忆只在用户明确处于诊断/修复语境时使用，避免普通技术讨论被旧问题干扰。
      return DIAGNOSTIC_QUERY_SIGNAL.test(query) && supported;
    case 'fact':
    default:
      return supported;
  }
}

export function rankMemories(query, memories, topK = 4) {
  // 召回先判断“这类记忆在此问题中是否有资格出现”，再按相关性排序。
  // 例如 pitfall 需要诊断语境，event 需要时间/计划语境；这样已确认记忆不会每轮全量进入 Context Pack。
  // preference 是唯一的软规则，允许一条常驻；confidence 只在相关结果中轻微破平。
  // 调用者必须先把集合限定为 confirmed/corrected。
  const safeQuery = String(query || '').slice(0, 4000);
  const queryTokens = [...new Set(expandCjkBigrams(tokenize(safeQuery)))].slice(0, 256);
  const ranked = memories
    .map((memory) => {
      const vectorScore = Number(memory.vectorScore) || 0;
      const keywordScore = lexicalScore(queryTokens, memory);
      const numericConfidence = Number(memory.confidence);
      const confidence = Number.isFinite(numericConfidence) ? numericConfidence : 0.5;
      const relevance = keywordScore > 0
        ? keywordScore * 0.7 + vectorScore * 0.25 + confidence * 0.05
        : vectorScore * 0.85 + confidence * 0.05;
      return {
        ...memory,
        score: Number((memory.type === 'preference' ? Math.max(relevance, 0.12) : relevance).toFixed(4)),
        queryScores: { keywordScore, vectorScore }
      };
    })
    .filter((memory) => canUseMemoryForQuery(memory, safeQuery, memory.queryScores));
  const preferenceIds = new Set(
    ranked
      .filter((memory) => memory.type === 'preference')
      .sort((a, b) => b.score - a.score)
      .slice(0, 1)
      .map((memory) => memory.id)
  );
  return ranked
    .filter((memory) => memory.type !== 'preference' || preferenceIds.has(memory.id))
    .map(({ queryScores, ...memory }) => memory)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function findSemanticDuplicate(candidateEmbedding, memories, threshold = 0.9) {
  // 语义去重是指纹去重之后的第二道关：返回超过阈值的最相似现有记忆。
  // 空/不同维向量不会误判重复；memories 的状态和 type 过滤由调用者按业务场景完成。
  let best = null;
  let bestScore = threshold;
  for (const memory of memories) {
    const score = cosineSimilarity(candidateEmbedding, memory.embedding);
    if (score >= bestScore) {
      best = memory;
      bestScore = score;
    }
  }
  return best;
}

export function buildMemoryContext(memories) {
  // 本函数只负责排版，不再过滤状态；上游必须只传入相关的 confirmed/corrected 记忆。
  // 不注入 sourceExcerpt，避免将用户原话不必要地回放给模型。
  if (!Array.isArray(memories) || !memories.length) return '';
  return [
    '【用户已确认的长期记忆】',
    '以下内容经过用户确认或纠正。仅在与当前问题相关时自然使用，不要夸大或泄露来源原文：',
    ...memories.map((memory, index) =>
      `${index + 1}. [${memory.type}] ${memory.title}\n${memory.content}`
    )
  ].join('\n\n');
}
