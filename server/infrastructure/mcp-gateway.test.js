import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contentToText,
  createMcpGateway,
  normalizeStructuredContent
} from './mcp-gateway.js';

test('MCP compatibility helpers normalize structuredContent, toolResult, and text content', () => {
  assert.deepEqual(
    normalizeStructuredContent({ structuredContent: { documents: [1] } }),
    { documents: [1] }
  );
  assert.deepEqual(
    normalizeStructuredContent({ toolResult: { memories: [2] } }),
    { memories: [2] }
  );
  assert.deepEqual(normalizeStructuredContent(null), {});
  assert.equal(contentToText({
    content: [
      { type: 'text', text: 'first' },
      { type: 'image', data: 'ignored' },
      { type: 'text', text: 'second' }
    ]
  }), 'first\nsecond');
});

test('gateway forwards signal/timeout options and exposes a stable result envelope', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const gateway = createMcpGateway({
    sessionManager: {
      async getSession() {
        return {
          client: {
            async listTools(params, options) {
              calls.push({ method: 'listTools', params, options });
              return { tools: [{ name: 'get_current_time' }] };
            },
            async callTool(params, resultSchema, options) {
              calls.push({ method: 'callTool', params, resultSchema, options });
              return {
                structuredContent: { ok: true },
                content: [{ type: 'text', text: 'done' }]
              };
            }
          }
        };
      }
    }
  });

  assert.deepEqual(await gateway.listTools({ signal }), {
    tools: [{ name: 'get_current_time' }]
  });
  const result = await gateway.callTool(
    'get_current_time',
    {},
    { signal, timeout: 1234 }
  );
  assert.deepEqual(result.structured, { ok: true });
  assert.equal(result.text, 'done');
  assert.equal(result.isError, false);
  assert.deepEqual(calls, [
    {
      method: 'listTools',
      params: undefined,
      options: { signal }
    },
    {
      method: 'callTool',
      params: { name: 'get_current_time', arguments: {} },
      resultSchema: undefined,
      options: { signal, timeout: 1234 }
    }
  ]);
});

test('callToolOrThrow never treats MCP isError as business success', async () => {
  const gateway = createMcpGateway({
    sessionManager: {
      async getSession() {
        return {
          client: {
            async callTool() {
              return {
                isError: true,
                toolResult: {
                  code: 'DOCUMENT_NOT_FOUND',
                  message: '文档不存在',
                  details: 'doc-missing',
                  status: 404
                },
                content: [{ type: 'text', text: '文档不存在' }]
              };
            }
          }
        };
      }
    }
  });

  const compatible = await gateway.callTool('delete_knowledge_document', {
    id: 'doc-missing'
  });
  assert.equal(compatible.isError, true);
  assert.deepEqual(compatible.structured, {
    code: 'DOCUMENT_NOT_FOUND',
    message: '文档不存在',
    details: 'doc-missing',
    status: 404
  });

  await assert.rejects(
    gateway.callToolOrThrow('delete_knowledge_document', { id: 'doc-missing' }),
    (error) => (
      error.code === 'DOCUMENT_NOT_FOUND' &&
      error.message === '文档不存在' &&
      error.details === 'doc-missing' &&
      error.status === 404
    )
  );
});

test('gateway can preserve legacy callers that intentionally inspect MCP business errors', async () => {
  const gateway = createMcpGateway({
    sessionManager: {
      async getSession() {
        return {
          client: {
            async callTool() {
              return { isError: true, structuredContent: { code: 'EXPECTED_FAILURE' } };
            }
          }
        };
      }
    }
  });

  const result = await gateway.callTool('retrieve_knowledge', { query: 'test' });
  assert.equal(result.isError, true);
  assert.equal(result.structured.code, 'EXPECTED_FAILURE');
});
