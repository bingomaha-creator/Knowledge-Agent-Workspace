import assert from 'node:assert/strict';
import test from 'node:test';
import { rankKnowledgeChunks } from './rag-utils.js';

test('rankKnowledgeChunks falls back to keyword matches for short reading-route questions', () => {
  const chunks = [
    {
      id: 'chunk-reading-route',
      documentId: 'doc-1',
      documentName: 'test-knowledge.md',
      text: '## 项目阅读路线\n阅读这个项目时，建议先从 README.md 和 package.json 建立整体认识。',
      tokens: ['项目阅读路线', '阅读', '项目', 'README'],
      vectorScore: 0.03
    },
    {
      id: 'chunk-unrelated',
      documentId: 'doc-1',
      documentName: 'test-knowledge.md',
      text: '## 测试暗号\n测试暗号是蓝色星河。',
      tokens: ['测试暗号', '蓝色星河'],
      vectorScore: 0.01
    }
  ];

  const results = rankKnowledgeChunks('项目阅读路线是怎样的？', chunks, 3);

  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'chunk-reading-route');
});
