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

test('rankKnowledgeChunks fuses vector and keyword candidates with RRF', () => {
  const chunks = [
    {
      id: 'chunk-vector-only',
      documentId: 'doc-1',
      documentName: 'guide.md',
      text: '这段内容语义相似，但没有关键词索引命中。',
      tokens: ['语义相似'],
      vectorScore: 0.95
    },
    {
      id: 'chunk-both',
      documentId: 'doc-1',
      documentName: 'guide.md',
      text: '知识库通过 SQLite 持久化保存 documents 和 chunks。',
      tokens: ['知识库', 'sqlite', '持久化', '保存', 'documents', 'chunks'],
      vectorScore: 0.8,
      keywordRank: 1,
      bm25Score: -1.2
    },
    {
      id: 'chunk-keyword-only',
      documentId: 'doc-1',
      documentName: 'guide.md',
      text: '知识库支持上传 Markdown 文档。',
      tokens: ['知识库', 'markdown', '文档'],
      vectorScore: 0.02,
      keywordRank: 2,
      bm25Score: -0.8
    }
  ];

  const results = rankKnowledgeChunks('知识库如何持久化？', chunks, 3);

  assert.equal(results[0].id, 'chunk-both');
  assert.deepEqual(results[0].retrieval.sources, ['vector', 'keyword']);
  assert.equal(results[0].retrieval.keywordRank, 1);
  assert.equal(results[0].retrieval.vectorRank, 2);
  assert.ok(results[0].score > results[1].score);
});
