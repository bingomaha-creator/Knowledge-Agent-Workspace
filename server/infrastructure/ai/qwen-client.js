function createClientError(code, message, details = '', status = 500) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/$/, '');
}

function assertApiKey(apiKey) {
  if (!apiKey) {
    throw createClientError(
      'MISSING_API_KEY',
      '缺少 Qwen API Key',
      '请检查服务端 `.env.local` 中的 `QWEN_API_KEY` 配置。',
      500
    );
  }
}

function createRequestOptions(apiKey, body, signal) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal
  };
}

async function readErrorBody(response) {
  return response.text().catch(() => '');
}

async function assertChatResponse(response) {
  if (response.ok) return;
  const text = await readErrorBody(response);
  if (response.status === 401) {
    throw createClientError(
      'INVALID_API_KEY',
      'Qwen API Key 无效或已过期',
      text || '请检查 `QWEN_API_KEY` 是否正确。',
      401
    );
  }
  if (response.status === 429) {
    throw createClientError(
      'RATE_LIMITED',
      'Qwen 请求过于频繁',
      text || '请稍后重试，或检查账户配额是否充足。',
      429
    );
  }
  const upstreamServerError = response.status >= 500;
  throw createClientError(
    upstreamServerError ? 'QWEN_HTTP_ERROR' : 'QWEN_REQUEST_INVALID',
    `Qwen 请求失败（${response.status}）`,
    text || '上游模型服务返回异常响应。',
    upstreamServerError ? 502 : response.status
  );
}

async function assertEmbeddingResponse(response) {
  if (response.ok) return;
  const text = await readErrorBody(response);
  if (response.status === 401) {
    throw createClientError(
      'INVALID_API_KEY',
      'Qwen API Key 无效或已过期',
      text || '请检查 `QWEN_API_KEY` 是否正确。',
      401
    );
  }
  if (response.status === 429) {
    throw createClientError(
      'RATE_LIMITED',
      'Qwen 请求过于频繁',
      text || '请稍后重试，或检查账户配额是否充足。',
      429
    );
  }
  throw createClientError(
    'QWEN_HTTP_ERROR',
    `Qwen 请求失败（${response.status}）`,
    text || '上游模型服务返回异常响应。',
    502
  );
}

export function createChatQwenClient({
  apiKey,
  baseUrl,
  fetchImpl = globalThis.fetch
}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  return {
    async chatCompletions(body, { stream = false, signal } = {}) {
      assertApiKey(apiKey);
      let response;
      try {
        response = await fetchImpl(
          `${normalizedBaseUrl}/chat/completions`,
          createRequestOptions(apiKey, body, signal)
        );
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') {
          throw createClientError(
            'REQUEST_ABORTED',
            '请求已取消',
            '客户端已停止本次生成。',
            499
          );
        }
        throw createClientError(
          'NETWORK_UNREACHABLE',
          '无法连接到 Qwen 服务',
          '当前运行环境访问 DashScope 失败。请检查网络、代理、VPN 或防火墙设置。',
          502
        );
      }

      await assertChatResponse(response);
      return stream ? response : response.json();
    }
  };
}

export function createEmbeddingQwenClient({
  apiKey,
  baseUrl,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000
}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  return {
    async embed(text, { signal } = {}) {
      assertApiKey(apiKey);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      let response;
      try {
        response = await fetchImpl(
          `${normalizedBaseUrl}/embeddings`,
          createRequestOptions(apiKey, {
            model,
            input: String(text || '').slice(0, 6000)
          }, requestSignal)
        );
      } catch {
        if (signal?.aborted) {
          throw createClientError(
            'REQUEST_ABORTED',
            '请求已取消',
            '调用方已停止本次操作。',
            499
          );
        }
        if (timeoutSignal.aborted) {
          throw createClientError(
            'UPSTREAM_TIMEOUT',
            'Qwen 请求超时',
            `上游模型在 ${Math.round(timeoutMs / 1000)} 秒内未响应，请稍后重试。`,
            504
          );
        }
        throw createClientError(
          'NETWORK_UNREACHABLE',
          '无法连接到 Qwen 服务',
          '当前运行环境访问 DashScope 失败。请检查网络、代理、VPN 或防火墙设置。',
          502
        );
      }

      await assertEmbeddingResponse(response);
      const result = await response.json();
      const vector = result.data?.[0]?.embedding;
      if (!vector) {
        throw createClientError(
          'EMBEDDING_EMPTY',
          'Embedding 生成失败',
          '模型返回为空，无法建立向量索引。',
          502
        );
      }
      return vector;
    }
  };
}
