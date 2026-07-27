// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, type PropType } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/features/chat/types';
import ChatPanel from './ChatPanel.vue';
import MessageCard from './MessageCard.vue';

const virtualScroller = vi.hoisted(() => ({
  scrollToBottom: vi.fn()
}));

vi.mock('vue-virtual-scroller', () => ({
  DynamicScroller: defineComponent({
    name: 'DynamicScroller',
    props: {
      items: {
        type: Array as PropType<ChatMessage[]>,
        default: () => []
      }
    },
    emits: ['resize'],
    setup(props, { expose, slots }) {
      expose({
        scrollToBottom: virtualScroller.scrollToBottom
      });
      return () => h(
        'div',
        { class: 'conversation-scroller' },
        props.items.flatMap((item, index) =>
          slots.default?.({ item, index, active: true }) || []
        )
      );
    }
  }),
  DynamicScrollerItem: defineComponent({
    name: 'DynamicScrollerItem',
    setup(_, { slots }) {
      return () => h('div', slots.default?.());
    }
  })
}));

function message(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    role,
    content: id,
    status: 'done',
    createdAt: 1
  };
}

describe('ChatPanel reading position', () => {
  beforeEach(() => {
    virtualScroller.scrollToBottom.mockClear();
  });

  it('does not auto-scroll after the user changes a message detail layout', async () => {
    const wrapper = mount(ChatPanel, {
      props: {
        messages: [
          message('assistant-1', 'assistant'),
          message('assistant-2', 'assistant')
        ]
      }
    });
    await nextTick();
    await nextTick();
    virtualScroller.scrollToBottom.mockClear();

    wrapper.findAllComponents(MessageCard)[1].vm.$emit('layout-change');
    await nextTick();
    wrapper.findComponent({ name: 'DynamicScroller' }).vm.$emit('resize');
    await nextTick();

    expect(virtualScroller.scrollToBottom).not.toHaveBeenCalled();
    expect(wrapper.get('.scroll-bottom-button').text()).toContain('回到底部');
  });

  it('forwards an inline Memory correction to the workspace boundary', async () => {
    const wrapper = mount(ChatPanel, {
      props: {
        messages: [
          message('user-1', 'user'),
          message('assistant-1', 'assistant')
        ]
      }
    });
    const correction = {
      type: 'fact' as const,
      title: '项目技术栈',
      content: '项目使用 Vue 3。'
    };

    wrapper.findAllComponents(MessageCard)[1].vm.$emit(
      'correct-memory',
      'memory-1',
      correction
    );
    await nextTick();

    expect(wrapper.emitted('correct-memory')).toEqual([['memory-1', correction]]);
  });
});
