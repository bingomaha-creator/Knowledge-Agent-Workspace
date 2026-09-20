import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerifiedReport } from './report-delivery.js';

const TRACKS = [{ id: 'track-1', question: '当前项目应如何完善状态边界？', status: 'answered' }];
const SOURCES = [
  { id: 'source-workspace', origin: 'workspace', title: 'React Frontend Architecture' },
  { id: 'source-web', origin: 'web', title: 'State management guide', url: 'https://example.com/state' }
];
const EVIDENCE = [
  { id: 'E1', trackId: 'track-1', sourceId: 'source-workspace', origin: 'workspace' },
  { id: 'E2', trackId: 'track-1', sourceId: 'source-web', origin: 'web' }
];

test('结构化 ReportDraft 通过来源合同后渲染成可引用报告', async () => {
  const result = await createVerifiedReport({
    brief: { objective: '评估状态边界' },
    tracks: TRACKS,
    sources: SOURCES,
    evidence: EVIDENCE,
    mode: 'hybrid',
    maxAttempts: 2,
    async writeDraft() {
      return {
        title: '状态边界评估',
        sections: [{
          trackId: 'track-1',
          heading: '状态归属',
          claims: [
            { type: 'workspace_fact', text: '项目文档定义了服务端状态归属。', evidenceIds: ['E1'] },
            { type: 'external_practice', text: '公开资料建议分离服务端状态与界面状态。', evidenceIds: ['E2'] },
            { type: 'recommendation', text: '建议把两类状态的协作规则写入架构文档。', evidenceIds: ['E1', 'E2'] }
          ]
        }],
        limitations: []
      };
    }
  });

  assert.equal(result.attempts, 1);
  assert.match(result.report, /项目事实：项目文档定义了服务端状态归属。 \[E1\]/u);
  assert.match(result.report, /外部实践：公开资料建议分离服务端状态与界面状态。 \[E2\]/u);
  assert.match(result.report, /建议：建议把两类状态的协作规则写入架构文档。 \[E1\]\[E2\]/u);
  assert.match(result.report, /https:\/\/example\.com\/state/u);
});

test('结构化交付拒绝把未检索到写成明确缺失，并把原因交给一次修复', async () => {
  const previousFailures = [];
  const drafts = [
    {
      title: '架构评估',
      sections: [{
        trackId: 'track-1', heading: 'Server 架构', claims: [{
          type: 'workspace_fact', text: 'Server 架构文档完全缺失。', evidenceIds: ['E1']
        }]
      }],
      limitations: []
    },
    {
      title: '架构评估',
      sections: [{
        trackId: 'track-1', heading: 'Server 架构', claims: [{
          type: 'workspace_fact', text: '当前 Evidence 只覆盖了前端状态归属。', evidenceIds: ['E1']
        }]
      }],
      limitations: []
    }
  ];

  const result = await createVerifiedReport({
    brief: {}, tracks: TRACKS, sources: SOURCES, evidence: EVIDENCE,
    mode: 'hybrid', maxAttempts: 2,
    async writeDraft({ previousFailure }) {
      previousFailures.push(previousFailure);
      return drafts.shift();
    }
  });

  assert.equal(result.attempts, 2);
  assert.deepEqual(previousFailures, [[], ['unsupported_absence_claim']]);
  assert.doesNotMatch(result.report, /完全缺失/u);
});

test('partial 或 unresolved Track 必须进入局限列表', async () => {
  const tracks = [{ id: 'track-1', question: 'Server 契约是否完整？', status: 'partial' }];
  const previousFailures = [];
  const base = {
    title: '架构评估',
    sections: [{
      trackId: 'track-1', heading: 'Server 契约', claims: [{
        type: 'workspace_fact', text: '当前 Evidence 覆盖部分 Server 约束。', evidenceIds: ['E1']
      }]
    }]
  };
  const drafts = [
    { ...base, limitations: [] },
    { ...base, limitations: [{ trackId: 'track-1', text: '当前证据未覆盖 API 版本策略。' }] }
  ];

  const result = await createVerifiedReport({
    brief: {}, tracks, sources: SOURCES, evidence: EVIDENCE,
    mode: 'hybrid', maxAttempts: 2,
    async writeDraft({ previousFailure }) {
      previousFailures.push(previousFailure);
      return drafts.shift();
    }
  });

  assert.equal(result.attempts, 2);
  assert.deepEqual(previousFailures, [[], ['unresolved_track_limitation']]);
  assert.match(result.report, /当前证据未覆盖 API 版本策略/u);
});

test('局限不能把证据空白写成项目事实', async () => {
  const tracks = [{ id: 'track-1', question: 'Server 契约是否完整？', status: 'partial' }];
  const failures = [];
  const section = {
    trackId: 'track-1', heading: 'Server 契约', claims: [{
      type: 'workspace_fact', text: '当前 Evidence 覆盖部分 Server 约束。', evidenceIds: ['E1']
    }]
  };
  const drafts = [
    {
      title: '架构评估', sections: [section],
      limitations: [{ trackId: 'track-1', text: 'Server 架构文档未定义 API 版本策略。' }]
    },
    {
      title: '架构评估', sections: [section],
      limitations: [{ trackId: 'track-1', text: '当前证据未覆盖 API 版本策略。' }]
    }
  ];

  const result = await createVerifiedReport({
    brief: {}, tracks, sources: SOURCES, evidence: EVIDENCE,
    mode: 'hybrid', maxAttempts: 2,
    async writeDraft({ previousFailure }) {
      failures.push(previousFailure);
      return drafts.shift();
    }
  });

  assert.equal(result.attempts, 2);
  assert.deepEqual(failures, [[], ['limitation_evidence_boundary']]);
  assert.doesNotMatch(result.report, /文档未定义/u);
});

test('Claim 只能引用所属 Track 的 Evidence', async () => {
  const evidence = [
    ...EVIDENCE,
    { id: 'E3', trackId: 'track-2', sourceId: 'source-web', origin: 'web' }
  ];
  const previousFailures = [];
  const claim = { type: 'external_practice', text: '公开资料建议明确状态边界。' };
  const drafts = [
    {
      title: '状态边界评估',
      sections: [{ trackId: 'track-1', heading: '状态边界', claims: [{ ...claim, evidenceIds: ['E3'] }] }],
      limitations: []
    },
    {
      title: '状态边界评估',
      sections: [{ trackId: 'track-1', heading: '状态边界', claims: [{ ...claim, evidenceIds: ['E2'] }] }],
      limitations: []
    }
  ];

  const result = await createVerifiedReport({
    brief: {}, tracks: TRACKS, sources: SOURCES, evidence,
    mode: 'hybrid', maxAttempts: 2,
    async writeDraft({ previousFailure }) {
      previousFailures.push(previousFailure);
      return drafts.shift();
    }
  });

  assert.equal(result.attempts, 2);
  assert.deepEqual(previousFailures, [[], ['claim_track_membership']]);
});

test('Claim 文本不能携带 Markdown、URL 或自造引用', async () => {
  const failures = [];
  const drafts = [
    {
      title: '状态边界评估',
      sections: [{
        trackId: 'track-1', heading: '状态边界', claims: [{
          type: 'external_practice',
          text: '请参考 [track-1] https://invented.example 的 **建议**。',
          evidenceIds: ['E2']
        }]
      }],
      limitations: []
    },
    {
      title: '状态边界评估',
      sections: [{
        trackId: 'track-1', heading: '状态边界', claims: [{
          type: 'external_practice',
          text: '公开资料建议用 `QueryClient` 管理 **服务端状态**。',
          evidenceIds: ['E2']
        }]
      }],
      limitations: []
    }
  ];

  const result = await createVerifiedReport({
    brief: {}, tracks: TRACKS, sources: SOURCES, evidence: EVIDENCE,
    mode: 'hybrid', maxAttempts: 2,
    async writeDraft({ previousFailure }) {
      failures.push(previousFailure);
      return drafts.shift();
    }
  });

  assert.equal(result.attempts, 2);
  assert.deepEqual(failures, [[], ['claim_text_format']]);
  assert.doesNotMatch(result.report, /invented\.example|track-1|\*\*/u);
  assert.match(result.report, /\\`QueryClient\\`/u);
  assert.match(result.report, /\\\*\\\*服务端状态\\\*\\\*/u);
});

test('Hybrid 建议必须同时引用 Workspace 与 Web Evidence', async () => {
  const failures = [];
  const recommendation = {
    type: 'recommendation',
    text: '建议把状态协作规则写入架构文档。'
  };
  const drafts = [
    {
      title: '状态边界评估',
      sections: [{ trackId: 'track-1', heading: '建议', claims: [{ ...recommendation, evidenceIds: ['E1'] }] }],
      limitations: []
    },
    {
      title: '状态边界评估',
      sections: [{ trackId: 'track-1', heading: '建议', claims: [{ ...recommendation, evidenceIds: ['E1', 'E2'] }] }],
      limitations: []
    }
  ];

  const result = await createVerifiedReport({
    brief: {}, tracks: TRACKS, sources: SOURCES, evidence: EVIDENCE,
    mode: 'hybrid', maxAttempts: 2,
    async writeDraft({ previousFailure }) {
      failures.push(previousFailure);
      return drafts.shift();
    }
  });

  assert.equal(result.attempts, 2);
  assert.deepEqual(failures, [[], ['recommendation_origin']]);
});

test('两次结构化草稿都无效时 fail closed', async () => {
  let calls = 0;
  await assert.rejects(
    createVerifiedReport({
      brief: {}, tracks: TRACKS, sources: SOURCES, evidence: EVIDENCE,
      mode: 'hybrid', maxAttempts: 2,
      async writeDraft() {
        calls += 1;
        return {
          title: '状态边界评估',
          sections: [{
            trackId: 'track-1', heading: '状态边界', claims: [{
              type: 'external_practice', text: '结论。', evidenceIds: ['E99']
            }]
          }],
          limitations: []
        };
      }
    }),
    (error) => error.code === 'RESEARCH_NEW_REPORT_INVALID' && /claim_shape/u.test(error.message)
  );
  assert.equal(calls, 2);
});

test('有证据的已回答 Track 不能交付空 Claims', async () => {
  const failures = [];
  const drafts = [
    {
      title: '状态边界评估',
      sections: [{ trackId: 'track-1', heading: '状态边界', claims: [] }],
      limitations: []
    },
    {
      title: '状态边界评估',
      sections: [{
        trackId: 'track-1', heading: '状态边界', claims: [{
          type: 'external_practice', text: '公开资料建议明确状态边界。', evidenceIds: ['E2']
        }]
      }],
      limitations: []
    }
  ];

  const result = await createVerifiedReport({
    brief: {}, tracks: TRACKS, sources: SOURCES, evidence: EVIDENCE,
    mode: 'hybrid', maxAttempts: 2,
    async writeDraft({ previousFailure }) {
      failures.push(previousFailure);
      return drafts.shift();
    }
  });

  assert.equal(result.attempts, 2);
  assert.deepEqual(failures, [[], ['track_claim']]);
});

test('布局标题由 Brief 和 Track 确定，不渲染模型的空章节判断', async () => {
  const tracks = [{ id: 'track-1', question: 'Server 契约的当前证据是什么？', status: 'unresolved' }];
  const result = await createVerifiedReport({
    brief: { objective: '评估 Server 契约' },
    tracks,
    sources: SOURCES,
    evidence: [],
    mode: 'hybrid',
    async writeDraft() {
      return {
        title: 'Server 契约完全缺失',
        sections: [{ trackId: 'track-1', heading: 'Server 契约完全缺失', claims: [] }],
        limitations: [{ trackId: 'track-1', text: '当前证据未覆盖 Server 契约。' }]
      };
    }
  });

  assert.match(result.report, /^# 评估 Server 契约/u);
  assert.doesNotMatch(result.report, /完全缺失/u);
  assert.doesNotMatch(result.report, /## Server 契约的当前证据是什么/u);
});
