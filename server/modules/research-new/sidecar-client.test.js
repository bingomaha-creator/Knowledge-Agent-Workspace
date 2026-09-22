import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createResearchSidecarClient } from './sidecar-client.js';

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('Sidecar client 覆盖创建、读取结果与取消合同', async (t) => {
  const requests = [];
  const server = await listen(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    if (req.url === '/api/v1/sessions') return json(res, 201, { session_id: 'session-1' });
    if (req.url === '/api/v1/sessions/session-1/messages') {
      return json(res, 202, { run_id: 'run-1', status: 'queued' });
    }
    if (req.url === '/api/v1/runs/run-1/evidence') return json(res, 200, { items: [], total: 0 });
    if (req.url === '/api/v1/runs/run-1/report') return json(res, 200, { content: '# 报告' });
    if (req.url === '/api/v1/runs/run-1/cancel') return json(res, 200, { run_id: 'run-1', status: 'cancelling' });
    return json(res, 200, { run_id: 'run-1', status: 'completed', current_stage: 'completed' });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = createResearchSidecarClient({
    baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`, timeoutMs: 500
  });

  assert.deepEqual(
    await client.startRun({ question: '研究架构', mode: 'hybrid', clientMessageId: 'local-1' }),
    { sessionId: 'session-1', runId: 'run-1', accepted: { run_id: 'run-1', status: 'queued' } }
  );
  assert.equal((await client.getRun('run-1')).status, 'completed');
  assert.equal((await client.getEvidence('run-1')).total, 0);
  assert.equal((await client.getReport('run-1')).content, '# 报告');
  assert.equal((await client.cancelRun('run-1')).status, 'cancelling');
  assert.equal(requests[1].body.source_mode, 'graphrag');
  assert.equal(requests[1].body.workflow_mode, 'deep_research');
});

test('Sidecar client 区分远端失败、超时和不可用', async (t) => {
  const server = await listen((req, res) => {
    if (req.url === '/api/v1/runs/slow') return;
    json(res, 503, { error: { code: 'UPSTREAM_FAILED', message: '上游失败', retryable: true } });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  const client = createResearchSidecarClient({ baseUrl, timeoutMs: 30 });
  await assert.rejects(client.getRun('failed'), (error) => {
    assert.equal(error.code, 'UPSTREAM_FAILED');
    assert.equal(error.retryable, true);
    return true;
  });
  await assert.rejects(client.getRun('slow'), { code: 'RESEARCH_SIDECAR_TIMEOUT' });
  await new Promise((resolve) => server.close(resolve));
  const unavailable = createResearchSidecarClient({ baseUrl, timeoutMs: 100 });
  await assert.rejects(unavailable.getRun('run-1'), { code: 'RESEARCH_SIDECAR_UNAVAILABLE' });
});
