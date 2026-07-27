<template>
  <section class="conversation-shell">
    <div v-if="messages.length <= 1" class="conversation-empty">
      <div class="empty-hero">
        <div class="hero-chip">Matthew's Workspace</div>
        <h2>今天想探索什么？</h2>
        <p>你可以直接聊天，也可以上传文档，让 Agent 自动调用后端工具完成向量检索与知识增强回答。</p>
      </div>
    </div>

    <DynamicScroller
      v-else
      ref="scrollerRef"
      class="conversation-scroller"
      :items="messages"
      :min-item-size="120"
      key-field="id"
      @resize="handleScrollerResize"
    >
      <template #default="{ item, index, active }">
        <DynamicScrollerItem
          :item="item"
          :active="active"
          :size-dependencies="[
            item.content,
            JSON.stringify(item.tools || []),
            JSON.stringify(item.citations || []),
            JSON.stringify(item.memoryCandidate || null),
            item.memoryStatus || '',
            memoryBusyIds.includes(item.memoryCandidate?.id || ''),
            memoryFailedIds.includes(item.memoryCandidate?.id || '')
          ]"
          :data-index="index"
        >
          <MessageCard
            :memory-busy-ids="memoryBusyIds"
            :memory-failed-ids="memoryFailedIds"
            :message="item"
            @bug-investigation="emit('bug-investigation', $event)"
            @correct-memory="(id, correction) => emit('correct-memory', id, correction)"
            @research="emit('research', $event)"
            @review-memory="(id, decision) => emit('review-memory', id, decision)"
            @layout-change="pauseAutoFollow"
          />
        </DynamicScrollerItem>
      </template>
    </DynamicScroller>

    <button
      v-if="showReturnToBottom"
      class="scroll-bottom-button"
      type="button"
      aria-label="回到底部"
      @click="resumeAutoFollow"
    >
      <span aria-hidden="true">↓</span>
      回到底部
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller';
import { isNearScrollBottom } from '@/services/chat-scroll';
import type { ChatMessage } from '@/features/chat/types';
import type { MemoryCorrection } from '@/features/memory/types';
import MessageCard from './MessageCard.vue';

/**
 * ChatPanel 解决两个与“长会话 + 流式更新”有关的问题：
 *
 * 1. 虚拟列表：DynamicScroller 只保留当前视口附近的 MessageCard，避免历史消息增长后 DOM 线性膨胀；
 * 2. 自动跟随：用户在底部时跟随新 token，主动向上阅读后暂停跟随，避免流式输出抢走滚动位置。
 *
 * messages 从 store 通过 App.vue 单向传入；本组件只管理滚动 UI，不改写消息业务状态。
 * 模板中 size-dependencies 告诉虚拟列表“哪些消息字段可能改变卡片高度”，
 * 这些字段随 SSE 改变时，DynamicScrollerItem 会重新测量而不沿用过期尺寸。
 */
const props = withDefaults(defineProps<{
  messages: ChatMessage[];
  memoryBusyIds?: string[];
  memoryFailedIds?: string[];
}>(), {
  memoryBusyIds: () => [],
  memoryFailedIds: () => []
});

const emit = defineEmits<{
  research: [seed: { question: string; sourceMessageId: string }];
  'bug-investigation': [seed: { content: string; sourceMessageId: string }];
  'correct-memory': [id: string, correction: MemoryCorrection];
  'review-memory': [id: string, decision: 'confirmed' | 'rejected'];
}>();

// scrollerRef 指向第三方虚拟列表实例，用它的 scrollToBottom() 而不自己推算虚拟内容偏移。
const scrollerRef = ref<any>(null);
// isFollowingStream 是滚动源状态：true 表示接受自动跟随，false 表示用户正在阅读上方历史。
const isFollowingStream = ref(true);
// “回到底部”是由消息数量与跟随状态派生的 UI，不需要单独同步一个 showButton ref。
const showReturnToBottom = computed(() => props.messages.length > 1 && !isFollowingStream.value);
// 直接保存真实滚动 DOM，用于读取 scrollTop/clientHeight/scrollHeight 并注册被动事件。
let scrollerElement: HTMLElement | null = null;

// 每次用户滚动时从 DOM 指标重新判定是否靠近底部。
// 而不是通过“滚动方向”猜测，因此拖动滚动条、触控和键盘滚动都有一致结果。
function updateAutoFollowState() {
  if (!scrollerElement) return;

  isFollowingStream.value = isNearScrollBottom({
    scrollTop: scrollerElement.scrollTop,
    clientHeight: scrollerElement.clientHeight,
    scrollHeight: scrollerElement.scrollHeight
  });
}

// force=false 时尊重用户的历史阅读位置；force=true 只用于新会话/用户主动点击回底部等明确意图。
// nextTick 等待 Vue 将新 token/消息渲染进 DOM，否则 scroller 可能还按旧高度定位。
async function scrollToBottom(force = false) {
  if (!force && !isFollowingStream.value) return;

  await nextTick();
  scrollerRef.value?.scrollToBottom();
}

// 按钮交互明确重启跟随模式，并立即执行一次强制定位。
function resumeAutoFollow() {
  isFollowingStream.value = true;
  scrollToBottom(true);
}

// 用户主动展开卡片详情时保持当前阅读位置。
// 后续高度重测仍会触发 resize，但 isFollowingStream=false 会阻止它被误判为流式增长。
function pauseAutoFollow() {
  isFollowingStream.value = false;
}

// 卡片内容、折叠面板或虚拟列表测量改变高度时，仅在原本跟随的前提下继续吸附底部。
function handleScrollerResize() {
  scrollToBottom();
}

// 消息数变化表示新一轮发送/删除/清空；这类结构变化重置自动跟随并强制回底部。
watch(
  () => props.messages.length,
  () => {
    isFollowingStream.value = true;
    scrollToBottom(true);
  },
  { immediate: true }
);

// 会话切换时数量可能恰好相同，所以另外监听首条消息 id 作为会话身份变化信号。
// flush:'post' 保证新会话 DOM 已经渲染后再执行定位。
watch(
  () => props.messages[0]?.id || '',
  (nextId, previousId) => {
    if (previousId && nextId !== previousId) {
      isFollowingStream.value = true;
      scrollToBottom(true);
    }
  },
  { flush: 'post' }
);

// token 追加不会改变 messages.length，因此用末条消息的 id/长度/状态构成轻量签名。
// 只在正在跟随时 scrollToBottom 才会真正移动，不会打断用户向上阅读。
watch(
  () => {
    const message = props.messages[props.messages.length - 1];
    return message
      ? `${message.id}:${message.content.length}:${message.status}:${message.memoryCandidate?.id || ''}:${message.memoryStatus || ''}`
      : '';
  },
  () => scrollToBottom(),
  { flush: 'post' }
);

// 挂载后等待异步 ChatPanel/DynamicScroller 真实 DOM 就绪，再保存元素并监听滚动。
// passive:true 表明监听器不会 preventDefault，浏览器可优化滚动性能。
onMounted(async () => {
  await nextTick();
  const element = scrollerRef.value?.$el;
  if (!(element instanceof HTMLElement)) return;

  scrollerElement = element;
  scrollerElement.addEventListener('scroll', updateAutoFollowState, { passive: true });
  scrollToBottom(true);
});

// 组件卸载/会话区销毁时移除原生监听器，避免闭包持有旧组件状态造成内存泄漏。
onBeforeUnmount(() => {
  scrollerElement?.removeEventListener('scroll', updateAutoFollowState);
});
</script>
