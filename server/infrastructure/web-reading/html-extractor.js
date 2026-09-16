import { createHash } from 'node:crypto';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

const DEFAULT_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CONTENT_CHARACTERS = 160_000;

function extractionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Phase 0 preflight: pure HTML-to-document extraction. Network safety belongs to Phase 1. */
export function extractReadableHtml({
  html,
  url,
  maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
  maxContentCharacters = DEFAULT_MAX_CONTENT_CHARACTERS
}) {
  if (typeof html !== 'string' || !html.trim()) {
    throw extractionError('WEB_READER_EMPTY_HTML', '网页 HTML 为空');
  }
  if (Buffer.byteLength(html, 'utf8') > maxInputBytes) {
    throw extractionError('WEB_READER_HTML_TOO_LARGE', '网页 HTML 超过读取上限');
  }

  let document;
  try {
    const dom = new JSDOM(html, {
      url: new URL(url).toString(),
      contentType: 'text/html'
      // JSDOM 默认不执行脚本；禁止设置 runScripts/resources。
    });
    document = dom.window.document;
  } catch (error) {
    throw extractionError('WEB_READER_HTML_INVALID', `网页 HTML 无法解析：${error.message}`);
  }

  document.querySelectorAll('script, style, noscript, template, iframe').forEach((node) => node.remove());
  const article = new Readability(document, { charThreshold: 80 }).parse();
  const fullContent = normalizeText(article?.textContent);
  if (fullContent.length < 80) {
    throw extractionError('WEB_READER_CONTENT_EMPTY', '网页未提取到足够的正文');
  }

  const content = fullContent.slice(0, maxContentCharacters);
  return {
    title: normalizeText(article?.title || document.title),
    byline: normalizeText(article?.byline),
    excerpt: normalizeText(article?.excerpt),
    content,
    contentHash: createHash('sha256').update(fullContent).digest('hex'),
    truncated: content.length < fullContent.length,
    sourceCharacters: fullContent.length
  };
}
