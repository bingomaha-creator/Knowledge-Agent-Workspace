<template>
  <section class="research-evidence-panel" aria-labelledby="research-evidence-title">
    <header>
      <div>
        <p class="section-label">Evidence Pipeline</p>
        <h3 id="research-evidence-title">证据如何进入报告</h3>
      </div>
      <span>{{ pack.policyLabel || '证据优先' }}</span>
    </header>

    <div class="research-evidence-flow" role="list">
      <div v-for="(step, index) in steps" :key="step.label" role="listitem">
        <span>{{ step.label }}</span>
        <strong>{{ step.value }}</strong>
        <i v-if="index < steps.length - 1" aria-hidden="true">→</i>
      </div>
    </div>

    <p>
      <template v-if="pack.totalCharacters == null">
        这是旧版任务记录，未保存正文精读与证据字符统计。
      </template>
      <template v-else>
        共装配 {{ pack.totalCharacters }} 字符的段落级证据；
      </template>
      <template v-if="pack.totalCharacters != null && pack.snippetFallbackCount">
        其中 {{ pack.snippetFallbackCount }} 段因正文不可读而使用搜索摘要。
      </template>
      <template v-else-if="pack.totalCharacters != null">入选证据均来自已读取内容。</template>
    </p>
    <details v-if="pack.excludedCount || reading?.failures?.length">
      <summary>查看未采用与读取失败信息</summary>
      <ul>
        <li v-if="pack.excludedCount">{{ pack.excludedCount }} 条候选因相关性或资料配额未采用。</li>
        <li v-for="failure in reading?.failures" :key="`${failure.sourceId}-${failure.code}`">
          {{ failure.message }}
        </li>
      </ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ResearchArtifacts } from '../types';
import type { ResearchEvidencePackView } from '../presentation';

const props = defineProps<{
  pack: ResearchEvidencePackView;
  reading?: ResearchArtifacts['reading'] | null;
}>();

const steps = computed(() => [
  { label: '候选', value: props.pack.candidateCount },
  { label: '通过筛选', value: props.pack.acceptedCount },
  { label: '已读取', value: props.pack.readSourceCount || 0 },
  { label: '证据片段', value: props.pack.passageCount ?? props.pack.includedCount },
  { label: '报告引用', value: props.pack.citationCount ?? props.pack.includedCount }
]);
</script>

<style scoped>
.research-evidence-panel { padding: 15px; background: #f7faff; border: 1px solid #d8e5fb; border-radius: 14px; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h3 { margin: 2px 0 0; color: var(--heading); }
header > span { color: var(--muted); font-size: .74rem; }
.research-evidence-flow { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
.research-evidence-flow > div { position: relative; display: grid; gap: 4px; padding: 10px; background: #fff; border: 1px solid var(--panel-line); border-radius: 10px; }
.research-evidence-flow span { color: var(--muted); font-size: .7rem; }
.research-evidence-flow strong { color: var(--heading); font-size: 1.05rem; }
.research-evidence-flow i { position: absolute; top: 50%; right: -9px; z-index: 1; color: var(--accent-strong); font-style: normal; transform: translateY(-50%); }
p { margin: 11px 0 0; color: var(--muted); font-size: .8rem; line-height: 1.55; }
details { margin-top: 8px; color: var(--accent-strong); font-size: .78rem; }
summary { cursor: pointer; }
ul { margin: 7px 0 0; padding-left: 18px; color: var(--muted); }
@media (max-width: 760px) {
  .research-evidence-flow { grid-template-columns: 1fr; }
  .research-evidence-flow i { top: auto; right: 12px; bottom: -12px; transform: rotate(90deg); }
}
</style>
