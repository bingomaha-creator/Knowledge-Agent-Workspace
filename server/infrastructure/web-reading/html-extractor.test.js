import assert from 'node:assert/strict';
import test from 'node:test';
import { extractReadableHtml } from './html-extractor.js';

function articleHtml({ lang = 'zh-CN', title = '技术文章', body, extraHead = '', before = '' }) {
  return `<!doctype html><html lang="${lang}"><head><title>${title}</title>${extraHead}</head><body>
    <nav>首页 产品 定价 登录 注册 文档 社区</nav>${before}
    <main><article><h1>${title}</h1>${body}</article></main>
    <footer>版权信息 联系方式 隐私政策</footer></body></html>`;
}

test('Readability 从中文噪声页面提取主要正文', () => {
  const html = articleHtml({
    title: 'SQLite WAL 工作原理',
    body: `<p>WAL 模式把修改先追加到日志文件，使读取者可以继续访问原有数据库页面。写入者提交后，新的读取事务能够看到已提交内容。</p>
      <p>检查点会把日志中的页面合并回主数据库。部署时需要同时管理数据库文件、WAL 文件和共享内存文件，并理解网络文件系统限制。</p>
      <p>该机制改善了部分并发场景，但不代表所有工作负载都更快，实际收益取决于事务形态、检查点策略和存储设备。</p>`
  });
  const result = extractReadableHtml({ html, url: 'https://docs.example.test/wal' });
  assert.match(result.title, /SQLite WAL/);
  assert.match(result.content, /检查点/);
  assert.doesNotMatch(result.content, /登录 注册/);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(result.truncated, false);
});

test('Readability 从英文技术文档提取正文', () => {
  const html = articleHtml({
    lang: 'en',
    title: 'HTTP transport notes',
    body: `<p>HTTP transports have different handshake and recovery characteristics. A useful comparison must keep network conditions, implementation versions, and measurement methods explicit.</p>
      <p>Results from a controlled laboratory should not be generalized to every mobile network. Packet loss, path changes, congestion control, and server deployment all affect the outcome.</p>
      <p>Primary protocol documents describe mechanisms, while field measurements explain behavior under particular conditions. Both types of evidence are needed for a grounded report.</p>`
  });
  const result = extractReadableHtml({ html, url: 'https://example.test/http' });
  assert.match(result.content, /handshake and recovery/);
  assert.match(result.content, /field measurements/);
});

test('解析器不执行脚本，也不把脚本、style 和 iframe 当正文', () => {
  delete globalThis.__researchReaderExecuted;
  const html = articleHtml({
    title: '安全读取网页',
    extraHead: '<style>.secret { display: none }</style>',
    before: '<script>globalThis.__researchReaderExecuted = true</script><iframe src="https://evil.test"></iframe>',
    body: `<p>网页正文是不可信输入。读取器只能提取文本，不能让页面脚本执行，也不能允许页面内容改变系统权限、预算或完成规则。</p>
      <p>页面中出现的操作指令只是被研究的资料，不是系统指令。后续 Evidence Extractor 必须继续把这些文字当作来源内容处理。</p>
      <p>网络层还需要限制地址、重定向、响应大小和读取时间；这些安全检查属于下一阶段，而不是 HTML 解析器本身。</p>`
  });
  const result = extractReadableHtml({ html, url: 'https://example.test/security' });
  assert.equal(globalThis.__researchReaderExecuted, undefined);
  assert.doesNotMatch(result.content, /__researchReaderExecuted|\.secret|evil\.test/);
  assert.match(result.content, /不可信输入/);
});

test('畸形 HTML 可以恢复提取，空正文和超大输入显式失败', () => {
  const paragraph = '这是一段足够长的正文，用于确认解析器能够从未正确闭合的 HTML 标签中恢复内容，并保留文章的主要技术说明。'.repeat(4);
  const malformed = `<html><head><title>Broken</title><body><main><article><h1>Broken document</h1>
    <p>${paragraph}</p><p>${paragraph}</p><p>${paragraph}`;
  assert.match(
    extractReadableHtml({ html: malformed, url: 'https://example.test/broken' }).content,
    /未正确闭合/
  );
  assert.throws(
    () => extractReadableHtml({ html: '<html><body>短内容</body></html>', url: 'https://example.test/empty' }),
    (error) => error.code === 'WEB_READER_CONTENT_EMPTY'
  );
  assert.throws(
    () => extractReadableHtml({
      html: '<p>' + '内容'.repeat(100) + '</p>',
      url: 'https://example.test/large',
      maxInputBytes: 16
    }),
    (error) => error.code === 'WEB_READER_HTML_TOO_LARGE'
  );
});

test('正文截断不改变基于完整正文计算的 contentHash', () => {
  const base = '用于验证完整正文哈希与持久化截断相互独立的技术段落。'.repeat(20);
  const first = extractReadableHtml({
    html: articleHtml({ body: `<p>${base}甲</p>` }),
    url: 'https://example.test/hash',
    maxContentCharacters: 120
  });
  const second = extractReadableHtml({
    html: articleHtml({ body: `<p>${base}乙</p>` }),
    url: 'https://example.test/hash',
    maxContentCharacters: 120
  });
  assert.equal(first.content, second.content);
  assert.notEqual(first.contentHash, second.contentHash);
  assert.equal(first.truncated, true);
});
