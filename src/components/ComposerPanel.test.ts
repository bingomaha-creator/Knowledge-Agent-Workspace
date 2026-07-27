// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ComposerPanel from './ComposerPanel.vue';

describe('ComposerPanel Chat controls', () => {
  it('presents the current资料范围 and emits an explicit scope toggle', async () => {
    const wrapper = mount(ComposerPanel, {
      props: {
        modelValue: '',
        disabled: false,
        isResponding: false,
        ragEnabled: true,
        documentCount: 1,
        voiceSupported: false,
        voiceStatus: 'idle',
        voiceError: '',
        knowledgeBases: [
          { id: 'kb-1', name: '默认资料库', isDefault: true, documentCount: 1, publishedDocumentCount: 1, draftDocumentCount: 0, createdAt: 1, updatedAt: 1 },
          { id: 'kb-2', name: '项目资料', isDefault: false, documentCount: 3, publishedDocumentCount: 2, draftDocumentCount: 1, createdAt: 2, updatedAt: 2 }
        ],
        selectedKnowledgeBaseIds: ['kb-1'],
        presetId: 'general',
        presets: []
      }
    });

    expect(wrapper.text()).toContain('资料范围 · 1 个');
    const projectScope = wrapper.get('[aria-label="检索 项目资料"]');
    await projectScope.setValue(true);
    expect(wrapper.emitted('toggle-knowledge-base')).toEqual([['kb-2']]);
  });

  it('owns preset, RAG, and active-generation controls near the prompt', async () => {
    const wrapper = mount(ComposerPanel, {
      props: {
        modelValue: '继续解释',
        disabled: false,
        isResponding: true,
        ragEnabled: true,
        documentCount: 1,
        voiceSupported: false,
        voiceStatus: 'idle',
        voiceError: '',
        knowledgeBases: [],
        selectedKnowledgeBaseIds: [],
        presetId: 'general',
        presets: [
          { id: 'general', name: '通用助手', description: '', systemPrompt: '', modelParameters: { temperature: 0.2 }, toolWhitelist: [], defaultKnowledgeBaseIds: [], fewShot: [] },
          { id: 'coding', name: '编程助手', description: '', systemPrompt: '', modelParameters: { temperature: 0.2 }, toolWhitelist: [], defaultKnowledgeBaseIds: [], fewShot: [] }
        ]
      }
    });

    await wrapper.get('[aria-label="角色预设"]').setValue('coding');
    await wrapper.get('[aria-label="切换 RAG"]').trigger('click');
    await wrapper.get('[aria-label="停止输出"]').trigger('click');

    expect(wrapper.emitted('preset')).toEqual([['coding']]);
    expect(wrapper.emitted('toggle-rag')).toEqual([[]]);
    expect(wrapper.emitted('stop')).toEqual([[]]);
  });
});
