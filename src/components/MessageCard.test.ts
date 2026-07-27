// @vitest-environment happy-dom

import { createPinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MessageCard from './MessageCard.vue';
import type { ChatMessage } from '@/features/chat/types';
import type { MemoryRecord } from '@/features/memory/types';

function message(role: ChatMessage['role']): ChatMessage {
  return {
    id: `${role}-1`,
    role,
    content: '请深入比较两个架构方案',
    createdAt: 1,
    status: 'done'
  };
}

describe('MessageCard Research Draft intent', () => {
  it('offers a stable user message as a draft seed without creating a task', async () => {
    const wrapper = mount(MessageCard, {
      props: { message: message('user') },
      global: { plugins: [createPinia()] }
    });

    await wrapper.get('[data-testid="message-to-research"]').trigger('click');
    expect(wrapper.emitted('research')).toEqual([[{
      question: '请深入比较两个架构方案',
      sourceMessageId: 'user-1'
    }]]);

    await wrapper.get('[data-testid="message-to-bug-investigation"]').trigger('click');
    expect(wrapper.emitted('bug-investigation')).toEqual([[{
      content: '请深入比较两个架构方案',
      sourceMessageId: 'user-1'
    }]]);
  });

  it('does not offer the action on assistant messages', () => {
    const wrapper = mount(MessageCard, {
      props: { message: message('assistant') },
      global: { plugins: [createPinia()] }
    });
    expect(wrapper.find('[data-testid="message-to-research"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="message-to-bug-investigation"]').exists()).toBe(false);
  });

  it('emits canonical Memory review intent instead of calling a store', async () => {
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
    const wrapper = mount(MessageCard, {
      props: {
        message: {
          ...message('assistant'),
          memoryCandidate: candidate,
          memoryStatus: 'candidate'
        },
        memoryBusyIds: [],
        memoryFailedIds: []
      },
      global: { plugins: [createPinia()] }
    });

    const confirm = wrapper.findAll('button').find((button) => button.text() === '确认记忆');
    await confirm!.trigger('click');
    expect(wrapper.emitted('review-memory')).toEqual([['memory-1', 'confirmed']]);
  });

  it('lets the user correct a Memory candidate before confirming it', async () => {
    const candidate: MemoryRecord = {
      id: 'memory-1',
      type: 'pitfall',
      title: '旧分类',
      content: '旧内容',
      details: {},
      confidence: 0.8,
      status: 'candidate',
      sourceConversationId: 'session-1',
      sourceMessageIds: [],
      sourceExcerpt: '',
      createdAt: 1,
      updatedAt: 1
    };
    const wrapper = mount(MessageCard, {
      props: {
        message: {
          ...message('assistant'),
          memoryCandidate: candidate,
          memoryStatus: 'candidate'
        },
        memoryBusyIds: [],
        memoryFailedIds: []
      },
      global: { plugins: [createPinia()] }
    });

    await wrapper.get('[data-testid="edit-memory-candidate"]').trigger('click');
    await wrapper.get('[data-testid="candidate-memory-type"]').setValue('fact');
    await wrapper.get('[data-testid="candidate-memory-title"]').setValue('项目技术栈');
    await wrapper.get('[data-testid="candidate-memory-content"]').setValue('项目使用 Vue 3。');
    await wrapper.get('[data-testid="candidate-memory-form"]').trigger('submit');

    expect(wrapper.emitted('correct-memory')).toEqual([[
      'memory-1',
      {
        type: 'fact',
        title: '项目技术栈',
        content: '项目使用 Vue 3。'
      }
    ]]);
  });

  it('does not reactivate retired Pitfall actions from an old persisted message', () => {
    const legacyMessage = {
      ...message('assistant'),
      pitfallCandidate: {
        title: '旧踩坑候选',
        symptom: '旧现象',
        solution: '旧方案',
        tags: ['legacy']
      },
      pitfallStatus: 'pending'
    } as ChatMessage;
    const wrapper = mount(MessageCard, {
      props: { message: legacyMessage },
      global: { plugins: [createPinia()] }
    });

    expect(wrapper.text()).not.toContain('可保存为踩坑');
    expect(wrapper.text()).not.toContain('保存为踩坑');
  });

  it('reveals safe context decisions through the unified answer details without exposing source content', async () => {
    const contextManifest = {
      schemaVersion: 1 as const,
      buildId: 'ctx-final',
      purpose: 'answer_generation' as const,
      policyVersion: 'context-policy-v1',
      estimatorVersion: 'cjk-conservative-v1',
      profile: {
        id: 'qwen-context',
        contextWindowTokens: 32768,
        outputReserveTokens: 4096,
        safetyReserveTokens: 2048,
        inputBudgetTokens: 26624
      },
      estimatedInputTokens: 1200,
      decisions: [
        {
          candidateId: 'turn-1',
          kind: 'conversation_turn' as const,
          sourceRef: { id: 'message-1,message-2' },
          estimatedTokens: 400,
          decision: 'included' as const,
          reason: 'conversation_continuity' as const
        },
        {
          candidateId: 'turn-2',
          kind: 'conversation_turn' as const,
          sourceRef: { id: 'message-3,message-4' },
          estimatedTokens: 400,
          decision: 'included' as const,
          reason: 'conversation_continuity' as const
        },
        {
          candidateId: 'chunk-1',
          kind: 'knowledge_chunk' as const,
          sourceRef: { id: 'chunk-1', parentId: 'doc-1' },
          estimatedTokens: 400,
          decision: 'included' as const,
          reason: 'relevant' as const
        },
        {
          candidateId: 'memory-1',
          kind: 'memory' as const,
          sourceRef: { id: 'memory-1' },
          estimatedTokens: 300,
          decision: 'excluded' as const,
          reason: 'over_budget' as const
        }
      ],
      summary: {
        includedCount: 3,
        excludedCount: 1,
        includedByKind: {
          conversation_turn: 2,
          knowledge_chunk: 1
        },
        excludedByReason: { over_budget: 1 }
      },
      warnings: []
    };
    const wrapper = mount(MessageCard, {
      props: {
        message: {
          ...message('assistant'),
          run: {
            id: 'run-context',
            conversationId: 'session-1',
            status: 'success',
            model: 'qwen',
            inputTokens: 1300,
            outputTokens: 100,
            estimatedCost: 0,
            createdAt: 1,
            updatedAt: 2,
            finishedAt: 2,
            spans: [{
              id: 'span-generation',
              runId: 'run-context',
              parentId: null,
              name: 'generation',
              kind: 'model',
              status: 'success',
              inputTokens: 1300,
              outputTokens: 100,
              estimatedCost: 0,
              metadata: { contextManifest },
              startedAt: 1,
              finishedAt: 2,
              durationMs: 1
            }, {
              id: 'span-evidence',
              runId: 'run-context',
              parentId: null,
              name: 'knowledge_evidence_gate',
              kind: 'retrieval',
              status: 'success',
              inputTokens: 0,
              outputTokens: 0,
              estimatedCost: 0,
              metadata: {
                evidence: {
                  policyVersion: 'chat-evidence-v1',
                  status: 'evidence_gap',
                  reason: 'weak_candidates',
                  candidateCount: 3,
                  selectedCount: 0,
                  filteredCount: 3,
                  channels: {
                    keywordCandidates: 0,
                    vectorOnlyCandidates: 3,
                    degradedChannels: []
                  }
                }
              },
              startedAt: 1,
              finishedAt: 2,
              durationMs: 1
            }]
          }
        }
      },
      global: { plugins: [createPinia()] }
    });

    expect(wrapper.get('[data-testid="answer-detail-toggle"]').text())
      .toContain('2 轮历史 · 1 个资料片段 · 1ms');
    expect(wrapper.get('[data-testid="answer-detail-content"]').attributes('style'))
      .toContain('display: none');

    await wrapper.get('[data-testid="answer-detail-toggle"]').trigger('click');

    const detail = wrapper.get('[data-testid="answer-detail-content"]');
    expect(detail.text()).toContain('本轮使用的信息');
    expect(detail.text()).toContain('使用了 2 轮对话历史、1 个资料片段');
    expect(detail.text()).toContain('未进入本轮回答');
    expect(detail.text()).toContain('长期记忆、研究证据');
    expect(detail.text()).toContain('技术诊断');
    expect(detail.text()).toContain('超出预算 1');
    expect(detail.text()).toContain('资料库取证');
    expect(detail.text()).toContain('未找到可用证据');
    expect(detail.text()).toContain('候选 3');
    expect(detail.text()).toContain('采用 0');
    expect(detail.text()).toContain('过滤 3');
    expect(detail.text()).not.toContain('不应出现的上下文正文');
    expect(detail.text()).not.toContain('message-1,message-2');

    const decisionsToggle = wrapper.get('[data-testid="context-decisions-toggle"]');
    expect(decisionsToggle.attributes('aria-expanded')).toBe('false');
    await decisionsToggle.trigger('click');
    expect(decisionsToggle.attributes('aria-expanded')).toBe('true');
    const decisions = wrapper.get('[data-testid="context-decisions-detail"]');
    expect(decisions.text()).toContain('第 1 轮对话');
    expect(decisions.text()).toContain('资料片段 1');
    expect(decisions.text()).toContain('长期记忆 1');
    expect(decisions.text()).not.toContain('message-1,message-2');

    await wrapper.get('[data-testid="context-raw-identifiers-toggle"]').trigger('click');
    expect(decisions.text()).toContain('message-1,message-2');

    const diagnosticsToggle = wrapper.get('[data-testid="run-diagnostics-toggle"]');
    expect(diagnosticsToggle.text()).toContain('成功 · 1ms · 输入 1300 / 输出 100');
    await diagnosticsToggle.trigger('click');
    const diagnostics = wrapper.get('[data-testid="run-diagnostics-detail"]');
    expect(diagnostics.text()).toContain('生成最终回答');
    expect(diagnostics.text()).toContain('模型 · 成功');
    expect(diagnostics.text()).toContain('输入 1300 · 输出 100 tokens');
    expect(diagnostics.text()).toContain('本地估算上下文 1.2k / 26.6k');

    expect(wrapper.emitted('layout-change')).toHaveLength(4);
  });
});
