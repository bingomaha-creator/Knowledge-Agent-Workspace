<template>
  <details class="research-diagnostics">
    <summary>
      <span>
        <strong>技术诊断</strong>
        <small>规划、检索、精读与写作的执行记录</small>
      </span>
      <em>展开</em>
    </summary>

    <div class="research-diagnostics-grid">
      <section>
        <span>规划</span>
        <strong>{{ diagnostics.planning?.mode || '—' }}</strong>
        <small>
          {{ diagnostics.planning?.durationMs || 0 }}ms
          <template v-if="diagnosticReasonLabel(diagnostics.planning?.reasonCode)">
            · {{ diagnosticReasonLabel(diagnostics.planning?.reasonCode) }}
          </template>
        </small>
      </section>
      <section>
        <span>检索</span>
        <strong>{{ diagnostics.retrieval?.length || 0 }} 个查询</strong>
        <small>{{ retrievalDuration }}ms · {{ retrievalSources }} 条候选</small>
      </section>
      <section>
        <span>来源精读</span>
        <strong>{{ diagnostics.reading?.readSourceCount || 0 }} / {{ diagnostics.reading?.selectedSourceCount || 0 }}</strong>
        <small>{{ diagnostics.reading?.durationMs || 0 }}ms · {{ diagnostics.reading?.failedSourceCount || 0 }} 个失败</small>
      </section>
      <section>
        <span>报告写作</span>
        <strong>{{ diagnostics.writing?.mode || '—' }}</strong>
        <small>
          {{ diagnostics.writing?.durationMs || 0 }}ms ·
          输入 {{ diagnostics.writing?.inputTokens || 0 }} / 输出 {{ diagnostics.writing?.outputTokens || 0 }} tokens
        </small>
      </section>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ResearchDiagnosticsView } from '../presentation';
import { diagnosticReasonLabel } from '../presentation';

const props = defineProps<{ diagnostics: ResearchDiagnosticsView }>();
const retrievalDuration = computed(() =>
  (props.diagnostics.retrieval || []).reduce((sum, item) => sum + (item.durationMs || 0), 0)
);
const retrievalSources = computed(() =>
  (props.diagnostics.retrieval || []).reduce((sum, item) => sum + (item.sourceCount || 0), 0)
);
</script>

<style scoped>
.research-diagnostics { padding: 13px 14px; background: var(--panel-muted); border: 1px solid var(--panel-line); border-radius: 13px; }
summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary span { display: grid; gap: 2px; }
summary strong { color: var(--heading); }
summary small, summary em { color: var(--muted); font-size: .74rem; font-style: normal; }
.research-diagnostics[open] summary em { visibility: hidden; }
.research-diagnostics-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin-top: 12px; }
section { display: grid; gap: 4px; padding: 11px; background: #fff; border: 1px solid var(--panel-line); border-radius: 10px; }
section span, section small { color: var(--muted); font-size: .72rem; }
section strong { color: var(--heading); }
@media (max-width: 760px) {
  .research-diagnostics-grid { grid-template-columns: 1fr; }
}
</style>
