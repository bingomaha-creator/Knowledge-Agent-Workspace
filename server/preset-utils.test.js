import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPresetFewShotMessages,
  loadPresets,
  resolvePreset,
  resolvePresetKnowledgeScope
} from './preset-utils.js';

test('built-in presets include four validated roles and safe server tool lists', () => {
  const presets = loadPresets('');
  assert.deepEqual(presets.map((preset) => preset.id), ['general', 'documents', 'code', 'research']);
  for (const preset of presets) {
    assert.deepEqual(preset.toolWhitelist, [
      'retrieve_knowledge',
      'list_knowledge_documents',
      'get_current_time'
    ]);
  }
  assert.equal(resolvePreset(presets, 'code').id, 'code');
  assert.equal(resolvePreset(presets, 'unknown').id, 'general');
  assert.ok(resolvePreset(presets, 'documents').toolWhitelist.includes('retrieve_knowledge'));
  assert.deepEqual(resolvePreset(presets, 'documents').defaultKnowledgeBaseIds, ['kb-default']);
  assert.equal(buildPresetFewShotMessages(resolvePreset(presets, 'code')).length, 2);
});

test('preset overrides are bounded and cannot add write tools', () => {
  const presets = loadPresets(JSON.stringify({
    code: {
      modelParameters: { temperature: 99, topP: -1, maxTokens: 999999 },
      toolWhitelist: ['delete_memory', 'get_current_time'],
      defaultKnowledgeBaseIds: ['kb-code'],
      fewShot: [{ user: '问题', assistant: '回答' }]
    }
  }));
  const code = resolvePreset(presets, 'code');
  assert.equal(code.modelParameters.temperature, 2);
  assert.equal(code.modelParameters.topP, 0);
  assert.equal(code.modelParameters.maxTokens, 32_000);
  assert.deepEqual(code.toolWhitelist, ['get_current_time']);
  assert.deepEqual(resolvePresetKnowledgeScope(code, undefined), ['kb-code']);
  assert.deepEqual(resolvePresetKnowledgeScope(code, []), []);
});

test('null and primitive preset overrides safely fall back to built-ins', () => {
  const presets = loadPresets(JSON.stringify({
    general: { toolWhitelist: null },
    documents: 'invalid',
    code: null,
    research: []
  }));
  assert.equal(presets.length, 4);
  assert.ok(resolvePreset(presets, 'general').toolWhitelist.includes('retrieve_knowledge'));
  assert.equal(resolvePreset(presets, 'documents').name, '资料助手');
  assert.equal(resolvePreset(presets, 'code').modelParameters.temperature, 0.2);
  assert.deepEqual(resolvePreset(presets, 'research').defaultKnowledgeBaseIds, ['kb-default']);
});
