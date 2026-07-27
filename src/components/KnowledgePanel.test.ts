// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import KnowledgePanel from './KnowledgePanel.vue';

describe('KnowledgePanel', () => {
  it('renders Knowledge-local feedback without a Chat feedback dependency', () => {
    const wrapper = mount(KnowledgePanel, {
      props: {
        knowledgeBases: [],
        activeKnowledgeBaseId: null,
        selectedKnowledgeBaseIds: [],
        documents: [],
        errorMessage: '加载知识库失败',
        noticeMessage: '知识文件已移除。'
      }
    });

    expect(wrapper.get('[data-testid="knowledge-error"]').text()).toBe('加载知识库失败');
    expect(wrapper.get('[data-testid="knowledge-notice"]').text()).toBe('知识文件已移除。');
  });

  it('shows draft governance actions and makes preview an explicit view', async () => {
    const base = {
      id: 'kb-default',
      name: '默认资料库',
      isDefault: true,
      documentCount: 1,
      publishedDocumentCount: 0,
      draftDocumentCount: 1,
      createdAt: 1,
      updatedAt: 1
    };
    const document = {
      id: 'doc-1',
      name: 'guide.md',
      knowledgeBaseId: 'kb-default',
      status: 'ready' as const,
      publicationStatus: 'draft' as const,
      publishedAt: null,
      createdAt: 2,
      updatedAt: 3
    };
    const wrapper = mount(KnowledgePanel, {
      props: {
        knowledgeBases: [base],
        activeKnowledgeBaseId: 'kb-default',
        selectedKnowledgeBaseIds: ['kb-default'],
        documents: [document]
      }
    });

    expect(wrapper.text()).toContain('0 份已发布');
    expect(wrapper.text()).toContain('1 份草稿');
    await wrapper.get('.knowledge-document-actions button').trigger('click');
    expect(wrapper.emitted('preview')).toEqual([['doc-1', 'kb-default']]);

    await wrapper.setProps({
      selectedPreview: {
        document,
        preview: {
          excerpt: '# Guide\n可信内容',
          truncated: false,
          characterCount: 13,
          chunkCount: 1,
          headings: ['Guide']
        }
      }
    });
    expect(wrapper.text()).toContain('发布为可检索知识');
    expect(wrapper.get('.knowledge-preview-content').text()).toContain('可信内容');
  });
});
