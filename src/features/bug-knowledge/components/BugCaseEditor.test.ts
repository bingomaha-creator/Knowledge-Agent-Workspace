// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import BugCaseEditor from './BugCaseEditor.vue';
import type { BugCase } from '../types';

function candidate(overrides: Partial<BugCase> = {}): BugCase {
  return {
    id: 'bug-1',
    knowledgeBaseId: 'kb-project-1',
    sourceProjectRef: 'project-1',
    scope: 'project',
    fingerprint: 'fingerprint',
    title: 'JSON parse failure',
    symptom: 'Unexpected end of JSON input',
    errorSignatures: ['Unexpected end of JSON input'],
    reproductionSteps: [],
    context: { language: 'TypeScript', framework: '', versions: [], module: '', environment: '' },
    resolutionType: 'root_cause_fix',
    rootCause: 'SSE block is incomplete',
    fix: 'Buffer a full event block before parsing.',
    workaroundRisks: [],
    applicability: [],
    verification: '',
    tags: ['streaming'],
    sourceRefs: ['investigation:bug-1'],
    status: 'ready',
    error: null,
    reviewStatus: 'candidate',
    reviewedBy: null,
    reviewReason: null,
    reviewedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

describe('BugCaseEditor review guard', () => {
  it('explains that confirmation needs saved verification rather than silently submitting', async () => {
    const wrapper = mount(BugCaseEditor, {
      props: { bugCase: candidate(), projectRef: 'project-1', busy: false }
    });

    await wrapper.get('textarea[placeholder="记录为什么确认或拒绝"]').setValue('已核对根因和修复方案');

    const confirm = wrapper.get('[data-testid="bug-confirm"]');
    expect(confirm.attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="bug-confirmation-blocker"]').text())
      .toContain('验证过程');

    await wrapper.get('[data-testid="bug-verification"]').setValue('最小复现已通过。');
    expect(wrapper.get('[data-testid="bug-confirmation-blocker"]').text())
      .toContain('保存并重新建索引');
  });
});
