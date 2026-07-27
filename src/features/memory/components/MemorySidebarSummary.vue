<template>
  <button class="sidebar-workspace-summary" type="button" @click="$emit('navigate')">
    <span>
      <strong>记忆中心</strong>
      <small>{{ totalCount }} 条记忆 · {{ candidateCount }} 条待审查</small>
    </span>
    <em>查看</em>
  </button>
</template>

<script setup lang="ts">
defineProps<{
  totalCount: number;
  candidateCount: number;
}>();

defineEmits<{ navigate: [] }>();
</script>
