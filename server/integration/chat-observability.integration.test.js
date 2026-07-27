/**
 * 这是一条“真实进程边界”集成测试，不是对 helper 的单元测试。
 * 测试会启动：假 Qwen HTTP 服务 + 真 Express 进程 + 真 MCP stdio 子进程 + 临时 SQLite。
 * 它验证最容易被 mock 掩盖的性质：网络流提前 EOF、浏览器断连、MCP 取消通知和
 * embedding fetch 是否真的同时结束，以及最终 run/span 是否与实际生命周期一致。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../index.js'
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForApp(child, expectedText) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`App startup timed out. stdout=${stdout} stderr=${stderr}`));
    }, 8_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes(expectedText)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`App exited before startup (${code}). stderr=${stderr}`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function postChat(
  baseUrl,
  conversationId,
  content,
  signal,
  { ragEnabled = false, knowledgeBaseIds = [] } = {}
) {
  return fetch(`${baseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content }],
      conversationId,
      ragEnabled,
      knowledgeBaseIds,
      presetId: 'general'
    }),
    signal
  });
}

// 只解析本项目向浏览器暴露的 SSE envelope；上游 Qwen 的 usage/[DONE] 属于另一层协议。
// 用事件名序列做合同断言，可以在后续搬迁 route/orchestrator 时及时发现顺序或终态漂移。
function parseSseEvents(text) {
  return String(text || '')
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
      if (!event || !data) return null;
      return { event, data: JSON.parse(data) };
    })
    .filter(Boolean);
}

async function waitForReadyDocument(baseUrl, knowledgeBaseId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/api/knowledge?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`
    );
    const body = await response.json();
    const ready = body.documents?.find((document) => document.status === 'ready');
    if (ready) return ready;
    const failed = body.documents?.find((document) => document.status === 'failed');
    if (failed) throw new Error(`Knowledge ingestion failed: ${failed.error}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Knowledge document did not become ready');
}

async function waitForRun(baseUrl, conversationId, status) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/api/runs?conversationId=${encodeURIComponent(conversationId)}&limit=1`
    );
    const body = await response.json();
    const run = body.runs?.[0];
    if (run?.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${conversationId} did not reach ${status}`);
}

async function waitForEmpty(set, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (set.size === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} was not aborted`);
}

test('chat streaming keeps generation and run terminal states consistent', async (t) => {
  // 这些 deferred/Set 既让测试精确等到某个异步阶段开始，也能检查取消是否真正关闭
  // 上游 socket；如果只检查本地 Promise rejection，就可能漏掉后台仍在消耗资源的请求。
  const candidateStarted = deferred();
  const embeddingStarted = deferred();
  const generationStreamStarted = deferred();
  const heldCandidateResponses = new Set();
  const heldEmbeddingResponses = new Set();
  const heldGenerationResponses = new Set();
  let holdEmbeddings = false;
  // 假 Qwen 按输入内容切换行为：正常 [DONE]、usage 后 EOF、悬挂生成、悬挂候选或
  // 悬挂 embedding。这样每条失败路径都能确定性复现，不需要真实 API Key。
  const fakeQwen = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

    if (req.url === '/embeddings') {
      if (holdEmbeddings) {
        heldEmbeddingResponses.add(res);
        embeddingStarted.resolve();
        res.once('close', () => heldEmbeddingResponses.delete(res));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }));
      return;
    }

    const systemPrompt = String(body.messages?.[0]?.content || '');
    if (!body.stream && systemPrompt.includes('长期记忆候选')) {
      heldCandidateResponses.add(res);
      candidateStarted.resolve();
      res.once('close', () => heldCandidateResponses.delete(res));
      return;
    }

    if (!body.stream) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 }
      }));
      return;
    }

    const messageText = body.messages
      ?.map((message) => String(message.content || ''))
      .join('\n') || '';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    });
    res.write(`data: ${JSON.stringify({
      choices: [{ delta: { content: '流式回答' } }]
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 4 }
    })}\n\n`);
    if (messageText.includes('hold-generation-stream')) {
      heldGenerationResponses.add(res);
      generationStreamStarted.resolve();
      res.once('close', () => heldGenerationResponses.delete(res));
      return;
    }
    if (messageText.includes('incomplete-stream')) {
      res.end();
      return;
    }
    res.end('data: [DONE]\n\n');
  });

  const fakePort = await listen(fakeQwen);
  const appPort = await reservePort();
  // 子进程 cwd 指向临时目录，使 Express 与 MCP 都打开临时 server/data/*.sqlite，
  // 测试绝不会读写开发者真实知识库；这也验证两进程使用同一个 cwd 的约定。
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-chat-integration-'));
  const child = spawn(process.execPath, [serverPath], {
    cwd,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(appPort),
      QWEN_API_KEY: 'integration-test-key',
      QWEN_BASE_URL: `http://127.0.0.1:${fakePort}`,
      QWEN_MODEL: 'integration-model',
      QWEN_MAX_RETRIES: '0',
      RESEARCH_WEB_SEARCH_ENDPOINT: '',
      RESEARCH_WEB_SEARCH_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = `http://127.0.0.1:${appPort}`;

  t.after(async () => {
    for (const response of heldCandidateResponses) response.destroy();
    for (const response of heldEmbeddingResponses) response.destroy();
    for (const response of heldGenerationResponses) response.destroy();
    await stopChild(child);
    fakeQwen.closeAllConnections?.();
    await new Promise((resolve) => fakeQwen.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await waitForApp(child, `http://127.0.0.1:${appPort}`);

  // 场景 1：完整流。usage 可以在 [DONE] 前到达，但 generation 只能在 [DONE] 后成功。
  const successResponse = await postChat(
    baseUrl,
    'integration-success',
    'ordinary-stream'
  );
  const successSse = await successResponse.text();
  const successEvents = parseSseEvents(successSse);
  assert.equal(successEvents[0].event, 'run');
  assert.ok(successEvents.some(({ event }) => event === 'token'));
  assert.equal(successEvents.at(-1).event, 'done');
  assert.equal(successEvents.some(({ event }) => event === 'error'), false);
  assert.equal(successEvents.some(({ event }) => event === 'usage'), false);
  const successRun = await waitForRun(baseUrl, 'integration-success', 'success');
  const successGeneration = successRun.spans.find((span) => span.name === 'generation');
  assert.equal(successGeneration.status, 'success');
  assert.equal(successGeneration.inputTokens, 3);
  assert.equal(successGeneration.outputTokens, 4);

  // 场景 2：已经收到 token/usage，却没有 [DONE] 就 EOF。回答可能不完整，必须是 error。
  const incompleteResponse = await postChat(
    baseUrl,
    'integration-incomplete',
    'incomplete-stream'
  );
  const incompleteSse = await incompleteResponse.text();
  const incompleteEvents = parseSseEvents(incompleteSse);
  assert.equal(incompleteEvents[0].event, 'run');
  assert.ok(incompleteEvents.some(({ event }) => event === 'token'));
  assert.equal(incompleteEvents.at(-1).event, 'error');
  assert.equal(incompleteEvents.some(({ event }) => event === 'done'), false);
  assert.equal(incompleteEvents.at(-1).data.code, 'UPSTREAM_STREAM_INCOMPLETE');
  const incompleteRun = await waitForRun(baseUrl, 'integration-incomplete', 'error');
  const incompleteGeneration = incompleteRun.spans.find((span) => span.name === 'generation');
  assert.equal(incompleteGeneration.status, 'error');
  assert.equal(incompleteGeneration.errorCode, 'UPSTREAM_STREAM_INCOMPLETE');
  assert.equal(incompleteGeneration.inputTokens, 3);
  assert.equal(incompleteGeneration.outputTokens, 4);

  // 场景 3：最终生成仍悬挂时用户停止。DOM AbortError 要归一成 REQUEST_ABORTED，
  // 并且假 Qwen 端的 response socket 也必须关闭。
  const generationController = new AbortController();
  const heldStreamResponse = await postChat(
    baseUrl,
    'integration-generation-cancel',
    'hold-generation-stream',
    generationController.signal
  );
  const heldStreamReader = heldStreamResponse.body.getReader();
  await generationStreamStarted.promise;
  generationController.abort();
  await heldStreamReader.read().catch(() => {});

  const generationCancelledRun = await waitForRun(
    baseUrl,
    'integration-generation-cancel',
    'cancelled'
  );
  const cancelledStreamSpan = generationCancelledRun.spans.find(
    (span) => span.name === 'generation'
  );
  assert.equal(generationCancelledRun.errorCode, 'REQUEST_ABORTED');
  assert.equal(cancelledStreamSpan.status, 'cancelled');
  assert.equal(cancelledStreamSpan.errorCode, 'REQUEST_ABORTED');
  assert.ok(
    generationCancelledRun.spans.every((span) => span.status !== 'running')
  );
  await waitForEmpty(heldGenerationResponses, 'Generation stream');

  // 场景 4：generation 已成功、候选记忆模型仍悬挂时停止。子 span 取消，已经完成的
  // generation 保持 success；整个 run 按用户请求生命周期标 cancelled。
  const controller = new AbortController();
  const cancelResponse = await postChat(
    baseUrl,
    'integration-cancel',
    '请记住我喜欢取消边界测试',
    controller.signal
  );
  const reader = cancelResponse.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('event: token')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Cancel stream ended before the first token');
    received += decoder.decode(value, { stream: true });
  }
  await candidateStarted.promise;
  controller.abort();
  await reader.read().catch(() => {});

  const cancelledRun = await waitForRun(baseUrl, 'integration-cancel', 'cancelled');
  const cancelledGeneration = cancelledRun.spans.find((span) => span.name === 'generation');
  const candidateSpan = cancelledRun.spans.find(
    (span) => span.name === 'memory_candidate_extraction'
  );
  assert.equal(cancelledGeneration.status, 'success');
  assert.equal(candidateSpan.status, 'cancelled');
  assert.ok(cancelledRun.spans.every((span) => span.status !== 'running'));

  // 先通过真实上传 API 建立 ready 草稿，再显式发布；只有完整走过
  // Knowledge Governance 闭环，聊天才应进入 auto retrieve 路径。
  const uploadForm = new FormData();
  uploadForm.append('knowledgeBaseId', 'kb-default');
  uploadForm.append(
    'files',
    new Blob(['# 取消边界\n\n知识库检索应响应客户端取消信号。'], {
      type: 'text/markdown'
    }),
    'abort-boundary.md'
  );
  const uploadResponse = await fetch(`${baseUrl}/api/knowledge/upload`, {
    method: 'POST',
    body: uploadForm
  });
  assert.equal(uploadResponse.status, 200);
  const readyDraft = await waitForReadyDocument(baseUrl, 'kb-default');
  assert.equal(readyDraft.publicationStatus, 'draft');
  const publishResponse = await fetch(
    `${baseUrl}/api/knowledge/${encodeURIComponent(readyDraft.id)}/publish?knowledgeBaseId=kb-default`,
    { method: 'POST' }
  );
  assert.equal(publishResponse.status, 200);
  assert.equal((await publishResponse.json()).document.publicationStatus, 'published');

  // 场景 5：MCP retrieve_knowledge 内的 embedding 悬挂时停止。
  // 这条断言验证 signal 穿过 Express -> MCP Client -> MCP handler -> fetch，而不仅是
  // Express 本地把 callTool Promise 丢弃。
  holdEmbeddings = true;
  const retrievalController = new AbortController();
  const retrievalResponse = await postChat(
    baseUrl,
    'integration-tool-cancel',
    '请根据知识库文档说明取消边界。',
    retrievalController.signal,
    { ragEnabled: true, knowledgeBaseIds: ['kb-default'] }
  );
  const retrievalReader = retrievalResponse.body.getReader();
  await embeddingStarted.promise;
  retrievalController.abort();
  await retrievalReader.read().catch(() => {});

  const toolCancelledRun = await waitForRun(
    baseUrl,
    'integration-tool-cancel',
    'cancelled'
  );
  const retrievalSpan = toolCancelledRun.spans.find(
    (span) => span.name === 'retrieve_knowledge'
  );
  assert.equal(retrievalSpan.status, 'cancelled');
  assert.equal(retrievalSpan.errorCode, 'REQUEST_ABORTED');
  assert.ok(toolCancelledRun.spans.every((span) => span.status !== 'running'));
  await waitForEmpty(heldEmbeddingResponses, 'Embedding request');
});
