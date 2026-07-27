<template>
  <section v-if="primary" data-testid="verification-plan" class="verification-plan">
    <header>
      <div>
        <span>Verification Plan</span>
        <h4>下一步怎么验证</h4>
      </div>
      <small>执行后请把实际结果作为“人工验证结果”追加</small>
    </header>

    <article class="verification-step">
      <strong>{{ primary.title }}</strong>
      <p class="verification-instruction">{{ primary.instruction }}</p>
      <div class="verification-signals">
        <div class="verification-signal supports">
          <span>看到这些，支持当前假设</span>
          <p>{{ supportingSignal(primary) }}</p>
        </div>
        <div class="verification-signal refutes">
          <span>出现这些，降低当前假设</span>
          <p>{{ refutingSignal(primary) }}</p>
        </div>
      </div>
    </article>

    <details v-if="remaining.length">
      <summary>查看另外 {{ remaining.length }} 个验证方法</summary>
      <article v-for="step in remaining" :key="step.title" class="verification-step secondary">
        <strong>{{ step.title }}</strong>
        <p class="verification-instruction">{{ step.instruction }}</p>
        <div class="verification-signals">
          <div class="verification-signal supports">
            <span>支持信号</span>
            <p>{{ supportingSignal(step) }}</p>
          </div>
          <div class="verification-signal refutes">
            <span>反驳信号</span>
            <p>{{ refutingSignal(step) }}</p>
          </div>
        </div>
      </article>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { BugVerificationStep } from '../investigation-types';

const props = defineProps<{ steps: BugVerificationStep[] }>();
const primary = computed(() => props.steps[0] || null);
const remaining = computed(() => props.steps.slice(1));

function supportingSignal(step: BugVerificationStep) {
  return step.supportingSignal
    || step.expectedSignal
    || '观察到验证方法所描述的异常信号。';
}

function refutingSignal(step: BugVerificationStep) {
  return step.refutingSignal
    || '未观察到支持信号，且相同输入下现象仍可稳定复现。';
}
</script>

<style scoped>
.verification-plan { display: grid; gap: 12px; padding: 15px; background: var(--panel-muted); border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--panel-line)); border-radius: 14px; }
.verification-plan > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.verification-plan > header div { display: grid; gap: 3px; }
.verification-plan h4 { margin: 0; }
.verification-plan > header span { color: var(--accent-strong); font-size: 0.68rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
.verification-plan > header small { max-width: 280px; color: var(--muted); text-align: right; }
.verification-step { display: grid; gap: 10px; padding: 13px; background: var(--panel); border: 1px solid var(--panel-line); border-radius: 11px; }
.verification-step.secondary { margin-top: 10px; }
.verification-instruction { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; }
.verification-signals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.verification-signal { padding: 10px 11px; border-radius: 9px; }
.verification-signal span { font-size: 0.72rem; font-weight: 800; }
.verification-signal p { margin: 5px 0 0; line-height: 1.55; }
.verification-signal.supports { color: #286b3a; background: #eaf7ed; }
.verification-signal.refutes { color: #8b4b10; background: #fff3e2; }
.verification-plan summary { color: var(--accent-strong); cursor: pointer; font-weight: 700; }
@media (max-width: 680px) {
  .verification-plan > header { display: grid; }
  .verification-plan > header small { max-width: none; text-align: left; }
  .verification-signals { grid-template-columns: 1fr; }
}
</style>
