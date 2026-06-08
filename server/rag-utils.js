export function tokenize(input) {
  return input
    .toLowerCase()
    .replace(/[`*_>#\-[\]()]/g, ' ')
    .split(/[\s，。；：！？、,.!?;:/\\|]+/)
    .filter((token) => token.length > 1);
}

function expandCjkBigrams(tokens) {
  const expanded = [...tokens];
  for (const token of tokens) {
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

function keywordScore(queryTokens, chunk) {
  const expandedQueryTokens = expandCjkBigrams(queryTokens);
  if (!expandedQueryTokens.length) {
    return 0;
  }

  const chunkText = `${chunk.documentName || ''}\n${chunk.text || ''}`.toLowerCase();
  const chunkTokens = new Set(expandCjkBigrams(chunk.tokens || tokenize(chunkText)));
  let hits = 0;

  for (const token of expandedQueryTokens) {
    if (chunkTokens.has(token) || chunkText.includes(token)) {
      hits += 1;
    }
  }

  return hits / expandedQueryTokens.length;
}

export function rankKnowledgeChunks(query, chunks, topK = 4) {
  const queryTokens = tokenize(query);

  return chunks
    .map((chunk) => {
      const vectorScore = typeof chunk.vectorScore === 'number' ? chunk.vectorScore : 0;
      const lexicalScore = keywordScore(queryTokens, chunk);
      return {
        chunk,
        vectorScore,
        lexicalScore,
        score: Math.max(vectorScore, lexicalScore * 0.75)
      };
    })
    .filter((item) => item.vectorScore > 0.15 || item.lexicalScore > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ chunk, score }) => ({
      ...chunk,
      score
    }));
}
