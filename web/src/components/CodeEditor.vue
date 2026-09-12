<script setup lang="ts">
// Monaco 编辑器壳组件：FileEditorPane / BatchDialog 共用。
// 固化深色主题与选项基线（外层用 class 控高度/边框），内部拦截 Ctrl/Cmd+S
// 转成 save 事件，消费方不必再拿 editor 实例注册命令。
// 懒加载由消费方决定：defineAsyncComponent(() => import('@/components/CodeEditor.vue'))，
// monaco 本体是共享 chunk，多个入口不会重复下载。
import { computed } from 'vue'
import type { HTMLAttributes } from 'vue'
import { VueMonacoEditor } from '@guolao/vue-monaco-editor'
import '@/lib/monaco' // 副作用：离线 Monaco + 语言注册（必须在组件渲染前执行）
import { monaco } from '@/lib/monaco'
import { cn } from '@/lib/utils'

const props = withDefaults(
  defineProps<{
    modelValue: string
    language?: string
    /** 浅合并覆盖基线选项（如 placeholder / lineNumbers） */
    options?: Record<string, unknown>
    class?: HTMLAttributes['class']
  }>(),
  { language: 'plaintext' },
)

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'save'): void
  (e: 'mount', editor: unknown): void
}>()

// 选项基线 + 消费方覆盖。无 minimap、等宽 12px、自动换行、禁用回环。
// folding 恒显（Monaco 默认 hover 才出箭头，小屏上等于没有）；
// automaticLayout 让容器尺寸变化（窗口/消费方形态切换）时自动重排。
const editorOptions = computed(() => ({
  minimap: { enabled: false },
  fontSize: 12,
  fontFamily: 'var(--font-mono), ui-monospace, monospace',
  lineNumbers: 'on',
  wordWrap: 'on',
  folding: true,
  showFoldingControls: 'always',
  automaticLayout: true,
  scrollBeyondLastLine: false,
  renderLineHighlight: 'line',
  tabSize: 2,
  padding: { top: 8, bottom: 8 },
  smoothScrolling: true,
  ...props.options,
}))

// Ctrl/Cmd+S：编辑器聚焦时拦截为 save 事件（不触发浏览器默认保存行为）。
function onMount(editor: unknown) {
  ;(editor as import('monaco-editor').editor.IStandaloneCodeEditor).addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
    () => emit('save'),
  )
  emit('mount', editor)
}
</script>

<template>
  <div :class="cn('overflow-hidden bg-zinc-900', props.class)">
    <VueMonacoEditor
      :value="modelValue"
      :language="language"
      theme="vs-dark"
      :options="editorOptions"
      @mount="onMount"
      @update:value="(v: string | undefined) => emit('update:modelValue', v ?? '')"
    />
  </div>
</template>
