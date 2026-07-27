// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { describe, expect, it } from 'vitest';
import { createChatStore } from './store';
import type { BackendStreamEvent, ChatTransport } from './types';

describe('Chat store streaming reactivity', () => {
  it('renders streamed content and the terminal status without a reload', async () => {
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const transport: ChatTransport = {
      async listPresets() {
        return [];
      },
      async getRun() {
        throw new Error('unused');
      },
      stream() {
        return (async function* stream(): AsyncIterable<BackendStreamEvent> {
          await streamGate;
          yield { type: 'token', token: '答案' };
          yield { type: 'done' };
        })();
      }
    };
    let sequence = 0;
    const store = createChatStore(transport, {
      storeId: 'chat-streaming-reactivity',
      createId: (prefix) => `${prefix}-${++sequence}`,
      now: () => sequence
    })();
    const Harness = defineComponent({
      setup() {
        return () => {
          const latestMessage = store.messages[store.messages.length - 1];
          return h('div', `${latestMessage.content}|${latestMessage.status}`);
        };
      }
    });
    const wrapper = mount(Harness, {
      global: {
        plugins: [pinia]
      }
    });

    const pendingRequest = store.send('问题');
    await nextTick();
    expect(wrapper.text()).toBe('|streaming');

    releaseStream();
    await pendingRequest;
    await nextTick();

    expect(wrapper.text()).toBe('答案|done');
  });
});
