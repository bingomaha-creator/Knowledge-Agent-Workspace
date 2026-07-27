// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { createWorkspaceRouter } from './router';

describe('Workspace router', () => {
  it('makes each top-level workspace and Research task addressable', async () => {
    const router = createWorkspaceRouter(createMemoryHistory());

    await router.push('/');
    await router.isReady();
    expect(router.currentRoute.value.fullPath).toBe('/chat');
    expect(router.currentRoute.value.name).toBe('chat');

    await router.push('/knowledge');
    expect(router.currentRoute.value.name).toBe('knowledge');

    await router.push('/memory');
    expect(router.currentRoute.value.name).toBe('memory');

    await router.push('/bugs');
    expect(router.currentRoute.value.name).toBe('bugs');

    await router.push('/research');
    expect(router.currentRoute.value.name).toBe('research');

    await router.push('/research/research-1');
    expect(router.currentRoute.value.name).toBe('research-task');
    expect(router.currentRoute.value.params.taskId).toBe('research-1');
  });

  it('restores the selected Research task through browser back and forward', async () => {
    const router = createWorkspaceRouter(createMemoryHistory());
    await router.push('/research/research-1');
    await router.isReady();
    await router.push('/research/research-2');

    router.back();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.currentRoute.value.params.taskId).toBe('research-1');

    router.forward();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.currentRoute.value.params.taskId).toBe('research-2');
  });
});
