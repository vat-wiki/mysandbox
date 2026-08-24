// 引擎能力的全局单例。来源是 /api/health，由 App.vue 拉一次写进来，其余组件只读。
//
// 为什么不用 props 逐层传：caps 是「整个应用运行在什么引擎上」的环境事实，不是某个
// 组件的输入；ContainerList → ContainerCard → DeleteContainerDialog 三层传下去纯噪音。
// 保守默认（docker 语义）：health 还没回来时按老行为渲染，不会先给用户看到 LXC 文案再跳回去。
import { ref, reactive, readonly } from 'vue'
import type { EngineCaps } from './api'

const DEFAULTS: EngineCaps = {
  dataInsideContainer: false,
  liveRename: true,
  portMappings: true,
}

// reactive 而非 ref：消费方写 `caps.portMappings` 而不是 `caps.value.portMappings`，
// 模板里少一层、脚本里也不会漏 .value。
const capsState = reactive<EngineCaps>({ ...DEFAULTS })
const engineRef = ref<'docker' | 'lxc'>('docker')

export const caps = readonly(capsState)
export const engineName = readonly(engineRef)

export function setEngineInfo(engine: 'docker' | 'lxc', c: EngineCaps): void {
  engineRef.value = engine
  Object.assign(capsState, DEFAULTS, c)
}
