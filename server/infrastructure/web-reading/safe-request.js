import { promises as dns } from 'node:dns';
import https from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import ipaddr from 'ipaddr.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

function readerError(code, message, options = {}) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function normalizedHostname(hostname) {
  const value = String(hostname || '').trim();
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

export function isPublicAddress(address) {
  try {
    let parsed = ipaddr.parse(String(address || ''));
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
      parsed = parsed.toIPv4Address();
    }
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}

async function defaultResolveHost(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

export async function resolvePublicTarget(hostname, resolveHost = defaultResolveHost) {
  const host = normalizedHostname(hostname);
  const directFamily = isIP(host);
  const records = directFamily
    ? [{ address: host, family: directFamily }]
    : await resolveHost(host);
  if (!Array.isArray(records) || records.length === 0) {
    throw readerError('WEB_READER_DNS_EMPTY', '网页主机没有可用的 DNS 记录');
  }

  const normalized = records.map((record) => ({
    address: String(record?.address || ''),
    family: Number(record?.family) || isIP(String(record?.address || ''))
  }));
  if (normalized.some((record) => !record.family || !isPublicAddress(record.address))) {
    throw readerError('WEB_READER_ADDRESS_BLOCKED', '网页主机解析到非公网地址');
  }
  return normalized[0];
}

function defaultOpenPinnedResponse({ url, target, signal, accept }) {
  const hostname = normalizedHostname(url.hostname);
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      signal,
      servername: isIP(hostname) ? undefined : hostname,
      family: target.family,
      autoSelectFamily: false,
      rejectUnauthorized: true,
      lookup(_hostname, options, callback) {
        const family = Number(options?.family) || target.family;
        callback(null, target.address, family);
      },
      headers: {
        Accept: accept,
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'matthews-workspace-research-reader/1.0'
      }
    }, (response) => resolve(response));
    request.once('error', reject);
    request.end();
  });
}

function contentTypeOf(headers) {
  return String(headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
}

function responseStream(response) {
  const encoding = String(response.headers?.['content-encoding'] || '').trim().toLowerCase();
  if (!encoding || encoding === 'identity') return response;
  if (encoding === 'gzip') return response.pipe(createGunzip());
  if (encoding === 'deflate') return response.pipe(createInflate());
  if (encoding === 'br') return response.pipe(createBrotliDecompress());
  throw readerError('WEB_READER_ENCODING_UNSUPPORTED', '网页使用了不支持的内容编码');
}

async function readBoundedBody(response, maxBytes) {
  const declaredLength = Number(response.headers?.['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    response.destroy?.();
    throw readerError('WEB_READER_RESPONSE_TOO_LARGE', '网页响应超过读取上限');
  }

  const chunks = [];
  let total = 0;
  const stream = responseStream(response);
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        stream.destroy?.();
        throw readerError('WEB_READER_RESPONSE_TOO_LARGE', '网页正文超过读取上限');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error?.code) throw error;
    throw readerError('WEB_READER_BODY_INVALID', '网页正文读取失败', { cause: error });
  }
  return Buffer.concat(chunks).toString('utf8');
}

function waitWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function normalizedAllowedTypes(values) {
  return new Set((Array.isArray(values) ? values : []).map((value) => String(value).toLowerCase()));
}

export function createSafeHttpsReader({
  resolveHost = defaultResolveHost,
  openPinnedResponse = defaultOpenPinnedResponse,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS
} = {}) {
  async function readText({
    url,
    signal,
    accept = 'text/html, application/xhtml+xml;q=0.9',
    allowedContentTypes = ['text/html', 'application/xhtml+xml']
  }) {
    let current;
    try {
      current = new URL(String(url || ''));
    } catch {
      throw readerError('WEB_READER_URL_INVALID', '网页 URL 无效');
    }
    if (current.protocol !== 'https:') {
      throw readerError('WEB_READER_PROTOCOL_BLOCKED', '网页 Reader 仅允许 HTTPS');
    }
    if (current.username || current.password) {
      throw readerError('WEB_READER_CREDENTIALS_BLOCKED', '网页 URL 不允许包含凭据');
    }

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort('timeout'), timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    const allowedTypes = normalizedAllowedTypes(allowedContentTypes);

    try {
      for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
        if (combinedSignal.aborted) throw combinedSignal.reason;
        const target = await waitWithSignal(
          resolvePublicTarget(current.hostname, resolveHost),
          combinedSignal
        );
        // DNS 解析本身可异步完成；取消可能发生在解析期间，禁止在已取消后仍发请求。
        if (combinedSignal.aborted) throw combinedSignal.reason;
        const response = await waitWithSignal(
          openPinnedResponse({
            url: current,
            target,
            signal: combinedSignal,
            accept
          }),
          combinedSignal
        );
        const status = Number(response.statusCode || response.status || 0);

        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy?.();
          const location = response.headers?.location;
          if (!location) throw readerError('WEB_READER_REDIRECT_INVALID', '网页重定向缺少目标');
          if (redirectCount === maxRedirects) {
            throw readerError('WEB_READER_REDIRECT_LIMIT', '网页重定向次数超过上限');
          }
          const next = new URL(location, current);
          if (next.protocol !== 'https:') {
            throw readerError('WEB_READER_PROTOCOL_BLOCKED', '网页重定向到非 HTTPS 地址');
          }
          if (next.username || next.password) {
            throw readerError('WEB_READER_CREDENTIALS_BLOCKED', '网页重定向 URL 不允许包含凭据');
          }
          current = next;
          continue;
        }

        if (status < 200 || status >= 300) {
          response.destroy?.();
          throw readerError('WEB_READER_HTTP_ERROR', `网页读取失败（HTTP ${status || 'unknown'}）`);
        }
        const contentType = contentTypeOf(response.headers);
        if (!allowedTypes.has(contentType)) {
          response.destroy?.();
          throw readerError('WEB_READER_CONTENT_TYPE_BLOCKED', '网页内容类型不受支持');
        }
        const text = await readBoundedBody(response, maxBytes);
        return {
          url: new URL(String(url)).toString(),
          finalUrl: current.toString(),
          contentType,
          text,
          bytes: Buffer.byteLength(text, 'utf8'),
          redirectCount
        };
      }
      throw readerError('WEB_READER_REDIRECT_LIMIT', '网页重定向次数超过上限');
    } catch (error) {
      if (signal?.aborted) {
        throw readerError('WEB_READER_CANCELLED', '网页读取已取消', { cause: error });
      }
      if (timeoutController.signal.aborted) {
        throw readerError('WEB_READER_TIMEOUT', '网页读取超时', { cause: error });
      }
      if (error?.code) throw error;
      throw readerError('WEB_READER_UPSTREAM_ERROR', '网页读取失败', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  return { readText };
}
