import { extractReadableHtml } from './html-extractor.js';
import { createSafeHttpsReader } from './safe-request.js';

export function createWebDocumentReader({ safeReader = createSafeHttpsReader() } = {}) {
  async function readWebDocument({ url, signal }) {
    const response = await safeReader.readText({ url, signal });
    const extracted = extractReadableHtml({ html: response.text, url: response.finalUrl });
    return {
      url: response.url,
      finalUrl: response.finalUrl,
      title: extracted.title,
      content: extracted.content,
      contentHash: extracted.contentHash,
      contentType: response.contentType,
      fetchedAt: Date.now(),
      truncated: extracted.truncated,
      sourceCharacters: extracted.sourceCharacters,
      redirectCount: response.redirectCount
    };
  }

  return { readWebDocument };
}
