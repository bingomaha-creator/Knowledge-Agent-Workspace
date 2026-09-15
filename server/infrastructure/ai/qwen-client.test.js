import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createChatQwenClient,
  createEmbeddingQwenClient
} from './qwen-client.js';

function responseJson(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('chat client keeps streaming responses raw and forwards the caller signal', async () => {
  const controller = new AbortController();
  const calls = [];
  const response = new Response('data: [DONE]\n\n');
  const client = createChatQwenClient({
    apiKey: 'test-key',
    baseUrl: 'https://qwen.example/v1/',
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return response;
    }
  });

  const result = await client.chatCompletions(
    { model: 'qwen-plus', messages: [] },
    { stream: true, signal: controller.signal }
  );

  assert.equal(result, response);
  assert.equal(calls[0].url, 'https://qwen.example/v1/chat/completions');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: 'qwen-plus',
    messages: []
  });
});

test('chat client preserves upstream HTTP error categories', async () => {
  const makeClient = (status) => createChatQwenClient({
    apiKey: 'test-key',
    baseUrl: 'https://qwen.example/v1',
    fetchImpl: async () => new Response('upstream details', { status })
  });

  await assert.rejects(
    makeClient(401).chatCompletions({}),
    (error) => error.code === 'INVALID_API_KEY' && error.status === 401
  );
  await assert.rejects(
    makeClient(429).chatCompletions({}),
    (error) => error.code === 'RATE_LIMITED' && error.status === 429
  );
  await assert.rejects(
    makeClient(503).chatCompletions({}),
    (error) => error.code === 'QWEN_HTTP_ERROR' && error.status === 502
  );
  await assert.rejects(
    makeClient(400).chatCompletions({}),
    (error) => error.code === 'QWEN_REQUEST_INVALID' && error.status === 400
  );
});

test('chat client distinguishes caller cancellation from network failure', async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelled = createChatQwenClient({
    apiKey: 'test-key',
    baseUrl: 'https://qwen.example/v1',
    fetchImpl: async () => {
      throw new DOMException('aborted', 'AbortError');
    }
  });
  await assert.rejects(
    cancelled.chatCompletions({}, { signal: controller.signal }),
    (error) => error.code === 'REQUEST_ABORTED' && error.status === 499
  );

  const unavailable = createChatQwenClient({
    apiKey: 'test-key',
    baseUrl: 'https://qwen.example/v1',
    fetchImpl: async () => {
      throw new Error('offline');
    }
  });
  await assert.rejects(
    unavailable.chatCompletions({}),
    (error) => error.code === 'NETWORK_UNREACHABLE' && error.status === 502
  );
});

test('chat JSON mode parses the response while stream mode does not require a body', async () => {
  const jsonClient = createChatQwenClient({
    apiKey: 'test-key',
    baseUrl: 'https://qwen.example/v1',
    fetchImpl: async () => responseJson({ choices: [{ message: { content: 'ok' } }] })
  });
  assert.equal(
    (await jsonClient.chatCompletions({})).choices[0].message.content,
    'ok'
  );

  const emptyStream = new Response(null, { status: 200 });
  const streamClient = createChatQwenClient({
    apiKey: 'test-key',
    baseUrl: 'https://qwen.example/v1',
    fetchImpl: async () => emptyStream
  });
  assert.equal(
    await streamClient.chatCompletions({}, { stream: true }),
    emptyStream
  );
});

test('embedding client keeps its deadline profile, input bound, and vector validation', async () => {
  const calls = [];
  const client = createEmbeddingQwenClient({
    apiKey: 'test-key',
    baseUrl: 'https://qwen.example/v1/',
    model: 'text-embedding-v3',
    timeoutMs: 20_000,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return responseJson({ data: [{ embedding: [0.1, 0.2] }] });
    }
  });

  assert.deepEqual(await client.embed('x'.repeat(7000)), [0.1, 0.2]);
  assert.equal(calls[0].url, 'https://qwen.example/v1/embeddings');
  assert.equal(JSON.parse(calls[0].options.body).input.length, 6000);
  assert.notEqual(calls[0].options.signal, undefined);

  const emptyClient = createEmbeddingQwenClient({
    apiKey: 'test-key',
    baseUrl: 'https://qwen.example/v1',
    model: 'text-embedding-v3',
    fetchImpl: async () => responseJson({ data: [] })
  });
  await assert.rejects(
    emptyClient.embed('query'),
    (error) => error.code === 'EMBEDDING_EMPTY' && error.status === 502
  );
});

test('embedding client gives caller cancellation precedence over its deadline', async () => {
  const controller = new AbortController();
  const client = createEmbeddingQwenClient({
    apiKey: 'test-key',
    baseUrl: 'https://qwen.example/v1',
    model: 'text-embedding-v3',
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })
  });

  controller.abort();
  await assert.rejects(
    client.embed('query', { signal: controller.signal }),
    (error) => error.code === 'REQUEST_ABORTED' && error.status === 499
  );

  await assert.rejects(
    client.embed('query'),
    (error) => error.code === 'UPSTREAM_TIMEOUT' && error.status === 504
  );
});
