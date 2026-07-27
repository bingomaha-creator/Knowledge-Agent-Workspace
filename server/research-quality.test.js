import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessResearchQuality,
  inferResearchEvidencePolicy,
  screenResearchSources,
  selectResearchEvidence
} from './research-quality.js';

test('source screening excludes an obviously unrelated local result', () => {
  const screened = screenResearchSources('今天天气如何？未来 7 天呢？', [{
    id: 'project-doc',
    title: '项目阅读路线',
    snippet: '请先阅读 README 和前端目录，再查看服务端编排。',
    kind: 'local',
    queries: ['今天天气如何？未来 7 天呢？']
  }]);

  assert.deepEqual(screened.accepted, []);
  assert.equal(screened.excluded.length, 1);
  assert.equal(screened.excluded[0].reason, 'low_relevance');
});

test('source screening keeps lexical or strong vector evidence', () => {
  const screened = screenResearchSources('异步研究任务如何恢复？', [
    {
      id: 'lexical',
      title: '异步研究任务恢复设计',
      snippet: '任务会保存当前研究阶段。',
      kind: 'local'
    },
    {
      id: 'semantic',
      title: 'Worker lifecycle',
      snippet: 'Persist every stage before continuing execution.',
      kind: 'local',
      retrieval: { vectorScore: 0.72 }
    }
  ]);

  assert.equal(screened.accepted.length, 2);
  assert.deepEqual(screened.excluded, []);
});

test('general research rejects test fixtures and gives public sources priority with a local-document cap', () => {
  const question = '如何做好一个 RAG 知识库？';
  const plannedQuestions = [
    { question: 'RAG 知识库如何选择检索策略？' },
    { question: 'RAG 知识库如何设计文档切片？' }
  ];
  const policy = inferResearchEvidencePolicy({ question, searchMode: 'hybrid' });
  const screened = screenResearchSources(question, [
    {
      id: 'fixture', title: 'test-knowledge.md / 测试暗号', kind: 'local',
      snippet: 'RAG 测试暗号是蓝色星河。', queries: [plannedQuestions[0].question],
      retrieval: { vectorScore: 0.9 }
    },
    {
      id: 'local-1', title: 'test-knowledge.md / 核心能力', kind: 'local',
      snippet: 'RAG 知识库可建立向量索引。', queries: [plannedQuestions[0].question],
      retrieval: { vectorScore: 0.8 }
    },
    {
      id: 'local-2', title: 'test-knowledge.md / 易错点', kind: 'local',
      snippet: 'RAG 文档切片会在内存中建立索引。', queries: [plannedQuestions[1].question],
      retrieval: { vectorScore: 0.8 }
    },
    {
      id: 'web-1', title: 'RAG retrieval guide', kind: 'web',
      snippet: 'RAG 知识库检索策略应结合关键词与向量召回。', queries: [plannedQuestions[0].question]
    },
    {
      id: 'web-2', title: 'RAG chunking guide', kind: 'web',
      snippet: 'RAG 知识库文档切片需要按语义边界评估。', queries: [plannedQuestions[1].question]
    }
  ], { plannedQuestions, policy });
  const selected = selectResearchEvidence({
    sources: screened.accepted,
    plannedQuestions,
    policy
  });

  assert.equal(policy.id, 'general_research');
  assert.equal(screened.excluded[0].reason, 'template_or_fixture');
  assert.deepEqual(selected.selected.map((item) => item.id), ['web-1', 'local-1', 'web-2']);
  assert.equal(selected.selected.filter((item) => item.kind === 'local').length, 1);
});

test('generic coding-agent research keeps a provider-ranked public source when wording differs from the question', () => {
  const question = '如何做好一个 coding agent 呢？有 GitHub 的相关项目参考一下吗？';
  const plannedQuestions = [{ question }];
  const policy = inferResearchEvidencePolicy({ question, searchMode: 'hybrid' });
  const screened = screenResearchSources(question, [
    {
      id: 'local-background',
      title: 'test-knowledge.md / 项目背景',
      kind: 'local',
      snippet: 'yuan-agent 是一个 AI 对话助手项目，支持 RAG 知识库检索与 MCP 工具调用。',
      queries: [question],
      retrieval: { vectorScore: 0.82 }
    },
    {
      id: 'web-openhands',
      title: 'OpenHands',
      kind: 'web',
      url: 'https://github.com/All-Hands-AI/OpenHands',
      snippet: 'An AI-driven software development platform for autonomous issue resolution.',
      providerRank: 1,
      queries: [question]
    }
  ], { plannedQuestions, policy });
  const selected = selectResearchEvidence({
    sources: screened.accepted,
    plannedQuestions,
    policy
  });

  assert.ok(screened.accepted.some((item) => item.id === 'web-openhands'));
  assert.ok(selected.selected.some((item) => item.id === 'web-openhands'));
});

test('GitHub repository resolver candidates outrank matching search-result forks', () => {
  const question = 'Aider 如何编辑代码并验证结果？';
  const plannedQuestions = [{
    question,
    evidenceNeed: { preferredSourceTypes: ['official_repo'] }
  }];
  const policy = inferResearchEvidencePolicy({ question, searchMode: 'hybrid' });
  const screened = screenResearchSources(question, [
    {
      id: 'fork',
      title: 'GitHub - someone/aider',
      kind: 'web',
      url: 'https://github.com/someone/aider',
      snippet: 'An Aider fork with code editing files and validation examples.',
      providerRank: 1,
      queries: [question]
    },
    {
      id: 'resolved',
      title: 'GitHub - Aider-AI/aider',
      kind: 'web',
      url: 'https://github.com/Aider-AI/aider',
      snippet: 'Aider-AI/aider GitHub repository.',
      sourceKind: 'official_repo',
      discoveryMethod: 'github_repository_search',
      providerRank: 1,
      queries: [question]
    }
  ], { plannedQuestions, policy });
  const selected = selectResearchEvidence({
    sources: screened.accepted,
    plannedQuestions,
    policy
  });
  assert.equal(selected.selected[0].id, 'resolved');
  assert.equal(selected.selected[0].relevance.trustedRepositoryCandidate, true);
  assert.deepEqual(selected.selected.map((item) => item.id), ['resolved']);
  assert.ok(selected.excluded.some((item) => item.reason === 'superseded_by_repository_index'));
});

test('quality separates successful execution from insufficient evidence', () => {
  const assessment = assessResearchQuality({
    searchMode: 'hybrid',
    webSearchStatus: 'unavailable'
  }, {
    subquestions: ['天气', '未来天气'],
    sources: [],
    excludedSources: [{ id: 'unrelated' }],
    verification: { valid: true }
  });

  assert.equal(assessment.quality, 'insufficient');
  assert.deepEqual(
    assessment.limitations.map((item) => item.code),
    ['no_relevant_evidence', 'public_search_unavailable']
  );
  assert.equal(assessment.metrics.excludedEvidenceCount, 1);
});

test('quality is limited when project evidence is useful but public search degrades', () => {
  const questions = ['异步研究', '异步研究恢复'];
  const assessment = assessResearchQuality({
    searchMode: 'hybrid',
    webSearchStatus: 'partial'
  }, {
    subquestions: questions,
    sources: [{ id: 'source', queries: questions }],
    verification: { valid: true }
  });

  assert.equal(assessment.quality, 'limited');
  assert.deepEqual(assessment.limitations.map((item) => item.code), [
    'public_search_partial',
    'public_evidence_not_included'
  ]);
});

test('quality uses the final evidence pack instead of broader screened candidates', () => {
  const question = '如何做好一个 coding agent？';
  const assessment = assessResearchQuality({
    question,
    searchMode: 'hybrid',
    webSearchStatus: 'available'
  }, {
    subquestions: [question],
    sources: [
      { id: 'screened-web', kind: 'web', sourceKind: 'official_repo', queries: [question] },
      { id: 'screened-local', kind: 'local', queries: [question] }
    ],
    citations: [{ id: 'final-local', kind: 'local', queries: [question] }],
    evidencePack: { includedCount: 1 },
    plan: { evidencePolicy: inferResearchEvidencePolicy({ question, searchMode: 'hybrid' }) },
    verification: { valid: true }
  });

  assert.equal(assessment.metrics.relevantEvidenceCount, 1);
  assert.equal(assessment.quality, 'limited');
  assert.ok(assessment.limitations.some((item) => item.code === 'public_evidence_not_included'));
});

test('quality is sufficient for covered local evidence with valid citation structure', () => {
  const questions = ['上下文治理'];
  const assessment = assessResearchQuality({
    searchMode: 'local',
    webSearchStatus: 'not_requested'
  }, {
    subquestions: questions,
    sources: [{ id: 'source', queries: questions }],
    verification: { valid: true }
  });

  assert.equal(assessment.quality, 'sufficient');
  assert.deepEqual(assessment.limitations, []);
});

test('quality does not present an unclassified public page as primary evidence', () => {
  const questions = ['上下文治理'];
  const assessment = assessResearchQuality({
    searchMode: 'hybrid',
    webSearchStatus: 'available'
  }, {
    subquestions: questions,
    sources: [{ id: 'page', kind: 'web', sourceKind: 'public_web', queries: questions }],
    verification: { valid: true }
  });

  assert.equal(assessment.quality, 'limited');
  assert.equal(assessment.limitations[0].code, 'public_source_provenance_unverified');
  assert.equal(assessment.metrics.unverifiedPublicSourceCount, 1);
});
