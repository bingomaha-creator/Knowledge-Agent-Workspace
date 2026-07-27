// RAG 召回的纯计算层：提供轻量分词、中文双字组扩展、BM25 候选和 RRF 融合。
// mcp-server 会先从 knowledge-store 取得 FTS 名次，再给 chunk 补上向量相似度，
// 最后调用 rankKnowledgeChunks 产生 topK 与可观测 trace。本模块不读写数据库、不请求 embedding。
// 设计重点是“一路失败仍可检索”：向量或 FTS 任一候选集为空时，另一路仍能独立参与排名。
export function tokenize(input) {
  // 这是检索用的窗口化 tokenizer，不是模型 tokenizer。长度 <= 1 的词被过滤，
  // 中文召回率主要由下方 expandCjkBigrams 生成的连续双字组补足。
  return String(input || '')
    .toLowerCase()
    .replace(/[`*_>#\-[\]()]/g, ' ')
    .split(/[\s，。；：！？、,.!?;:/\\|]+/)
    .filter((token) => token.length > 1);
}

export function expandCjkBigrams(tokens) {
  // 保留原 token 的同时追加重叠双字组，例如“知识库” → “知识”、“识库”。
  // 该策略无需引入分词字典，且与 knowledge-store 写入 FTS 时的扩展规则保持对称。
  const normalizedTokens = tokens.map((token) => String(token || '').toLowerCase()).filter(Boolean);
  const expanded = [...normalizedTokens];
  for (const token of normalizedTokens) {
    const cjkChars = token.match(/[\u4e00-\u9fff]/g);
    if (!cjkChars || cjkChars.length < 2) {
      continue;
    }

    for (let index = 0; index < cjkChars.length - 1; index += 1) {
      expanded.push(`${cjkChars[index]}${cjkChars[index + 1]}`);
    }
  }

  return expanded;
}

function chunkSearchText(chunk) {
  const chunkText = `${chunk.documentName || ''}\n${chunk.text || ''}`.toLowerCase();
  return chunkText;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function chunkTokens(chunk) {
  // 入库时若已保存 tokens 就复用；旧数据缺失时才从文件名+正文重算，保持向后兼容。
  const tokens = Array.isArray(chunk.tokens) && chunk.tokens.length
    ? chunk.tokens
    : tokenize(chunkSearchText(chunk));
  return expandCjkBigrams(tokens);
}

function countTokens(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function summarizeCandidate(chunk) {
  return {
    id: chunk.id,
    title: chunk.documentName,
    vectorScore: typeof chunk.vectorScore === 'number' ? Number(chunk.vectorScore.toFixed(4)) : undefined,
    bm25Score: typeof chunk.bm25Score === 'number' ? Number(chunk.bm25Score.toFixed(4)) : undefined,
    keywordScore: typeof chunk.keywordScore === 'number' ? Number(chunk.keywordScore.toFixed(4)) : undefined
  };
}

function buildLocalBm25Candidates(queryTokens, chunks, limit) {
  // 这是没有外部 FTS 名次时的内存 BM25 后备实现：
  // 1. 统计每个 chunk 的词频与长度；2. 计算查询词的文档频率/IDF；
  // 3. 用 k1 做词频饱和、用 b 抵消长 chunk 的天然优势；4. 按分数降序转成名次。
  // 生产主路径通常使用 SQLite FTS5 的 BM25，这一路便于纯函数调用和降级。
  if (!queryTokens.length || !chunks.length) return [];

  const documents = chunks.map((chunk) => {
    const tokens = chunkTokens(chunk);
    return {
      chunk,
      frequencies: countTokens(tokens),
      length: Math.max(tokens.length, 1)
    };
  });
  const totalDocuments = documents.length;
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / totalDocuments || 1;
  const documentFrequencies = new Map();

  for (const token of queryTokens) {
    const count = documents.reduce(
      (sum, document) => sum + (document.frequencies.has(token) ? 1 : 0),
      0
    );
    documentFrequencies.set(token, count);
  }

  // BM25 的两个常用参数：k1 控制词频饱和速度，b 控制 chunk 长度归一化强度。
  const k1 = 1.5;
  const b = 0.75;

  return documents
    .map((document) => {
      let keywordScore = 0;
      for (const token of queryTokens) {
        const frequency = document.frequencies.get(token) || 0;
        if (!frequency) continue;

        const documentFrequency = documentFrequencies.get(token) || 0;
        const idf = Math.log(1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5));
        const denominator = frequency + k1 * (1 - b + b * (document.length / averageLength));
        keywordScore += idf * ((frequency * (k1 + 1)) / denominator);
      }

      return {
        chunk: {
          ...document.chunk,
          keywordScore
        },
        keywordScore
      };
    })
    .filter((item) => item.keywordScore > 0)
    .sort((a, b) => b.keywordScore - a.keywordScore)
    .slice(0, limit)
    .map((item, index) => ({
      ...item,
      keywordRank: index + 1
    }));
}

function buildKeywordCandidates(queryTokens, chunks, limit) {
  // chunk.keywordRank 表示上游 FTS5 已完成关键词排名；只要存在这种名次就应尊重它，
  // 不再用内存 BM25 重算一套可能不一致的结果。
  const hasExternalKeywordRank = chunks.some((chunk) => Number.isFinite(chunk.keywordRank));
  if (!hasExternalKeywordRank) {
    return buildLocalBm25Candidates(queryTokens, chunks, limit);
  }

  return chunks
    .filter((chunk) => Number.isFinite(chunk.keywordRank))
    .sort((a, b) => a.keywordRank - b.keywordRank)
    .slice(0, limit)
    .map((chunk, index) => ({
      chunk,
      keywordRank: index + 1,
      keywordScore: typeof chunk.keywordScore === 'number' ? chunk.keywordScore : undefined
    }));
}

function buildVectorCandidates(chunks, limit, minVectorScore) {
  // minVectorScore 先淘汰噪声向量；候选集为空时，RRF 会自然只使用关键词路径。
  return chunks
    .filter((chunk) => typeof chunk.vectorScore === 'number' && chunk.vectorScore > minVectorScore)
    .sort((a, b) => b.vectorScore - a.vectorScore)
    .slice(0, limit)
    .map((chunk, index) => ({
      chunk,
      vectorRank: index + 1,
      vectorScore: chunk.vectorScore
    }));
}

function reciprocalRank(rank, rrfK) {
  // RRF 只依赖名次而不依赖原始分数尺度；k 越大，头部名次间的差距越平滑。
  return 1 / (rrfK + rank);
}

// 混合检索的最终入口：同一 chunk 可同时获得 vector 和 keyword 两个候选名次。
// 每个来源贡献 1/(rrfK + rank)，同时命中两路的 chunk 得分相加，但原始分数不直接相加。
// 这避免了 cosine“越大越好”与 SQLite bm25“越小越好”以及两种量纲不同的问题。
// 输出保留 retrieval.sources/rank/score；includeTrace=true 时额外返回候选演化过程供 span/UI 诊断。
export function rankKnowledgeChunks(query, chunks, topK = 4, options = {}) {
  const expandedQueryTokens = unique(expandCjkBigrams(tokenize(query)));
  const candidateLimit = options.candidateLimit || Math.max(topK * 5, 20);
  const minVectorScore = options.minVectorScore ?? 0.15;
  const rrfK = options.rrfK || 60;

  const vectorCandidates = buildVectorCandidates(chunks, candidateLimit, minVectorScore);
  const keywordCandidates = buildKeywordCandidates(expandedQueryTokens, chunks, candidateLimit);
  const fusedById = new Map();

  function ensureFusedCandidate(chunk) {
    if (!fusedById.has(chunk.id)) {
      fusedById.set(chunk.id, {
        chunk,
        retrieval: {
          sources: [],
          rrfScore: 0
        }
      });
    }
    return fusedById.get(chunk.id);
  }

  for (const candidate of vectorCandidates) {
    const fused = ensureFusedCandidate(candidate.chunk);
    fused.retrieval.sources.push('vector');
    fused.retrieval.vectorRank = candidate.vectorRank;
    fused.retrieval.vectorScore = candidate.vectorScore;
    fused.retrieval.rrfScore += reciprocalRank(candidate.vectorRank, rrfK);
  }

  for (const candidate of keywordCandidates) {
    const fused = ensureFusedCandidate(candidate.chunk);
    if (!fused.retrieval.sources.includes('keyword')) {
      fused.retrieval.sources.push('keyword');
    }
    fused.retrieval.keywordRank = candidate.keywordRank;
    fused.retrieval.bm25Score = candidate.chunk.bm25Score;
    fused.retrieval.keywordScore = candidate.chunk.keywordScore ?? candidate.keywordScore;
    fused.retrieval.rrfScore += reciprocalRank(candidate.keywordRank, rrfK);
  }

  const results = [...fusedById.values()]
    .sort((a, b) => {
      if (b.retrieval.rrfScore !== a.retrieval.rrfScore) {
        return b.retrieval.rrfScore - a.retrieval.rrfScore;
      }
      return (b.retrieval.vectorScore || 0) - (a.retrieval.vectorScore || 0);
    })
    .slice(0, topK)
    .map((item, index) => ({
      ...item.chunk,
      score: item.retrieval.rrfScore,
      retrieval: {
        ...item.retrieval,
        finalRank: index + 1,
        rrfScore: Number(item.retrieval.rrfScore.toFixed(6))
      }
    }));

  const trace = {
    // trace 是观测数据而非下一轮排序输入；只保留摘要，避免复制整段文档正文。
    queryTokens: expandedQueryTokens,
    vectorCandidates: vectorCandidates.map((candidate) => ({
      rank: candidate.vectorRank,
      ...summarizeCandidate(candidate.chunk)
    })),
    keywordCandidates: keywordCandidates.map((candidate) => ({
      rank: candidate.keywordRank,
      ...summarizeCandidate(candidate.chunk)
    })),
    fusedCandidates: results.map((chunk) => ({
      rank: chunk.retrieval.finalRank,
      id: chunk.id,
      title: chunk.documentName,
      sources: chunk.retrieval.sources,
      vectorRank: chunk.retrieval.vectorRank,
      keywordRank: chunk.retrieval.keywordRank,
      rrfScore: chunk.retrieval.rrfScore
    }))
  };

  return options.includeTrace ? { results, trace } : results;
}
