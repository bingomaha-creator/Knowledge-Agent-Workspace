<template>
  <details data-testid="investigation-details" class="investigation-advanced">
    <summary>
      <span>
        <strong>调查详情</strong>
        <small>完整证据、历史案例、候选门槛与运行信息</small>
      </span>
      <span>展开</span>
    </summary>

    <div class="investigation-advanced-content">
      <section v-if="investigation.analysis.similarCases.length" class="investigation-section">
        <header>
          <h4>相似已确认案例</h4>
          <span>当前项目优先，公共库仅作参考</span>
        </header>
        <div class="similar-case-grid">
          <article
            v-for="similarCase in investigation.analysis.similarCases"
            :key="similarCase.id"
            class="similar-case"
          >
            <span>{{ similarCase.scope === 'project' ? '当前项目' : '公共案例' }}</span>
            <strong>{{ similarCase.title }}</strong>
            <p>{{ similarCase.rootCause || '历史案例根因未知' }}</p>
            <small>{{ similarCase.matchedChannels.join(' + ') || '历史检索' }}</small>
          </article>
        </div>
      </section>

      <section v-if="investigation.analysis.missingEvidence.length" class="investigation-section evidence-gap">
        <header>
          <h4>全部证据缺口</h4>
          <span>按当前分析汇总</span>
        </header>
        <ul>
          <li v-for="item in investigation.analysis.missingEvidence" :key="item">{{ item }}</li>
        </ul>
      </section>

      <section class="investigation-section">
        <header>
          <h4>Candidate 门槛</h4>
          <span>{{ investigation.candidateReadiness.ready ? '已达到最低门槛' : '尚未达到最低门槛' }}</span>
        </header>
        <div class="readiness-grid">
          <span
            v-for="check in investigation.candidateReadiness.checks"
            :key="check.key"
            :class="{ passed: check.passed }"
          >
            {{ check.passed ? '✓' : '○' }} {{ check.label }}
          </span>
        </div>
      </section>

      <section class="investigation-section">
        <header>
          <h4>现场证据</h4>
          <span>只保存脱敏版本</span>
        </header>
        <div class="evidence-timeline">
          <article v-for="evidence in investigation.evidence" :key="evidence.id">
            <header>
              <strong>{{ evidenceLabel(evidence.type) }}</strong>
              <span>
                {{ formatTime(evidence.createdAt) }}
                <template v-if="redactionCount(evidence)"> · 已遮盖 {{ redactionCount(evidence) }} 处</template>
              </span>
            </header>
            <small v-if="evidence.metadata.fileName">
              {{ evidence.metadata.fileName }}
              <template v-if="evidence.metadata.language"> · {{ evidence.metadata.language }}</template>
            </small>
            <pre>{{ evidence.content }}</pre>
          </article>
        </div>
      </section>

      <section v-if="latestRun" class="investigation-run">
        <strong>最近一次分析</strong>
        <span>
          {{ latestRun.status }} · {{ latestRun.mode }} ·
          {{ latestRun.durationMs }}ms · {{ latestRun.evidenceCount }} 项证据 ·
          {{ latestRun.similarCaseCount }} 条案例
        </span>
      </section>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type {
  BugEvidence,
  BugEvidenceType,
  BugInvestigation
} from '../investigation-types';

const props = defineProps<{ investigation: BugInvestigation }>();
const latestRun = computed(() => {
  const runs = props.investigation.runs;
  return runs[runs.length - 1] || null;
});

function formatTime(timestamp: number) {
  if (!timestamp) return '刚刚';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(timestamp);
}

function evidenceLabel(type: BugEvidenceType) {
  return {
    error: 'Error / Stack Trace',
    network: 'Network Error',
    test_failure: '测试失败',
    code: '代码上下文',
    environment: '运行环境',
    reproduction: '复现步骤',
    verification: '人工验证结果',
    note: '补充说明'
  }[type];
}

function redactionCount(evidence: BugEvidence) {
  return evidence.redactions.reduce((sum, item) => sum + item.count, 0);
}
</script>

<style scoped>
.investigation-advanced { overflow: hidden; border: 1px solid var(--panel-line); border-radius: 14px; }
.investigation-advanced > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 15px; cursor: pointer; list-style: none; }
.investigation-advanced > summary::-webkit-details-marker { display: none; }
.investigation-advanced > summary > span:first-child { display: grid; gap: 3px; }
.investigation-advanced > summary small, .investigation-advanced > summary > span:last-child { color: var(--muted); font-size: 0.74rem; }
.investigation-advanced-content { display: grid; gap: 12px; padding: 0 14px 14px; }
.investigation-section { display: grid; gap: 12px; padding: 15px; background: var(--panel-muted); border: 1px solid var(--panel-line); border-radius: 14px; }
.investigation-section > header, .evidence-timeline article > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.investigation-section h4 { margin: 0; }
.investigation-section > header span { color: var(--muted); font-size: 0.76rem; }
.similar-case-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.similar-case { display: grid; gap: 6px; padding: 12px; background: var(--panel); border: 1px solid var(--panel-line); border-radius: 11px; }
.similar-case p { margin: 0; }
.similar-case > span { color: var(--accent-strong); font-size: 0.72rem; }
.similar-case small { color: var(--muted); }
.evidence-gap { border-color: #f2c66d; }
.evidence-gap ul { margin: 0; padding-left: 20px; }
.readiness-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.readiness-grid span { padding: 8px 10px; color: var(--muted); background: var(--panel); border-radius: 9px; }
.readiness-grid span.passed { color: #1e7a38; }
.evidence-timeline { display: grid; gap: 10px; }
.evidence-timeline article { min-width: 0; padding: 12px; background: var(--panel); border-radius: 11px; }
.evidence-timeline header span, .evidence-timeline small { color: var(--muted); font-size: 0.72rem; }
.evidence-timeline pre { max-height: 240px; margin: 9px 0 0; padding: 10px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--panel-muted); border-radius: 9px; font: 0.78rem/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
.investigation-run { display: flex; justify-content: space-between; gap: 10px; padding: 12px 14px; color: var(--muted); background: var(--panel-muted); border-radius: 11px; font-size: 0.75rem; }
.investigation-run strong { color: var(--text); }
@media (max-width: 680px) { .similar-case-grid, .readiness-grid { grid-template-columns: 1fr; } }
</style>
