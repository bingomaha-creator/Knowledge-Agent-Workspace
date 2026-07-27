// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TopBar from './TopBar.vue';

describe('TopBar workspace navigation', () => {
  it('presents the four primary workspaces without duplicating Chat controls', async () => {
    const wrapper = mount(TopBar, {
      props: {
        activeWorkspace: 'knowledge',
        conversationId: 'session-1',
        messageCount: 2,
        documentCount: 1,
      }
    });

    const labels = wrapper.findAll('.topbar-right button').map((button) => button.text());
    expect(labels).toEqual(['对话', '资料库', 'Bug 案例', '深度研究']);
    await wrapper.findAll('.topbar-right button')[1].trigger('click');
    expect(wrapper.emitted('workspace')).toEqual([['knowledge']]);
  });
});
