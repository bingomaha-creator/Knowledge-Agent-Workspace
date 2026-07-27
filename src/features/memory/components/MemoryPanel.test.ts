// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MemoryPanel from './MemoryPanel.vue';
import type { MemoryRecord } from '../types';

const candidate: MemoryRecord = {
  id: 'memory-1',
  type: 'fact',
  title: '项目事实',
  content: '使用 Vue',
  details: {},
  confidence: 0.8,
  status: 'candidate',
  sourceConversationId: 'session-1',
  sourceMessageIds: [],
  sourceExcerpt: '',
  createdAt: 1,
  updatedAt: 1
};

describe('MemoryPanel presentation interface', () => {
  it('uses the shared compact select contract for workspace filters', () => {
    const wrapper = mount(MemoryPanel, {
      props: {
        memories: [],
        busyIds: [],
        failedIds: [],
        creating: false,
        errorMessage: '',
        noticeMessage: ''
      }
    });

    expect(wrapper.findAll('.memory-filters .workspace-filter-select')).toHaveLength(2);
  });

  it('renders Memory-local feedback and emits review intent without importing a store', async () => {
    const wrapper = mount(MemoryPanel, {
      props: {
        memories: [candidate],
        busyIds: [],
        failedIds: ['memory-1'],
        creating: false,
        errorMessage: '审查失败',
        noticeMessage: '记忆已同步'
      }
    });

    expect(wrapper.get('[data-testid="memory-error"]').text()).toBe('审查失败');
    expect(wrapper.get('[data-testid="memory-notice"]').text()).toBe('记忆已同步');
    expect(wrapper.text()).toContain('操作失败');

    const buttons = wrapper.findAll('button');
    await buttons.find((button) => button.text() === '确认')!.trigger('click');
    expect(wrapper.emitted('review')).toEqual([['memory-1', 'confirmed']]);
  });

  it('lets the user create a typed confirmed Memory from the workspace', async () => {
    const wrapper = mount(MemoryPanel, {
      props: {
        memories: [],
        busyIds: [],
        failedIds: [],
        creating: false,
        errorMessage: '',
        noticeMessage: ''
      }
    });

    await wrapper.get('[data-testid="new-memory"]').trigger('click');
    await wrapper.get('[data-testid="memory-create-type"]').setValue('preference');
    await wrapper.get('[data-testid="memory-create-title"]').setValue('回答风格');
    await wrapper.get('[data-testid="memory-create-content"]')
      .setValue('回答时先给结论，再解释原因。');
    await wrapper.get('[data-testid="memory-create-form"]').trigger('submit');

    expect(wrapper.emitted('create')).toEqual([[
      {
        type: 'preference',
        title: '回答风格',
        content: '回答时先给结论，再解释原因。'
      }
    ]]);
    expect(wrapper.find('[data-testid="memory-create-form"]').exists()).toBe(true);

    await wrapper.setProps({ creating: true });
    expect(wrapper.get('[data-testid="memory-create-form"]').text()).toContain('保存中');

    await wrapper.setProps({
      creating: false,
      noticeMessage: '记忆已创建并确认。'
    });
    expect(wrapper.find('[data-testid="memory-create-form"]').exists()).toBe(false);
  });
});
