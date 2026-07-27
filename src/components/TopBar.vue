<template>
  <header class="topbar-shell">
    <div class="topbar-left">
      <button class="nav-icon-button desktop-hidden" @click="$emit('menu')">☰</button>
      <div class="topbar-title-group">
        <h1>Matthew's Workspace</h1>
        <p>{{ titleText }}</p>
      </div>
    </div>

    <div class="topbar-right">
      <button class="topbar-chip" :class="{ 'workspace-chip-active': activeWorkspace === 'chat' }" :aria-pressed="activeWorkspace === 'chat'" @click="$emit('workspace', 'chat')">对话</button>
      <button class="topbar-chip" :class="{ 'workspace-chip-active': activeWorkspace === 'knowledge' }" :aria-pressed="activeWorkspace === 'knowledge'" @click="$emit('workspace', 'knowledge')">资料库</button>
      <button class="topbar-chip" :class="{ 'workspace-chip-active': activeWorkspace === 'bugs' }" :aria-pressed="activeWorkspace === 'bugs'" @click="$emit('workspace', 'bugs')">Bug 案例</button>
      <button class="topbar-chip" :class="{ 'workspace-chip-active': activeWorkspace === 'research' }" :aria-pressed="activeWorkspace === 'research'" @click="$emit('workspace', 'research')">深度研究</button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue';

/**
 * TopBar 是无业务副作用的控制组件。
 * props 由 App.vue 从 store 传入，用来决定文案和主工作区状态；
 * emits 只表达导航意图，具体路由切换由 App.vue 执行。
 * 这种分工使顶栏易于阅读，也避免子组件直接改写父级数据。
 */
const props = defineProps<{
  documentCount: number;
  conversationId: string;
  messageCount: number;
  activeWorkspace: 'chat' | 'knowledge' | 'memory' | 'bugs' | 'research';
}>();

// 每个事件的参数就是组件对外的类型契约；TopBar 不直接依赖 router。
defineEmits<{
  menu: [];
  workspace: [workspace: 'chat' | 'knowledge' | 'bugs' | 'research'];
}>();

// titleText 是由 props 推导的派生状态，不需要额外 ref 或 watch；
// 任一依赖变化时，Vue 会缓存失效并重新计算。
const titleText = computed(
  () => {
    if (props.activeWorkspace === 'bugs') return '人工审核 · 项目隔离 · exact + FTS + vector';
    if (props.activeWorkspace === 'research') return '异步任务 · 独立草稿 · 可寻址报告';
    if (props.activeWorkspace === 'knowledge') return '文档管理 · 索引状态 · 对话资料范围';
    if (props.activeWorkspace === 'memory') return '长期记忆 · 人工审查 · 来源会话';
    return `Matthew's Workspace · 会话 ${props.conversationId.slice(0, 8)} · ${props.messageCount} 条消息 · ${props.documentCount} 份知识文档`;
  }
);
</script>

<style scoped>
.workspace-chip-active {
  color: #174ea6;
  background: var(--accent-soft);
  border-color: #8ab4f8;
}
</style>
