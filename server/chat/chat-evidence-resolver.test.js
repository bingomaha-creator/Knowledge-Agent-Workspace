import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeKnowledgeEvidence,
  resolveChatKnowledgeEvidence,
  shouldResolveScopedKnowledge
} from './chat-evidence-resolver.js';

test('scoped RAG resolves every non-empty question when a ready document exists', () => {
  assert.equal(shouldResolveScopedKnowledge({
    retrievalEnabled: true,
    hasReadyKnowledge: true,
    query: '项目暗号是什么？'
  }), true);
  assert.equal(shouldResolveScopedKnowledge({
    retrievalEnabled: true,
    hasReadyKnowledge: false,
    query: '项目暗号是什么？'
  }), false);
  assert.equal(shouldResolveScopedKnowledge({
    retrievalEnabled: false,
    hasReadyKnowledge: true,
    query: '项目暗号是什么？'
  }), false);
});

test('evidence resolver admits lexical or hybrid citations with query-specific evidence', () => {
  const result = resolveChatKnowledgeEvidence({
    query: '项目暗号是什么？',
    citations: [
      {
        id: 'hybrid',
        title: '项目约定',
        snippet: '项目暗号是蓝色星河。',
        retrieval: { sources: ['vector', 'keyword'] }
      },
      { id: 'vector-only', retrieval: { sources: ['vector'] } },
      {
        id: 'lexical',
        title: '测试说明',
        snippet: '项目暗号可用于测试检索。',
        retrieval: { sources: ['keyword'] }
      }
    ]
  });

  assert.equal(result.status, 'evidence');
  assert.deepEqual(result.citations.map((citation) => citation.id), ['hybrid', 'lexical']);
  assert.deepEqual(result.trace, {
    policyVersion: 'chat-evidence-v3',
    status: 'evidence',
    reason: 'hybrid_match',
    candidateCount: 3,
    selectedCount: 2,
    filteredCount: 1,
    channels: {
      keywordCandidates: 2,
      querySpecificKeywordCandidates: 2,
      vectorOnlyCandidates: 1,
      degradedChannels: []
    }
  });
});

test('evidence resolver rejects incidental README matches for a memory-oriented question', () => {
  const result = resolveChatKnowledgeEvidence({
    query: '你还记得我的技术偏好和回答风格吗？',
    citations: [{
      id: 'generic-readme',
      title: 'README.md',
      snippet: 'Matthew\'s Workspace 基于 Vue 3、TypeScript、Express、MCP 和 SQLite 构建。',
      retrieval: { sources: ['vector', 'keyword'] }
    }]
  });

  assert.equal(result.status, 'evidence_gap');
  assert.equal(result.trace.reason, 'weak_candidates');
  assert.equal(result.citations.length, 0);
  assert.equal(result.trace.channels.keywordCandidates, 1);
  assert.equal(result.trace.channels.querySpecificKeywordCandidates, 0);
});

test('evidence resolver rejects a single generic CJK bigram from a personal question', () => {
  const result = resolveChatKnowledgeEvidence({
    query: '你觉得我是一个怎样的人？',
    citations: [{
      id: 'generic-project-background',
      title: 'test-knowledge.md',
      snippet: 'yuan-agent 是一个 AI 对话助手项目，支持流式输出、RAG 知识库检索和多轮会话管理。',
      retrieval: { sources: ['vector', 'keyword'] }
    }]
  });

  assert.equal(result.status, 'evidence_gap');
  assert.equal(result.citations.length, 0);
  assert.equal(result.trace.channels.querySpecificKeywordCandidates, 0);
});

test('evidence resolver keeps a direct technical-stack phrase even when only one short signal overlaps', () => {
  const result = resolveChatKnowledgeEvidence({
    query: '这个项目的技术栈是什么？',
    citations: [{
      id: 'stack',
      title: 'README.md',
      snippet: '技术栈：前端使用 Vue 3、Vite、TypeScript 和 Pinia。',
      retrieval: { sources: ['vector', 'keyword'] }
    }]
  });

  assert.equal(result.status, 'evidence');
  assert.deepEqual(result.citations.map((citation) => citation.id), ['stack']);
});

test('evidence resolver records an evidence gap instead of injecting weak candidates', () => {
  const result = resolveChatKnowledgeEvidence({
    query: '生日祝福怎么写？',
    citations: [{ id: 'vector-only', retrieval: { sources: ['vector'] } }]
  });

  assert.equal(result.status, 'evidence_gap');
  assert.equal(result.trace.reason, 'weak_candidates');
  assert.equal(result.citations.length, 0);
  assert.match(describeKnowledgeEvidence(result.trace), /未达到证据准入条件/);
});
