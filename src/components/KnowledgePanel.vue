<template>
  <section class="knowledge-panel knowledge-workspace" aria-labelledby="knowledge-workspace-title">
    <div class="knowledge-header">
      <div>
        <p class="section-label">Knowledge</p>
        <h2 id="knowledge-workspace-title">资料库管理</h2>
      </div>
      <span class="knowledge-count">{{ knowledgeBases.length }} 个</span>
    </div>

    <p
      v-if="errorMessage"
      class="knowledge-feedback knowledge-feedback-error"
      data-testid="knowledge-error"
      role="alert"
    >
      {{ errorMessage }}
    </p>
    <p
      v-if="noticeMessage"
      class="knowledge-feedback knowledge-feedback-notice"
      data-testid="knowledge-notice"
    >
      {{ noticeMessage }}
    </p>

    <div class="knowledge-workspace-body">
      <section class="knowledge-workspace-card knowledge-catalog-card" aria-label="资料库列表">
        <div class="workspace-card-heading">
          <strong>资料库</strong>
          <span>选择管理对象，并设置对话检索范围</span>
        </div>

        <form class="knowledge-create-form" @submit.prevent="createBase">
          <input
            v-model="newBaseName"
            aria-label="新资料库名称"
            maxlength="80"
            placeholder="新建资料库"
          />
          <button type="submit" :disabled="!newBaseName.trim()">创建</button>
        </form>

        <div v-if="knowledgeBases.length" class="knowledge-base-list">
          <article
            v-for="base in knowledgeBases"
            :key="base.id"
            class="knowledge-base-item"
            :class="{ 'is-active': base.id === activeKnowledgeBaseId }"
          >
            <button class="knowledge-base-main" type="button" @click="$emit('select-base', base.id)">
              <span class="knowledge-base-title">
                <strong>{{ base.name }}</strong>
                <small v-if="base.isDefault">默认</small>
              </span>
              <span>
                {{ base.publishedDocumentCount }} 份已发布
                <template v-if="base.draftDocumentCount"> · {{ base.draftDocumentCount }} 份草稿</template>
              </span>
            </button>

            <div class="knowledge-base-actions">
              <label class="knowledge-scope-toggle" title="允许对话检索该资料库">
                <input
                  type="checkbox"
                  :checked="selectedKnowledgeBaseIds.includes(base.id)"
                  @change="toggleRetrieval(base.id, $event)"
                />
                <span>检索</span>
              </label>
              <button
                v-if="!base.isDefault"
                class="knowledge-base-delete"
                type="button"
                :aria-label="`删除资料库 ${base.name}`"
                title="删除资料库"
                @click="$emit('delete-base', base.id)"
              >
                删除
              </button>
            </div>
          </article>
        </div>
        <div v-else class="knowledge-empty knowledge-base-empty">
          <p>暂无资料库</p>
          <span>先创建一个资料库，再导入文档。</span>
        </div>
      </section>

      <section class="knowledge-workspace-card knowledge-document-card" aria-label="资料库文档">
        <template v-if="activeBase">
          <div class="knowledge-active-summary">
            <div>
              <span>当前管理</span>
              <strong>{{ activeBase.name }}</strong>
            </div>
            <span>{{ activeBase.publishedDocumentCount }} 份可检索 · {{ activeBase.draftDocumentCount }} 份草稿</span>
          </div>

          <template v-if="selectedPreview">
            <div class="knowledge-preview-header">
              <button class="inline-link" type="button" @click="$emit('close-preview')">← 返回文档列表</button>
              <div class="knowledge-document-title">
                <strong>{{ selectedPreview.document.name }}</strong>
                <span class="document-status" :class="`document-status-${selectedPreview.document.status}`">
                  {{ statusLabel(selectedPreview.document.status) }}
                </span>
                <span
                  class="document-status"
                  :class="`publication-status-${selectedPreview.document.publicationStatus}`"
                >
                  {{ publicationLabel(selectedPreview.document.publicationStatus) }}
                </span>
              </div>
              <p>
                {{ selectedPreview.preview.characterCount }} 个字符 ·
                {{ selectedPreview.preview.chunkCount }} 个分块
              </p>
            </div>

            <div class="knowledge-preview-actions">
              <button
                v-if="selectedPreview.document.publicationStatus === 'draft'"
                class="knowledge-primary-action"
                type="button"
                :disabled="selectedPreview.document.status !== 'ready' || isBusy(selectedPreview.document.id)"
                @click="$emit('publish', selectedPreview.document.id, selectedPreview.document.knowledgeBaseId)"
              >
                {{ selectedPreview.document.status === 'ready' ? '发布为可检索知识' : '等待处理完成' }}
              </button>
              <button
                v-else
                class="inline-link"
                type="button"
                :disabled="isBusy(selectedPreview.document.id)"
                @click="$emit('withdraw', selectedPreview.document.id, selectedPreview.document.knowledgeBaseId)"
              >
                撤回为草稿
              </button>
              <button
                class="inline-link danger-link"
                type="button"
                :disabled="isBusy(selectedPreview.document.id)"
                @click="$emit('remove', selectedPreview.document.id, selectedPreview.document.knowledgeBaseId)"
              >
                移除文档
              </button>
            </div>

            <section v-if="selectedPreview.preview.headings.length" class="knowledge-preview-headings">
              <strong>文档结构</strong>
              <ul>
                <li v-for="heading in selectedPreview.preview.headings" :key="heading">{{ heading }}</li>
              </ul>
            </section>

            <pre class="knowledge-preview-content">{{ selectedPreview.preview.excerpt || '暂无可预览内容' }}</pre>
            <p v-if="selectedPreview.preview.truncated" class="knowledge-preview-note">
              正文较长，此处仅展示前 12,000 个字符。
            </p>

          </template>

          <template v-else>
            <label class="upload-dropzone">
              <input
                accept=".md,.markdown,.txt,.json"
                multiple
                type="file"
                @change="handleFiles"
              />
              <strong>上传为知识草稿</strong>
              <span>将导入“{{ activeBase.name }}”并预索引；预览后发布才会进入 AI 检索。</span>
            </label>

            <div v-if="activeDocuments.length" class="knowledge-list">
              <article v-for="doc in activeDocuments" :key="doc.id" class="knowledge-item">
                <div class="knowledge-document-copy">
                  <div class="knowledge-document-title">
                    <strong>{{ doc.name }}</strong>
                    <span class="document-status" :class="`document-status-${doc.status}`">
                      {{ statusLabel(doc.status) }}
                    </span>
                    <span class="document-status" :class="`publication-status-${doc.publicationStatus}`">
                      {{ publicationLabel(doc.publicationStatus) }}
                    </span>
                  </div>
                  <p>{{ formatTime(doc.createdAt) }}</p>
                  <p v-if="doc.status === 'failed' && doc.error" class="knowledge-document-error">
                    {{ doc.error }}
                  </p>
                </div>
                <div class="knowledge-document-actions">
                  <button
                    class="inline-link"
                    type="button"
                    :disabled="isBusy(doc.id)"
                    @click="$emit('preview', doc.id, doc.knowledgeBaseId)"
                  >
                    预览
                  </button>
                  <button
                    v-if="doc.publicationStatus === 'draft' && doc.status === 'ready'"
                    class="inline-link"
                    type="button"
                    :disabled="isBusy(doc.id)"
                    @click="$emit('publish', doc.id, doc.knowledgeBaseId)"
                  >
                    发布
                  </button>
                  <button
                    v-else-if="doc.publicationStatus === 'published'"
                    class="inline-link"
                    type="button"
                    :disabled="isBusy(doc.id)"
                    @click="$emit('withdraw', doc.id, doc.knowledgeBaseId)"
                  >
                    撤回
                  </button>
                  <button
                    class="inline-link danger-link"
                    type="button"
                    :disabled="isBusy(doc.id)"
                    @click="$emit('remove', doc.id, doc.knowledgeBaseId)"
                  >
                    移除
                  </button>
                </div>
              </article>
            </div>
            <div v-else class="knowledge-empty">
              <p>该资料库暂无文档</p>
            </div>

            <button
              v-if="activeDocuments.length"
              class="clear-button"
              type="button"
              @click="$emit('clear', activeBase.id)"
            >
              清空当前资料库
            </button>
          </template>
        </template>

        <div v-else class="knowledge-empty">
          <p>选择一个资料库以管理文档</p>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeDocumentPreview,
  KnowledgeDocumentStatus,
  KnowledgePublicationStatus
} from '@/features/knowledge/types';

/**
 * KnowledgePanel 同时展示两个不同概念：
 * 1. activeKnowledgeBaseId：当前正在管理文档的单个知识库；
 * 2. selectedKnowledgeBaseIds：当前会话允许检索的多个知识库范围。
 *
 * “点击知识库”只改变管理视图，“检索”复选框才会改变聊天/RAG 范围。
 * 二者分离后，用户可以管理 A 库的文档，同时让当前会话检索 A+B 库。
 *
 * 组件本身不发请求：props 是 store 的只读投影，emits 由 App.vue 连到 store action。
 */
const props = defineProps<{
  knowledgeBases: KnowledgeBase[];
  activeKnowledgeBaseId: string | null;
  selectedKnowledgeBaseIds: string[];
  documents: KnowledgeDocument[];
  selectedPreview?: KnowledgeDocumentPreview | null;
  busyDocumentIds?: string[];
  errorMessage?: string;
  noticeMessage?: string;
}>();

// emit 中主动携带 knowledgeBaseId，避免异步操作期间用户切库后误伤新的 active 库。
const emit = defineEmits<{
  'create-base': [name: string];
  'select-base': [id: string];
  'toggle-retrieval': [id: string, selected: boolean];
  'delete-base': [id: string];
  upload: [files: FileList, knowledgeBaseId: string];
  remove: [id: string, knowledgeBaseId: string];
  clear: [knowledgeBaseId: string];
  preview: [id: string, knowledgeBaseId: string];
  'close-preview': [];
  publish: [id: string, knowledgeBaseId: string];
  withdraw: [id: string, knowledgeBaseId: string];
}>();

// 表单输入是组件局部源状态；只有提交后才通过 emit 进入全局 store。
const newBaseName = ref('');

// activeBase 和 activeDocuments 都是 props 的派生视图，不保存副本，从而避免列表更新后出现过期数据。
const activeBase = computed(() =>
  props.knowledgeBases.find((base) => base.id === props.activeKnowledgeBaseId)
);

const activeDocuments = computed(() =>
  props.documents.filter((document) => document.knowledgeBaseId === props.activeKnowledgeBaseId)
);

// 先在 UI 边界做 trim/空值防护，再上报意图；后端仍会独立验证名称。
function createBase() {
  const name = newBaseName.value.trim();
  if (!name) return;
  emit('create-base', name);
  newBaseName.value = '';
}

// DOM change 事件先转换成纯业务值 (id, selected)，父级不需了解 input 元素。
function toggleRetrieval(id: string, event: Event) {
  emit('toggle-retrieval', id, (event.target as HTMLInputElement).checked);
}

// 选择文件后立即带上当时的库 ID 上报，并清空 input，使同一文件之后仍可再次触发 change。
// 上传成功只表示后端“已接收”；queued/processing/ready/failed 的后续收敛由 store 轮询。
function handleFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.length && props.activeKnowledgeBaseId) {
    emit('upload', input.files, props.activeKnowledgeBaseId);
    input.value = '';
  }
}

function statusLabel(status: KnowledgeDocumentStatus) {
  const labels: Record<KnowledgeDocumentStatus, string> = {
    queued: '排队中',
    processing: '处理中',
    ready: '已就绪',
    failed: '失败'
  };
  return labels[status];
}

function publicationLabel(status: KnowledgePublicationStatus) {
  return status === 'published' ? '已发布' : '草稿';
}

function isBusy(id: string) {
  return props.busyDocumentIds?.includes(id) || false;
}

function formatTime(time: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(time);
}
</script>
