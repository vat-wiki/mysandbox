// code-server 打开共享逻辑：容器右键菜单与文件面板按钮共用。
// ensure（缺装装、没起起，进度进 toast）→ 就绪后按端口点击同款口径开新标签页
// （serviceUrl：代理/直连跟随控制台）。folder 传入时作为工作区目录（code-server
// 的 ?folder= query，代理/直连两种口径下都原样透传到 code-server）。
import { toast } from 'vue-sonner'
import { ensureCodeServer, CODE_SERVER_PORT } from './api'
import { serviceUrl } from './proxy'

export function openCodeServer(opts: {
  id: string
  name: string
  ip?: string | null
  folder?: string | null
}): void {
  const title = `code-server · ${opts.name}`
  const tid = toast.loading(title, { description: '检查中…', duration: Infinity })
  void ensureCodeServer(opts.id, (e) => {
    if (e.type === 'progress' && e.status) {
      toast.loading(title, { id: tid, description: e.status })
    }
  })
    .then((r) => {
      toast.success('code-server 已就绪，新标签页打开', { id: tid, duration: 4000 })
      let url = serviceUrl('c', r.name || opts.name, CODE_SERVER_PORT, r.ip || opts.ip || null)
      if (opts.folder) url += `?folder=${encodeURIComponent(opts.folder)}`
      window.open(url, '_blank', 'noopener')
    })
    .catch((e: unknown) => {
      toast.error('code-server 启动失败', {
        id: tid,
        description: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        duration: 10_000,
      })
    })
}
