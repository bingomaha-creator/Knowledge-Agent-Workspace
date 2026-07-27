import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WEB_SEARCH_LIMITS } from './web-search-provider.js';

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'mcp-server.js');

test('MCP exposes bounded search_web and returns structured unavailable status', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yuan-mcp-web-search-'));
  const client = new Client({ name: 'web-search-test-client', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd,
    env: {
      ...process.env,
      RESEARCH_WEB_SEARCH_ENDPOINT: '',
      RESEARCH_WEB_SEARCH_API_KEY: '',
      RESEARCH_WEB_SEARCH_ALLOWED_HOSTS: '',
      WEB_SEARCH_ENDPOINT: '',
      WEB_SEARCH_API_KEY: '',
      WEB_SEARCH_ALLOWED_HOSTS: ''
    },
    stderr: 'pipe'
  });

  t.after(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await client.connect(transport);
  const listed = await client.listTools();
  const tool = listed.tools.find((item) => item.name === 'search_web');

  assert.ok(tool);
  assert.equal(tool.inputSchema.properties.query.maxLength, WEB_SEARCH_LIMITS.maxQueryLength);
  assert.equal(tool.inputSchema.properties.topK.maximum, WEB_SEARCH_LIMITS.maxResults);

  const result = await client.callTool({
    name: 'search_web',
    arguments: { query: '受控联网检索', topK: 3 }
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.available, false);
  assert.equal(result.structuredContent.status, 'not_configured');
  assert.deepEqual(result.structuredContent.results, []);
});
