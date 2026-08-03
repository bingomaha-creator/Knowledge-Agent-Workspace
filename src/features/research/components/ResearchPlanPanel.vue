<template>
  <section class="research-plan-panel" aria-labelledby="research-plan-title">
    <header>
      <div>
        <p class="section-label">Research Plan</p>
        <h3 id="research-plan-title">本次准备查什么</h3>
      </div>
      <span>{{ plannerLabel(plan.planner) }}</span>
    </header>

    <ol>
      <li v-for="item in plan.subquestions" :key="item.id">
        <div class="research-plan-copy">
          <strong>{{ item.question }}</strong>
          <p>{{ intentLabel(item.intent) }} · {{ item.rationale }}</p>
          <div v-if="item.facets?.length || item.evidenceNeed?.preferredSourceTypes?.length" class="research-plan-tags">
            <span v-for="facet in item.facets" :key="facet">{{ facet.replace(/[_-]+/g, ' ') }}</span>
            <span
              v-for="sourceType in item.evidenceNeed?.preferredSourceTypes"
              :key="sourceType"
              class="research-source-tag"
            >
              {{ sourceTypeLabel(sourceType) }}
            </span>
          </div>
          <details v-if="item.searchQuery">
            <summary>查看实际搜索词</summary>
            <code>{{ item.searchQuery }}</code>
          </details>
        </div>
      </li>
    </ol>

    <p v-if="plan.planner === 'fallback'" class="research-plan-note">
      {{ plan.fallbackReason || '规划结果未通过校验，已围绕原始问题安全降级。' }}
    </p>
  </section>
</template>

<script setup lang="ts">
import type { ResearchPlanView } from '../presentation';
import { intentLabel, plannerLabel, sourceTypeLabel } from '../presentation';

defineProps<{ plan: ResearchPlanView }>();
</script>

<style scoped>
.research-plan-panel { padding: 15px; background: var(--panel-muted); border: 1px solid var(--panel-line); border-radius: 14px; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h3 { margin: 2px 0 0; color: var(--heading); }
header > span { padding: 4px 9px; color: var(--accent-strong); background: var(--accent-soft); border-radius: 999px; font-size: .72rem; font-weight: 700; }
ol { display: grid; gap: 11px; margin: 14px 0 0; padding: 0; list-style: none; counter-reset: plan; }
li { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 9px; counter-increment: plan; }
li::before { content: counter(plan); display: grid; place-items: center; width: 26px; height: 26px; color: var(--accent-strong); background: var(--accent-soft); border-radius: 8px; font-size: .76rem; font-weight: 700; }
.research-plan-copy { min-width: 0; }
strong { color: var(--heading); line-height: 1.45; }
p { margin: 3px 0 0; color: var(--muted); font-size: .8rem; line-height: 1.5; }
.research-plan-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.research-plan-tags span { padding: 3px 7px; color: var(--muted); background: #fff; border: 1px solid var(--panel-line); border-radius: 999px; font-size: .68rem; }
.research-plan-tags .research-source-tag { color: var(--accent-strong); border-color: #cfe0ff; }
details { margin-top: 7px; color: var(--accent-strong); font-size: .74rem; }
summary { cursor: pointer; }
code { display: block; margin-top: 6px; padding: 7px 8px; overflow-wrap: anywhere; color: var(--text); background: #fff; border-radius: 8px; white-space: normal; }
.research-plan-note { margin-top: 12px; }
</style>
