import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpKnowledgeSearchAdapter } from './mcp-knowledge-search-adapter.js';

test('MCP knowledge search adapter returns normalized Evidence for Research', async () => {
  const signal = new AbortController().signal;
  const adapter = createMcpKnowledgeSearchAdapter({
    toolExecutor: {
      async callToolOrThrow(name, args, context, options) {
        assert.equal(name, 'retrieve_knowledge');
        assert.deepEqual(args, {
          query: '取消边界',
          topK: 6,
          knowledgeBaseIds: ['kb-a']
        });
        assert.deepEqual(context, { caller: 'research', invocation: 'orchestrated' });
        assert.equal(options.signal, signal);
        return {
          structured: {
            citations: [{
              id: 'chunk-a',
              title: 'guide.md',
              headingPath: ['取消'],
              snippet: '取消必须传播到检索调用。',
              source: '混合检索知识库 / A / guide.md / 取消',
              knowledgeBaseId: 'kb-a',
              score: 0.82
            }],
            trace: { embedding: { ok: true, model: 'test' } }
          }
        };
      }
    }
  });

  const result = await adapter.searchEvidence({
    query: '取消边界',
    knowledgeBaseIds: ['kb-a'],
    limit: 6,
    signal
  });

  assert.deepEqual(result, {
    evidence: [{
      id: 'chunk-a',
      title: 'guide.md / 取消',
      snippet: '取消必须传播到检索调用。',
      source: '本地知识库',
      knowledgeBaseId: 'kb-a',
      documentId: '',
      sourceKind: 'project_knowledge',
      score: 0.82
    }],
    trace: { embedding: { ok: true, model: 'test' } }
  });
});
