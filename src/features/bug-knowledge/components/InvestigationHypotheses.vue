<template>
  <section v-if="primary" class="investigation-section hypothesis-section">
    <header>
      <h4>当前优先假设</h4>
      <span>用于决定下一步验证，不是根因结论</span>
    </header>

    <article data-testid="primary-hypothesis" class="hypothesis-card hypothesis-primary">
      <header>
        <strong>{{ primary.title }}</strong>
        <span>{{ confidenceLabel(primary.confidenceLabel) }}</span>
      </header>
      <p>{{ primary.reasoning }}</p>
      <div class="hypothesis-evidence">
        <span>依据</span>
        <strong>{{ primary.supportingEvidenceIds.length }} 项现场证据</strong>
        <template v-if="primary.relatedCaseIds.length">
          <span>关联</span>
          <strong>{{ primary.relatedCaseIds.length }} 条已确认案例</strong>
        </template>
      </div>
    </article>

    <details v-if="remaining.length" class="remaining-hypotheses">
      <summary>查看另外 {{ remaining.length }} 个低优先级假设</summary>
      <article
        v-for="hypothesis in remaining"
        :key="hypothesis.title"
        class="hypothesis-card"
      >
        <header>
          <strong>{{ hypothesis.title }}</strong>
          <span>{{ confidenceLabel(hypothesis.confidenceLabel) }}</span>
        </header>
        <p>{{ hypothesis.reasoning }}</p>
      </article>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { BugHypothesis } from '../investigation-types';

const props = defineProps<{ hypotheses: BugHypothesis[] }>();

const primary = computed(() => props.hypotheses[0] || null);
const remaining = computed(() => props.hypotheses.slice(1));

function confidenceLabel(value: BugHypothesis['confidenceLabel']) {
  return {
    supported: '证据支持',
    plausible: '有待验证',
    weak: '弱假设'
  }[value];
}
</script>

<style scoped>
.investigation-section { display: grid; gap: 12px; padding: 15px; background: var(--panel-muted); border: 1px solid var(--panel-line); border-radius: 14px; }
.investigation-section > header, .hypothesis-card header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.investigation-section h4 { margin: 0; }
.investigation-section > header span { color: var(--muted); font-size: 0.76rem; }
.hypothesis-card { display: grid; gap: 10px; padding: 13px; background: var(--panel); border: 1px solid var(--panel-line); border-radius: 11px; }
.hypothesis-primary { border-color: color-mix(in srgb, var(--accent) 45%, var(--panel-line)); }
.hypothesis-card header span { color: var(--accent-strong); font-size: 0.72rem; }
.hypothesis-card p { margin: 0; line-height: 1.65; }
.hypothesis-evidence { display: flex; flex-wrap: wrap; gap: 6px 10px; color: var(--muted); font-size: 0.75rem; }
.hypothesis-evidence strong { color: var(--text); }
.remaining-hypotheses summary { color: var(--accent-strong); cursor: pointer; font-weight: 700; }
.remaining-hypotheses .hypothesis-card { margin-top: 10px; }
</style>
