import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMemoryContext,
  buildPitfallDetailsFromContent,
  containsSensitiveMemory,
  findSemanticDuplicate,
  normalizeMemoryCandidate,
  parseMemoryCandidateResponse,
  rankMemories,
  shouldSuggestMemoryCandidate
} from './memory-utils.js';

test('memory candidate parser validates type and confidence', () => {
  const candidate = parseMemoryCandidateResponse('```json\n{"shouldSave":true,"type":"preference","title":"语言偏好","content":"偏好中文回答","confidence":1.4}\n```');
  assert.equal(candidate.type, 'preference');
  assert.equal(candidate.confidence, 1);
  assert.equal(normalizeMemoryCandidate({ title: '低置信度', content: '仍需审查', confidence: 0 }).confidence, 0);
  assert.equal(normalizeMemoryCandidate({ title: '', content: '' }), null);
});

test('memory candidates reject common secrets and direct identifiers', () => {
  const fakeSlackToken = ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-');
  const fakeApiKey = ['sk', '1234567890abcdefghijkl'].join('-');
  const fakeGithubToken = ['ghp', '1234567890abcdefghijklmnopqrstuv'].join('_');
  const fakeGoogleKey = ['AIza', 'SyD1234567890abcdefghijklmnopqrstu'].join('');
  assert.equal(containsSensitiveMemory('联系邮箱 user@example.com'), true);
  assert.equal(containsSensitiveMemory(`api_key: ${fakeApiKey}`), true);
  assert.equal(containsSensitiveMemory(fakeGithubToken), true);
  assert.equal(containsSensitiveMemory(fakeSlackToken), true);
  assert.equal(containsSensitiveMemory(fakeGoogleKey), true);
  assert.equal(containsSensitiveMemory('QWEN_API_KEY 无效时请检查配置'), false);
  assert.equal(
    normalizeMemoryCandidate({
      type: 'fact',
      title: '联系方式',
      content: '用户手机号是 13800138000'
    }),
    null
  );
});

test('pitfall details stay compatible after generic content corrections', () => {
  assert.deepEqual(
    buildPitfallDetailsFromContent('现象：请求失败\n根因：超时\n方案：增加超时\n经验：记录 span', ['HTTP']),
    {
      symptom: '请求失败',
      cause: '超时',
      solution: '增加超时',
      lesson: '记录 span',
      tags: ['HTTP']
    }
  );
  const freeform = buildPitfallDetailsFromContent('改为统一的纠正内容');
  assert.equal(freeform.symptom, '改为统一的纠正内容');
  assert.equal(freeform.solution, '改为统一的纠正内容');
});

test('memory ranking bounds oversized queries before lexical matching', () => {
  const longQuery = `${'无关'.repeat(100000)}目标`;
  const result = rankMemories(longQuery, [
    { id: 'bounded', title: '目标', content: '目标内容', confidence: 1, vectorScore: 0.8 }
  ]);
  assert.equal(result.length, 1);
});

test('memory prefilter only selects likely durable information', () => {
  assert.equal(shouldSuggestMemoryCandidate({
    userContent: '请记住：项目使用 Vue 3。',
    assistantContent: '好的。'
  }), true);
  assert.equal(shouldSuggestMemoryCandidate({ userContent: '我更喜欢简洁的中文回答' }), true);
  assert.equal(shouldSuggestMemoryCandidate({ userContent: '你好，今天天气怎样？' }), false);
  assert.equal(shouldSuggestMemoryCandidate({
    userContent: '帮我解释这段代码。',
    assistantContent: '这个报错可以通过修改 JSON.parse 解决。'
  }), false);
});

test('memory ranking combines lexical, vector and confidence signals', () => {
  const ranked = rankMemories('中文回答偏好', [
    { id: 'a', title: '语言偏好', content: '用户喜欢中文回答', confidence: 0.9, vectorScore: 0.8 },
    { id: 'b', title: '地点', content: '用户在深圳工作', confidence: 0.9, vectorScore: 0.1 }
  ]);
  assert.equal(ranked[0].id, 'a');
  const zeroConfidence = rankMemories('unmatched', [
    { id: 'zero', title: '其他', content: '无命中', confidence: 0, vectorScore: 0.2 }
  ]);
  assert.deepEqual(zeroConfidence, []);
});

test('semantic duplicate requires matching embedding dimensions', () => {
  assert.equal(findSemanticDuplicate([1, 0], [{ id: 'x', embedding: [1, 0, 0] }]), null);
  assert.equal(findSemanticDuplicate([1, 0], [{ id: 'x', embedding: [1, 0] }]).id, 'x');
});

test('memory context contains only provided reviewed memories', () => {
  const context = buildMemoryContext([{ type: 'fact', title: '地点', content: '用户在深圳工作' }]);
  assert.match(context, /用户已确认/);
  assert.match(context, /深圳/);
});
