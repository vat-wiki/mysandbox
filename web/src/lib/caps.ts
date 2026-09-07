// 引擎能力的全局单例。来源是 /api/health，由 App.vue 拉一次写进来，其余组件只读。
//
// 为什么不用 props 逐层传：caps 是「整个应用运行在什么引擎上」的环境事实，不是某个
// 组件的输入；ContainerList → ContainerCard → DeleteContainerDialog 三层传下去纯噪音。
// 默认值取 LXC 语义：health 还没回来时也按真实引擎渲染。
import { ref, reactive, readonly, computed } from 'vue'
import type { BaseAction, EngineCaps } from './api'

const DEFAULTS: EngineCaps = {
  dataInsideContainer: true,
  liveRename: false,
  portMappings: false,
  baseKind: 'template',
  baseActions: ['create', 'clone', 'export', 'import'] as BaseAction[],
}

// reactive 而非 ref：消费方写 `caps.portMappings` 而不是 `caps.value.portMappings`，
// 模板里少一层、脚本里也不会漏 .value。
const capsState = reactive<EngineCaps>({ ...DEFAULTS })
const engineRef = ref<'lxc'>('lxc')

export const caps = readonly(capsState)
export const engineName = readonly(engineRef)

// 基座文案：模板容器（新建容器的来源物）。集中在这里而不是各组件里判 baseKind。
export const baseLabel = computed(() => (capsState.baseKind === 'template' ? '模板' : '镜像'))
export function hasBaseAction(a: BaseAction): boolean {
  return capsState.baseActions.includes(a)
}

export function setEngineInfo(engine: 'lxc', c: EngineCaps): void {
  engineRef.value = engine
  Object.assign(capsState, DEFAULTS, c)
}
