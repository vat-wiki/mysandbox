<script setup lang="ts">
// Monaco diff 对比编辑器壳（CodeEditor 的兄弟件）：git 变更面板「点变更文件看对比」用。
// 只读快照语义——两侧都不可编辑，无 save 事件。model URI 用虚拟前缀（head:// work://）
// 与普通编辑器/同路径复用隔离：wrapper 的 getOrCreateModel 按全局 URI 复用模型，
// 若与普通编辑器或彼此撞 URI，先开的 model 会被后开的复用导致内容错乱。
// 懒加载由消费方决定（defineAsyncComponent），monaco 本体是共享 chunk。
import { computed } from 'vue'
import type { HTMLAttributes } from 'vue'
import { VueMonacoDiffEditor } from '@guolao/vue-monaco-editor'
import '@/lib/monaco' // 副作用：离线 Monaco + 语言注册（必须在组件渲染前执行）

const props = defineProps<{
  original: string
  modified: string
  language?: string
  originalPath?: string
  modifiedPath?: string
  class?: HTMLAttributes['class']
}>()

// 选项基线：只读、并排视图、无 minimap——与 CodeEditor 的观感基线对齐。
const diffOptions = computed(() => ({
  readOnly: true,
  originalEditable: false,
  renderSideBySide: true,
  minimap: { enabled: false },
  fontSize: 12,
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  scrollBeyondLastLine: false,
  renderOverviewRuler: false,
  diffWordWrap: 'off',
  ignoreTrimWhitespace: false,
  padding: { top: 8, bottom: 8 },
}))
</script>

<template>
  <div :class="props.class" class="overflow-hidden bg-zinc-900">
    <VueMonacoDiffEditor
      :original="props.original"
      :modified="props.modified"
      :language="props.language ?? 'plaintext'"
      :original-model-path="`head://${props.originalPath ?? 'original'}`"
      :modified-model-path="`work://${props.modifiedPath ?? 'modified'}`"
      theme="vs-dark"
      :options="diffOptions"
      class="h-full w-full"
    />
  </div>
</template>
