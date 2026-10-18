import { computed } from 'vue'
import { useRoute, useRouter, type RouteRecordName } from 'vue-router'
import { isPhone } from './useDevice'

// 全屏导航页的统一打开/关闭语义：打开只发生在手机形态；关闭优先回退到打开前的历史
// 记录（保留系统后退/前进方向），直接深链进入时回工作区，避免把用户送出站点。
export function usePageRoute(name: RouteRecordName) {
  const route = useRoute()
  const router = useRouter()

  const isOpen = computed({
    get: () => isPhone.value && route.name === name,
    set: (value: boolean) => (value ? openPage() : closePage()),
  })

  function openPage() {
    if (!isPhone.value || route.name === name) return
    void router.push({ name })
  }

  function closePage() {
    if (route.name !== name) return
    if (typeof history.state?.back === 'string') void router.back()
    else void router.replace({ name: 'workspace' })
  }

  return { isOpen, openPage, closePage }
}
