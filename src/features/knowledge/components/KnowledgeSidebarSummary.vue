<template>
  <button class="sidebar-workspace-summary" type="button" @click="$emit('navigate')">
    <span>
      <strong>资料库</strong>
      <small>{{ baseCount }} 个资料库 · {{ selectedDocumentCount }} 份已选文档</small>
    </span>
    <em>管理</em>
  </button>
</template>

<script setup lang="ts">
defineProps<{
  baseCount: number;
  selectedDocumentCount: number;
}>();

defineEmits<{ navigate: [] }>();
</script>
