// 知识文档的纯分块模块：输入文件名与原文，输出 { text, headingPath, kind } 数组。
// Markdown 会保留标题层级与代码围栏，普通文本则使用带重叠的长度切分。
// 该模块不生成 ID/token 列表/embedding，也不读写 SQLite；mcp-server 在后续流程中补齐这些数据。
// 实现刻意保持轻量，它是用于 RAG 分块的结构化扫描器，不是完整 CommonMark 渲染器。
const MARKDOWN_EXTENSIONS = /\.(md|markdown)$/i;
const LONG_ASCII_TOKEN_LENGTH = 24;

function estimateUnitTokenCount(value) {
  if (!value || /^\s+$/.test(value)) return 0;
  return 1;
}

// 这里不是精确复刻某个模型 tokenizer，而是做轻量 token 预算估算：
// - 普通英文单词按 1 个 token 粗估；
// - 中文按单字计数，更接近中文上下文成本；
// - 过长的连续英文/数字串按字符拆开，避免超长 URL/hash 被当成 1 个 token。
function createTokenUnits(text) {
  const matches = String(text || '').match(/\s+|[\u4e00-\u9fff]|[A-Za-z0-9_]+|[^\s]/g) || [];
  return matches.flatMap((value) => {
    if (/^[A-Za-z0-9_]+$/.test(value) && value.length > LONG_ASCII_TOKEN_LENGTH) {
      return [...value].map((char) => ({ text: char, cost: 1 }));
    }

    return {
      text: value,
      cost: estimateUnitTokenCount(value)
    };
  });
}

function estimateTokenCount(text) {
  // 返回的是分块预算单位，不应当作模型 usage/token 计费数据。
  return createTokenUnits(text).reduce((sum, unit) => sum + unit.cost, 0);
}

// 兜底分块：用于普通文本，或者 Markdown 某个结构化块仍然超过 token 预算的场景。
// overlap 现在也是按 token 粗估，而不是按字符数，能更贴近模型上下文窗口。
function splitWithOverlap(text, chunkSize, overlap) {
  // 每轮先向右累加预算到 chunkSize，再从末尾向左回退 overlap 个预算单位，
  // 让相邻 chunk 共享少量上下文。safeOverlap 严格小于 chunkSize，下方进度保护
  // 则确保空白或极端参数下 start 仍然向前，不会死循环。
  const chunks = [];
  const units = createTokenUnits(text);
  let start = 0;
  const safeOverlap = Math.max(0, Math.min(overlap, chunkSize - 1));

  while (start < units.length) {
    let end = start;
    let tokenCount = 0;

    while (end < units.length) {
      const nextCost = units[end].cost;
      if (tokenCount > 0 && tokenCount + nextCost > chunkSize) break;
      tokenCount += nextCost;
      end += 1;
      if (tokenCount >= chunkSize) break;
    }

    const value = units.slice(start, end).map((unit) => unit.text).join('').trim();
    if (value) chunks.push(value);

    if (end >= units.length) break;

    let nextStart = end;
    let overlapTokens = 0;
    while (nextStart > start && overlapTokens < safeOverlap) {
      nextStart -= 1;
      overlapTokens += units[nextStart].cost;
    }

    start = nextStart > start ? nextStart : end;
  }

  return chunks;
}

// 目前只有 Markdown 文件走结构化解析；txt/json 等仍然走固定长度切分。
function isMarkdownDocument(name) {
  return MARKDOWN_EXTENSIONS.test(name || '');
}

// 识别 Markdown 标题，例如：
// # 一级标题
// ## 二级标题
// ### 三级标题 ###
// 返回 level + title，后续用它维护当前块所在的标题路径。
function normalizeHeading(line) {
  // CommonMark 只有在结尾 # 前存在空白时才把它视为 closing sequence。
  // 因此 `# C#` 的标题必须保留末尾 #，而 `# Title ###` 可去掉装饰性井号。
  const match = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line.trim());
  if (!match) return null;

  return {
    level: match[1].length,
    title: match[2].trim()
  };
}

// 把标题路径补回 chunk 正文前面，让向量检索时不只看到段落内容，
// 也能看到“这段话属于哪个章节”。这对“核心能力是什么”这类问题很重要。
function headingPrefix(headingPath) {
  if (!headingPath.length) return '';
  return headingPath.map((heading, index) => `${'#'.repeat(Math.min(index + 1, 6))} ${heading}`).join('\n');
}

// 一个 chunk 最终进入 embedding 的文本 = 标题上下文 + 段落/代码块正文。
function createChunkText(blocks, headingPath) {
  const prefix = headingPrefix(headingPath);
  const body = blocks.map((block) => block.text).join('\n\n').trim();
  return [prefix, body].filter(Boolean).join('\n\n').trim();
}

function splitChunkWithContext(blocks, headingPath, options) {
  // 超限的结构化块不能直接丢掉标题：先为标题/代码围栏预留预算，
  // 只切分正文，再把上下文补回每个 piece。这样 embedding 可理解片段属于哪一节，
  // 同时代码片段仍保持可识别的 fenced-code 形状。
  let prefix = headingPrefix(headingPath);
  const body = blocks.map((block) => block.text).join('\n\n').trim();
  const fullText = [prefix, body].filter(Boolean).join('\n\n').trim();
  if (estimateTokenCount(fullText) <= options.chunkSize) {
    return [fullText];
  }

  // 极端长标题只保留一个受控前缀，避免标题本身挤占完整 chunk 预算。
  const prefixBudget = Math.max(1, Math.floor(options.chunkSize / 3));
  if (prefix && estimateTokenCount(prefix) > prefixBudget) {
    prefix = splitWithOverlap(prefix, prefixBudget, 0)[0] || '';
  }

  const onlyBlock = blocks.length === 1 ? blocks[0] : null;
  let bodyToSplit = body;
  let codeOpening = '';
  let codeClosing = '';

  if (onlyBlock?.type === 'code') {
    const lines = body.split(/\r?\n/);
    const openingMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[0] || '');
    if (openingMatch) {
      codeOpening = lines[0];
      codeClosing = openingMatch[1];
      const hasClosing = lines.length > 1 && lines.at(-1)?.trim().startsWith(codeClosing);
      bodyToSplit = lines.slice(1, hasClosing ? -1 : undefined).join('\n');
    }
  }

  const contextCost = estimateTokenCount(
    [prefix, codeOpening, codeClosing].filter(Boolean).join('\n')
  );
  const bodyBudget = Math.max(1, options.chunkSize - contextCost);
  const pieces = splitWithOverlap(
    bodyToSplit,
    bodyBudget,
    Math.min(options.overlap, Math.max(0, bodyBudget - 1))
  );

  return pieces.map((piece) =>
    [prefix, codeOpening, piece, codeClosing].filter(Boolean).join('\n\n').trim()
  );
}

// 把当前收集到的一组 block 真正写入 chunks。
// 如果加上标题后的文本仍然超过 token 预算，再退回 overlap 切分，避免单个 chunk 太大。
function pushChunk(chunks, blocks, headingPath, options) {
  if (!blocks.length) return;

  const pieces = splitChunkWithContext(blocks, headingPath, options);

  for (const piece of pieces) {
    chunks.push({
      text: piece,
      headingPath: [...headingPath],
      kind: headingPath.length ? 'markdown-section' : 'markdown-root'
    });
  }
}

// 轻量级 Markdown 解析器：
// 1. 标题负责更新 headingStack；
// 2. 空行负责结束当前段落；
// 3. 代码围栏整体作为一个 code block，避免代码被按空行拆散；
// 4. 每个 block 都记录当时的 headingPath。
//
// 这里没有引入完整 Markdown AST，主要是为了保持实现轻、依赖少，也方便学习调试。
function parseMarkdownBlocks(content) {
  // block 是中间数据结构：{ type: 'paragraph'|'code', text, headingPath }。
  // headingStack 保存当前标题链；遇到同级或更高级标题时弹出旧分支，
  // 因此每个 block 都拍下它生成当时的完整章节路径快照。
  const lines = content.split(/\r?\n/);
  const blocks = [];
  const headingStack = [];
  let paragraph = [];
  let codeFence = null;
  let codeLines = [];

  function currentHeadingPath() {
    return headingStack.map((item) => item.title);
  }

  // 遇到空行、标题、代码块开始时，把已经积累的普通文本段落落盘成 block。
  function flushParagraph() {
    const text = paragraph.join('\n').trim();
    if (text) {
      blocks.push({
        type: 'paragraph',
        text,
        headingPath: currentHeadingPath()
      });
    }
    paragraph = [];
  }

  // 代码块要整体保留，包括起止围栏，这样模型看到引用片段时仍然知道它是代码。
  function flushCode() {
    const text = codeLines.join('\n').trim();
    if (text) {
      blocks.push({
        type: 'code',
        text,
        headingPath: currentHeadingPath()
      });
    }
    codeLines = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (codeFence) {
      codeLines.push(line);
      // codeFence 只记录前三个字符：``` 或 ~~~。
      // 只要再次遇到同类围栏，就认为代码块结束。
      if (trimmed.startsWith(codeFence)) {
        flushCode();
        codeFence = null;
      }
      continue;
    }

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      // 代码块开始前，先结束上一段普通段落，避免段落和代码混在一个 block 里。
      flushParagraph();
      codeFence = trimmed.slice(0, 3);
      codeLines = [line];
      continue;
    }

    const heading = normalizeHeading(line);
    if (heading) {
      flushParagraph();
      // Markdown 标题是有层级的：
      // 从 ## 切到另一个 ## 时，弹出旧的同级标题；
      // 从 ### 回到 ## 时，弹出更深层标题。
      while (headingStack.length && headingStack[headingStack.length - 1].level >= heading.level) {
        headingStack.pop();
      }
      headingStack.push(heading);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    paragraph.push(line);
  }

  if (codeFence) {
    // 如果文档里代码围栏没闭合，也不要丢内容，按一个代码块保留下来。
    flushCode();
  }
  flushParagraph();

  return blocks;
}

// 按“章节 + token 预算”把 block 组合成最终 chunks。
// 同一个标题路径下的小段会尽量合并；遇到新章节或长度超限时，就生成一个 chunk。
function groupMarkdownBlocks(blocks, options) {
  // 这是第二阶段分组：第一阶段 parseMarkdownBlocks 保留语法边界，
  // 此处再将同一 headingPath 下的小 block 贪心合并到预算上限。
  // 章节变化会立即落块，所以不会为了填满 chunk 而把两个不同章节混合。
  const chunks = [];
  let currentBlocks = [];
  let currentHeadingPath = [];

  for (const block of blocks) {
    const sameSection = JSON.stringify(block.headingPath) === JSON.stringify(currentHeadingPath);
    if (!sameSection) {
      pushChunk(chunks, currentBlocks, currentHeadingPath, options);
      currentBlocks = [];
      currentHeadingPath = [...block.headingPath];
    }

    const nextText = createChunkText([...currentBlocks, block], currentHeadingPath);
    if (currentBlocks.length && estimateTokenCount(nextText) > options.chunkSize) {
      pushChunk(chunks, currentBlocks, currentHeadingPath, options);
      currentBlocks = [block];
      continue;
    }

    currentBlocks.push(block);
  }

  pushChunk(chunks, currentBlocks, currentHeadingPath, options);
  return chunks;
}

// 对外暴露的分块入口：mcp-server 处理 queued 文档时调用。
// name 只用于判断 Markdown 类型，content 会 trim；chunkSize/overlap 均是上述轻量 token 预算。
// 输出的 text 已包含需要送入 embedding 的标题上下文，headingPath 另行保留供引用 UI 展示。
// 空文档返回 []，由调用者决定将文档标记为 failed，这里不产生业务错误。
export function chunkDocument({ name = '', content = '', chunkSize = 900, overlap = 160 }) {
  const text = content.trim();
  if (!text) return [];

  if (!isMarkdownDocument(name)) {
    // 非 Markdown 文件没有标题结构可利用，直接使用固定长度 + overlap 分块。
    return splitWithOverlap(text, chunkSize, overlap).map((part) => ({
      text: part,
      headingPath: [],
      kind: 'plain-text'
    }));
  }

  const blocks = parseMarkdownBlocks(text);
  if (!blocks.length) {
    return [];
  }

  return groupMarkdownBlocks(blocks, { chunkSize, overlap });
}

// 暴露少量内部函数给测试文件使用。
// 生产代码只需要 chunkDocument；测试则可以单独验证解析和兜底切分是否正确。
export const __test__ = {
  isMarkdownDocument,
  parseMarkdownBlocks,
  estimateTokenCount,
  splitWithOverlap
};
