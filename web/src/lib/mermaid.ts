// —— mermaid 懒加载渲染控制（FileEditorPane 的 md 预览用，跨面板实例共享）——
// mermaid 依赖体积大（core 650KB+，每种图型各一个 chunk），首用才动态下载，不进首屏。
// 两个不能在组件实例里做的事：① diagram 的 db/parser/renderer 是 mermaid 内部按图型
// 共享的单例，并发 parse/run 无保护——多个 md tab 同时 hydrate（恢复 tab 全量重挂）会
// 互踩，整条管线必须串行；② 失败重试与 mermaid-bad 判定要跨实例一致。
// 重试是命门：冷缓存首拍撞网络抖动（本机实测会发生）时 import 拒绝 / parse 返回 false /
// run 出不来 svg，一失败就定罪的话 mdHtml 不会再变、没有第二拍，图表永远停在源码，
// 只能关 tab 重开或刷新（＝「第一打开没有预览，第二次才有」）。退避重试两拍后仍出不来
// 的块才标 mermaid-bad（保留源码红框，编辑场景里裸源码更好改；mermaid 默认把坏图画成
// 「Syntax error in text」弹图，suppressErrorRendering 压掉）。
// 注意天花板：mermaid core 本体或图型 chunk 的模块级硬失败（404/网络层失败）在页面内
// 无法重试——spec 把失败的模块 fetch 记进 module map，同 realm 重复 import 恒败；那种
// 只能靠换树重挂/刷新兜底，红框如实保留。
let api: typeof import('mermaid')['default'] | null = null
let tail: Promise<void> = Promise.resolve()

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function loadApi(): Promise<typeof import('mermaid')['default'] | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const m = await import('mermaid')
      m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', suppressErrorRendering: true }) // 应用恒暗色
      return m.default
    } catch {
      if (attempt === 2) return null // 放弃：占位块保持源码，下次内容变化/重挂自然再试
      await sleep(500 * (attempt + 1))
    }
  }
  return null
}

/**
 * 把 pre.mermaid 占位块渲染成 SVG（原地替换）。串行排队执行，多实例并发调用安全。
 * @param nodes 占位块集合（须已从 DOM 收集、未带 data-processed）
 * @param cancelled 逐拍检查的作废钩子：内容换代（v-html 整树换新）后旧任务不再渲染，
 *        立刻让位给新一轮，别让作废工作占着串行队列拖慢活树
 */
export function hydrateMermaid(nodes: HTMLElement[], cancelled: () => boolean = () => false): Promise<void> {
  if (!nodes.length) return Promise.resolve()
  const task = tail.then(async () => {
    if (cancelled()) return
    if (!api) api = await loadApi()
    if (!api || cancelled()) return
    // 逐轮 parse 过滤 + run 渲染，每轮只追未出图的块。parse 的 false 与 run 的无 svg
    // 都可能是 chunk 首取抖动（与真语法错误不可区分），重试两拍自愈；mermaid-bad 逐轮
    // 重标，抖动自愈时红框自动消失。run 成功与否用 svg 实测（suppressErrors 下错误被吞）。
    let pending = nodes
    for (let round = 0; round < 3 && pending.length; round++) {
      if (round) {
        await sleep(600 * round)
        if (cancelled()) return
      }
      const failed: HTMLElement[] = []
      const runnable: HTMLElement[] = []
      for (const node of pending) {
        if (cancelled()) return
        let bad: boolean
        try {
          bad = (await api.parse(node.textContent ?? '', { suppressErrors: true })) === false
        } catch {
          bad = true // parse 内部错误（含图型模块加载失败）按未出图处理，交给下一轮
        }
        node.classList.toggle('mermaid-bad', bad)
        if (bad) failed.push(node)
        else runnable.push(node)
      }
      if (cancelled()) return
      if (runnable.length) {
        await api.run({ nodes: runnable, suppressErrors: true }).catch(() => {})
        for (const n of runnable) {
          if (cancelled()) return
          if (!n.querySelector('svg')) {
            // mermaid 的 run 在渲染前就写 data-processed，失败块摘掉才能进下一轮/下次 hydrate
            n.removeAttribute('data-processed')
            failed.push(n)
          }
        }
      }
      pending = failed
    }
    for (const n of pending) n.classList.add('mermaid-bad')
  })
  tail = task.catch(() => {}) // 链条不能断：单轮失败不影响后续排队的渲染
  return task
}
