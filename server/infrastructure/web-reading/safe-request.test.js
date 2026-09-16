import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  createSafeHttpsReader,
  isPublicAddress,
  resolvePublicTarget
} from './safe-request.js';

function responseFromBuffer(buffer, options = {}) {
  const stream = Readable.from([buffer]);
  stream.statusCode = options.statusCode || 200;
  stream.headers = options.headers || { 'content-type': 'text/html' };
  return stream;
}

function responseFromText(text, options = {}) {
  return responseFromBuffer(Buffer.from(text), {
    statusCode: options.statusCode,
    headers: options.headers || { 'content-type': 'text/html; charset=utf-8' }
  });
}

test('公网地址判定拒绝私网、回环、保留地址和 IPv4-mapped IPv6', () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.2',
    '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.51.100.1', '224.0.0.1',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff00::1', '2001:db8::1', '::ffff:127.0.0.1'
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('DNS 结果含任意非公网地址时 fail closed', async () => {
  await assert.rejects(
    resolvePublicTarget('example.test', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ]),
    (error) => error.code === 'WEB_READER_ADDRESS_BLOCKED'
  );
});

test('每一跳重定向重新解析并校验，不能从公网跳到私网', async () => {
  const calls = [];
  const reader = createSafeHttpsReader({
    resolveHost: async (hostname) => [{
      address: hostname === 'safe.example' ? '8.8.8.8' : '127.0.0.1',
      family: 4
    }],
    openPinnedResponse: async ({ url, target }) => {
      calls.push({ hostname: url.hostname, target });
      return responseFromText('', {
        statusCode: 302,
        headers: { location: 'https://private.example/secret' }
      });
    }
  });
  await assert.rejects(
    reader.readText({ url: 'https://safe.example/start' }),
    (error) => error.code === 'WEB_READER_ADDRESS_BLOCKED'
  );
  assert.deepEqual(calls, [{ hostname: 'safe.example', target: { address: '8.8.8.8', family: 4 } }]);
});

test('成功请求使用解析后公网 IP，并支持逐跳 HTTPS 重定向', async () => {
  const calls = [];
  const reader = createSafeHttpsReader({
    resolveHost: async (hostname) => [{
      address: hostname === 'one.example' ? '8.8.8.8' : '1.1.1.1', family: 4
    }],
    openPinnedResponse: async ({ url, target }) => {
      calls.push({ url: url.toString(), target });
      if (url.hostname === 'one.example') {
        return responseFromText('', { statusCode: 301, headers: { location: 'https://two.example/article' } });
      }
      return responseFromText('<article>正文内容足够长，用于验证安全请求成功读取。</article>');
    }
  });
  const result = await reader.readText({ url: 'https://one.example/start' });
  assert.equal(result.finalUrl, 'https://two.example/article');
  assert.equal(result.redirectCount, 1);
  assert.deepEqual(calls.map((item) => item.target.address), ['8.8.8.8', '1.1.1.1']);
});

test('非 HTTPS、URL 凭据和重定向次数均被拒绝', async () => {
  const reader = createSafeHttpsReader({
    resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
    maxRedirects: 1,
    openPinnedResponse: async () => responseFromText('', {
      statusCode: 302,
      headers: { location: 'https://redirect.example/again' }
    })
  });
  await assert.rejects(reader.readText({ url: 'http://example.test' }), /仅允许 HTTPS/);
  await assert.rejects(reader.readText({ url: 'https://user:pass@example.test' }), /不允许包含凭据/);
  await assert.rejects(
    reader.readText({ url: 'https://example.test' }),
    (error) => error.code === 'WEB_READER_REDIRECT_LIMIT'
  );
});

test('content-type、声明大小和流式大小均 fail closed', async () => {
  const base = { resolveHost: async () => [{ address: '8.8.8.8', family: 4 }] };
  const blockedType = createSafeHttpsReader({
    ...base,
    openPinnedResponse: async () => responseFromText('{}', {
      headers: { 'content-type': 'application/json' }
    })
  });
  await assert.rejects(
    blockedType.readText({ url: 'https://example.test' }),
    (error) => error.code === 'WEB_READER_CONTENT_TYPE_BLOCKED'
  );

  const declaredLarge = createSafeHttpsReader({
    ...base,
    maxBytes: 16,
    openPinnedResponse: async () => responseFromText('small', {
      headers: { 'content-type': 'text/html', 'content-length': '100' }
    })
  });
  await assert.rejects(
    declaredLarge.readText({ url: 'https://example.test' }),
    (error) => error.code === 'WEB_READER_RESPONSE_TOO_LARGE'
  );

  const streamedLarge = createSafeHttpsReader({
    ...base,
    maxBytes: 16,
    openPinnedResponse: async () => responseFromText('x'.repeat(64))
  });
  await assert.rejects(
    streamedLarge.readText({ url: 'https://example.test' }),
    (error) => error.code === 'WEB_READER_RESPONSE_TOO_LARGE'
  );
});

test('压缩响应按解压后的正文大小限制', async () => {
  const html = '<article>' + 'grounded evidence '.repeat(20) + '</article>';
  const reader = createSafeHttpsReader({
    resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
    maxBytes: 1_024,
    openPinnedResponse: async () => responseFromBuffer(gzipSync(html), {
      headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }
    })
  });
  assert.equal((await reader.readText({ url: 'https://example.test' })).text, html);

  const limited = createSafeHttpsReader({
    resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
    maxBytes: 32,
    openPinnedResponse: async () => responseFromBuffer(gzipSync(html), {
      headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }
    })
  });
  await assert.rejects(
    limited.readText({ url: 'https://example.test' }),
    (error) => error.code === 'WEB_READER_RESPONSE_TOO_LARGE'
  );
});

test('调用方取消与总超时返回不同错误', async () => {
  const waitForAbort = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const controller = new AbortController();
  const cancelled = createSafeHttpsReader({
    resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
    openPinnedResponse: waitForAbort
  });
  const cancelledPromise = cancelled.readText({ url: 'https://example.test', signal: controller.signal });
  controller.abort('user');
  await assert.rejects(cancelledPromise, (error) => error.code === 'WEB_READER_CANCELLED');

  const timedOut = createSafeHttpsReader({
    resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
    timeoutMs: 5,
    openPinnedResponse: waitForAbort
  });
  await assert.rejects(
    timedOut.readText({ url: 'https://example.test' }),
    (error) => error.code === 'WEB_READER_TIMEOUT'
  );

  const dnsTimedOut = createSafeHttpsReader({
    resolveHost: async () => new Promise(() => {}),
    timeoutMs: 5,
    openPinnedResponse: async () => {
      throw new Error('DNS 超时后不得发请求');
    }
  });
  await assert.rejects(
    dnsTimedOut.readText({ url: 'https://example.test' }),
    (error) => error.code === 'WEB_READER_TIMEOUT'
  );
});
