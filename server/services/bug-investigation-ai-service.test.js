import assert from 'node:assert/strict';
import test from 'node:test';
import { createBugInvestigationAiService } from './bug-investigation-ai-service.js';

function input() {
  return {
    quality: 'limited',
    facts: {
      errorTypes: ['SyntaxError'],
      messages: ['Unexpected end of JSON input'],
      files: ['chat.ts'],
      locations: ['chat.ts:42'],
      frameworks: [],
      environments: [],
      errorSignatures: ['syntaxerror: unexpected end of json input'],
      reproductionSteps: [],
      verificationNotes: [],
      evidenceIds: ['evidence-1']
    },
    evidence: [{
      id: 'evidence-1',
      type: 'error',
      content: 'SyntaxError: Unexpected end of JSON input\nat parseChunk (chat.ts:42)',
      metadata: {}
    }],
    similarCases: []
  };
}

test('drops hypotheses that introduce ungrounded technologies or cite no evidence', async () => {
  const qwenClient = {
    chatCompletions: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: '错误发生在 JSON.parse 调用处。',
            hypotheses: [
              {
                title: 'SSE chunk 被截断',
                reasoning: 'EventSource 可能提前关闭。',
                falsification: '完整 SSE 事件仍失败时排除。',
                confidenceLabel: 'plausible',
                supportingEvidenceIds: ['evidence-1'],
                counterEvidenceIds: [],
                relatedCaseIds: []
              },
              {
                title: '输入内容不完整',
                reasoning: '错误签名表明 JSON 文本在结束前终止。',
                falsification: '捕获到完整且可单独解析的输入时排除。',
                confidenceLabel: 'plausible',
                supportingEvidenceIds: ['evidence-1'],
                counterEvidenceIds: [],
                relatedCaseIds: []
              },
              {
                title: '没有证据引用',
                reasoning: '只是猜测。',
                falsification: '无。',
                confidenceLabel: 'weak',
                supportingEvidenceIds: [],
                counterEvidenceIds: [],
                relatedCaseIds: []
              }
            ],
            verificationSteps: [{
              title: '捕获实际输入',
              instruction: '在解析前记录输入。',
              supportingSignal: '输入是不完整 JSON。',
              refutingSignal: '输入始终是可独立解析的完整 JSON。'
            }],
            missingEvidence: ['请补充 parseChunk 函数源码。']
          })
        }
      }]
    })
  };
  const service = createBugInvestigationAiService({
    qwenClient,
    model: 'test-model'
  });

  const result = await service.analyze(input());

  assert.equal(result.output.hypotheses.length, 1);
  assert.equal(result.output.hypotheses[0].title, '输入内容不完整');
  assert.deepEqual(result.output.verificationSteps[0], {
    title: '捕获实际输入',
    instruction: '在解析前记录输入。',
    supportingSignal: '输入是不完整 JSON。',
    refutingSignal: '输入始终是可独立解析的完整 JSON。'
  });
});

test('keeps only one primary hypothesis when an alternative has no independent evidence', async () => {
  const qwenClient = {
    chatCompletions: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: 'JSON 输入在完成前被解析。',
            hypotheses: [
              {
                title: '不完整输入被直接解析',
                reasoning: '错误来自不完整 JSON。',
                falsification: '完整输入仍失败时排除。',
                confidenceLabel: 'plausible',
                supportingEvidenceIds: ['evidence-1']
              },
              {
                title: '解析前没有等待完整内容',
                reasoning: '相同现场也可以描述为等待逻辑缺失。',
                falsification: '已经等待完整输入时排除。',
                confidenceLabel: 'plausible',
                supportingEvidenceIds: ['evidence-1']
              }
            ],
            verificationSteps: [],
            missingEvidence: []
          })
        }
      }]
    })
  };
  const service = createBugInvestigationAiService({ qwenClient, model: 'test-model' });

  const result = await service.analyze(input());

  assert.equal(result.output.hypotheses.length, 1);
  assert.equal(result.output.hypotheses[0].title, '不完整输入被直接解析');
});

test('keeps one independently supported alternative hypothesis', async () => {
  const qwenClient = {
    chatCompletions: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: '错误与网络现场支持两个不同机制。',
            hypotheses: [
              {
                title: '不完整输入被直接解析',
                reasoning: '错误堆栈指向 JSON.parse。',
                falsification: '完整输入仍失败时排除。',
                confidenceLabel: 'plausible',
                supportingEvidenceIds: ['evidence-1']
              },
              {
                title: '上游响应在事件结束前关闭',
                reasoning: '网络现场记录了连接提前关闭。',
                falsification: '连接完整结束时排除。',
                confidenceLabel: 'plausible',
                supportingEvidenceIds: ['evidence-network']
              }
            ],
            verificationSteps: [],
            missingEvidence: []
          })
        }
      }]
    })
  };
  const service = createBugInvestigationAiService({ qwenClient, model: 'test-model' });
  const withNetwork = input();
  withNetwork.evidence.push({
    id: 'evidence-network',
    type: 'network',
    content: 'SSE connection closed before the done event.',
    metadata: { fileName: '', language: '', lineStart: null }
  });

  const result = await service.analyze(withNetwork);

  assert.deepEqual(
    result.output.hypotheses.map((item) => item.title),
    ['不完整输入被直接解析', '上游响应在事件结束前关闭']
  );
});

test('does not request code evidence that is already present', async () => {
  const qwenClient = {
    chatCompletions: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: 'parseChunk 在 JSON.parse 前没有等待完整输入。',
            hypotheses: [{
              title: '不完整输入被直接解析',
              reasoning: '代码和错误共同指向 JSON.parse。',
              falsification: '完整输入仍失败时排除。',
              confidenceLabel: 'plausible',
              supportingEvidenceIds: ['evidence-1', 'evidence-code']
            }],
            verificationSteps: [],
            missingEvidence: [
              '请补充 parseChunk 函数源码。',
              '请补充触发问题的可执行复现步骤。'
            ]
          })
        }
      }]
    })
  };
  const service = createBugInvestigationAiService({ qwenClient, model: 'test-model' });
  const withCode = input();
  withCode.evidence.push({
    id: 'evidence-code',
    type: 'code',
    content: 'function parseChunk(chunk) { return JSON.parse(chunk); }',
    metadata: { fileName: 'chat.ts', language: 'TypeScript' }
  });

  const result = await service.analyze(withCode);

  assert.deepEqual(result.output.missingEvidence, ['请补充触发问题的可执行复现步骤。']);
});
