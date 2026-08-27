// API 客户端：token 存 localStorage，请求带 X-Sandbox-Token。
const TOKEN_KEY = 'mysandbox.token'

// 宿主哨兵 id：ContainerList 的 host 终端组用它当 containerId；文件 API 据此切宿主端点
// （两侧路由形状一一对应，FilePanel/FileEditorDialog 无需感知）。
export const HOST_ID = '__host__'
// 容器 / 宿主文件端点前缀。
const filesBase = (id: string) => (id === HOST_ID ? '/api/host-terminal' : `/api/containers/${id}`)

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t)
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export interface ContainerPort {
  ip?: string
  privatePort?: number
  publicPort?: number
  type: string
}
export interface ContainerView {
  id: string
  name: string
  displayName?: string
  status: string
  state: string
  image: string
  ip: string | null
  networks: string[]
  managed: boolean
  adopted: boolean
  description?: string
  tags?: string[]
  source?: string
  labels: Record<string, string>
  ports: ContainerPort[]
  created: number
  command: string
}

export class Unauthorized extends Error {}

// 带 status/code 的 API 错误（后端统一 {error:{code,message}} 结构）。
// 编辑器保存冲突（409）等场景靠它分流；仍是 Error 子类，旧 catch 逻辑不受影响。
export class ApiError extends Error {
  status: number
  code: string
  constructor(message: string, status: number, code: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(path, {
    ...init,
    // 10s 超时：后端挂死（TCP 半开不断连）时 fetch 会无限等待，UI 卡在「刷新中…」。
    // 普通请求都应在秒级返回；SSE 流式（streamBaseAction）不走这条路径，不受影响。
    signal: AbortSignal.timeout(10_000),
    headers: {
      'x-sandbox-token': getToken() ?? '',
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  })
  if (res.status === 401) throw new Unauthorized()
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(body?.error?.message || res.statusText, res.status, body?.error?.code || 'error')
  }
  return res.json()
}

// token 真伪校验：/api/health 不鉴权，任何 token 都 200，验不出错；这里走一个
// 必鉴权的轻量接口做实质校验。
export const verifyToken = () => api('/api/containers?limit=1') as Promise<{ items: ContainerView[] }>

// 引擎能力（后端 EngineCaps，见 server/engine/types.ts）。UI 差异一律判 caps，
// 不要判 engine 名——将来加引擎时才不用改前端。
export type BaseAction = 'export' | 'import' | 'clone'
export interface EngineCaps {
  dataInsideContainer: boolean // true：home 在容器内，删容器必连数据一起删
  liveRename: boolean // false：改名前必须先停容器
  portMappings: boolean // false：固定 IP 直连，无端口映射
  baseKind: 'image' | 'template' // 基座形态：模板容器（决定文案）
  baseActions: BaseAction[] // 可用动作（决定按钮）：clone/export/import
}
export interface Health {
  ok: boolean
  version: string
  engineStatus: { reachable: boolean; version?: string }
  engine: 'lxc'
  caps: EngineCaps
  services?: { available: boolean }
}
export const health = () => api('/api/health') as Promise<Health>
export const listContainers = () => api('/api/containers') as Promise<{ items: ContainerView[] }>

// POST 空 body 时不能带 content-type: application/json——Fastify 对「声明 JSON 却无 body」
// 的请求直接 400（FST_ERR_CTP_EMPTY_JSON_BODY），无参的 start/stop 会被挡掉。
async function postJson(path: string, body?: unknown): Promise<any> {
  return api(path, body ? { method: 'POST', body: JSON.stringify(body) } : { method: 'POST' })
}
async function patchJson(path: string, body: unknown): Promise<any> {
  return api(path, { method: 'PATCH', body: JSON.stringify(body) })
}

export const startContainer = (id: string) => postJson(`/api/containers/${id}/start`)
export const stopContainer = (id: string, t = 5) => postJson(`/api/containers/${id}/stop`, { t })
export const restartContainer = (id: string, t = 5) => postJson(`/api/containers/${id}/restart`, { t })
export const adoptContainer = (id: string, displayName?: string, source = 'external') =>
  postJson(`/api/containers/${id}/adopt`, { displayName, source })
export const renameContainer = (id: string, name: string) => postJson(`/api/containers/${id}/rename`, { name })
export const updateMeta = (id: string, patch: Record<string, unknown>) =>
  patchJson(`/api/containers/${id}/meta`, patch)

export interface CreateInput {
  name: string
  ip?: string
  gitName?: string
  gitEmail?: string
  role?: string
  description?: string
}
export const createContainer = (input: CreateInput) =>
  postJson('/api/containers', input) as Promise<{ id: string; name: string; ip: string }>

export const deleteContainer = (id: string, opts: { deleteData?: boolean; confirmName?: string } = {}) =>
  api(`/api/containers/${id}`, { method: 'DELETE', body: JSON.stringify(opts) }) as Promise<{ ok: true; dataRemoved: boolean; name: string }>

export interface IpPoolView {
  network: string
  pool: { from: string; to: string }
  reserved: string[]
  assigned: string[]
  free: string[]
}
export const getIpPool = () => api('/api/network/ips') as Promise<IpPoolView>

// —— 批量配置 ——
export interface BatchItemResult {
  id: string
  name: string
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  error?: string
}
export interface BatchResult {
  total: number
  ok: number
  failed: number
  items: BatchItemResult[]
}

export const batchGit = (ids: string[], name: string, email: string) =>
  postJson('/api/batch/git', { ids, name, email }) as Promise<BatchResult>
export const batchSshReseed = (ids: string[]) =>
  postJson('/api/batch/ssh', { ids, mode: 'reseed' }) as Promise<BatchResult>
export const batchSshAppendKey = (ids: string[], key: string) =>
  postJson('/api/batch/ssh', { ids, mode: 'append-key', key }) as Promise<BatchResult>
export const batchClaude = (ids: string[], prompt: string, timeoutMs?: number) =>
  postJson('/api/batch/claude', { prompt, ids, timeoutMs }) as Promise<BatchResult>
export const batchExec = (ids: string[], command: string, timeoutMs?: number) =>
  postJson('/api/batch/exec', { ids, command, timeoutMs }) as Promise<BatchResult>

// —— AI 网关批量配置（rootfs 直写，容器无需在跑）——
// claude 固定 Anthropic；codex 固定 OpenAI Responses（官方已停 chat completions）；
// opencode/pi 的 wire 是多选数组——每个选中的协议注册一个独立 provider 变体
// （myapikey-chat / -responses / -anthropic），工具内按 <变体>/<模型> 切换。
export type GatewayWire = 'openai-chat' | 'openai-responses' | 'anthropic-messages'
export interface AiGatewayInput {
  endpoints: {
    openai?: { baseUrl: string }
    anthropic?: { baseUrl: string }
  }
  apiKey: string
  tools: { claude: boolean; codex: boolean; opencode: boolean; pi: boolean }
  wire?: {
    opencode?: GatewayWire[]
    pi?: GatewayWire[]
  }
  models?: string[]
  setDefault?: boolean
}
export interface AiGatewayState extends AiGatewayInput {
  updatedAt: string
}
export const getAiGateway = () =>
  api('/api/batch/ai-config') as Promise<{ config: AiGatewayState | null }>
export const batchAiConfig = (ids: string[], input: AiGatewayInput) =>
  postJson('/api/batch/ai-config', { ids, ...input }) as Promise<BatchResult>

// —— 宿主终端 ——
// 会话活跃 pane 的 cwd（信息条显示「宿主 · <镜像目录>」用；轮询）。
// 复用 getTermCwd：HOST_ID 哨兵会落到 /api/host-terminal/cwd（文件 API 端点切换同源）。
export const getHostCwd = (termId: string) => getTermCwd(HOST_ID, termId)
// —— 基座（模板容器）——
// 后端 BaseStatus（server/engine/types.ts）。
export interface BaseStatus {
  kind: 'image' | 'template'
  name: string
  exists: boolean
  // 能否直接建容器。LXC 模板在运行时 exists 但 !ready
  ready: boolean
  notReady?: string
  // 制作来源：模板制作脚本路径
  context?: string | null
  contextError?: string
  size?: number
  createdAt?: string
  // 引擎特有展示项（state/rootfs/source），原样列出
  detail?: Record<string, string>
}
export const getBaseStatus = () => api('/api/base') as Promise<BaseStatus>
// 体积单独取：LXC 下要遍历整个 rootfs（秒级），不能塞进被轮询的 status
export const getBaseSize = () => api('/api/base/size') as Promise<{ size: number | null }>

// SSE 事件：progress（流式进度）/ done（完成，带 result）/ error（失败，带 message）
export interface BaseProgressEvent {
  type: 'progress' | 'done' | 'error'
  stream?: string
  status?: string
  id?: string
  progress?: string
  // 各动作的返回值不同（export: path/size；clone/import: template）
  result?: Record<string, string | number>
  message?: string
}

// 基座动作的输入。后端 BaseActionOpts，未知字段忽略。
export interface BaseActionOpts {
  tag?: string
  ref?: string
  path?: string
  from?: string
  noCache?: boolean
  force?: boolean
}

// 读 SSE 流：fetch POST → 逐块 decode → 按 \n\n 分帧 → 解析 data: 行 → onEvent。
// 服务端发 error 帧时，先把事件交给 onEvent（用于落日志），读完流后抛错让调用方报错。
// 泛型实现（streamOp）：基座动作与服务创建共用同一协议。
export async function streamOp(
  path: string,
  body: unknown,
  onEvent: (e: BaseProgressEvent) => void,
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'x-sandbox-token': getToken() ?? '',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (res.status === 401) throw new Unauthorized()
  if (!res.ok || !res.body) throw new Error(`${path} failed: ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let lastErr: string | null = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const data = frame.startsWith('data: ') ? frame.slice(6) : frame
      if (!data) continue
      let evt: BaseProgressEvent
      try {
        evt = JSON.parse(data)
      } catch {
        continue
      }
      onEvent(evt)
      if (evt.type === 'error') lastErr = evt.message || `${path} failed`
    }
  }
  if (lastErr) throw new Error(lastErr)
}

export async function streamBaseAction(
  action: string,
  opts: BaseActionOpts,
  onEvent: (e: BaseProgressEvent) => void,
): Promise<void> {
  await streamOp(`/api/base/${action}`, opts, onEvent)
}

// —— docker 服务层 ——

export interface ServiceView {
  name: string
  preset: string
  image: string
  ip: string | null
  state: string
  status: string
  running: boolean
  volume: string | null
  ports: number[]
  envKeys: string[]
  description?: string
  createdAt?: string
  command?: string[]
  metaMissing?: boolean
}

export interface ServicesStatus {
  enabled: boolean
  reachable: boolean
  version?: string
  error?: string
  network: { name: string; bridgeOk: boolean; subnet: string | null; detail?: string }
  pool: { from: string; to: string; reserved: string[]; assigned: string[]; free: string[] }
}

export interface ServicePresetView {
  key: string
  label: string
  image: string
  description: string
  volumePath: string | null
  ports: number[]
  fixedEnv: Record<string, string>
  userEnv: { key: string; label: string; required?: boolean; secret?: boolean }[]
  command?: string[]
  hint: string
}

export interface CreateServiceInput {
  name: string
  preset: string
  image?: string
  env?: Record<string, string>
  command?: string
  ip?: string
  description?: string
}

export const listServices = () =>
  api('/api/services') as Promise<{ items: ServiceView[]; status: ServicesStatus }>
export const getServicePresets = () =>
  api('/api/services/presets') as Promise<{ presets: ServicePresetView[] }>
export const startService = (name: string) => postJson(`/api/services/${name}/start`)
export const stopService = (name: string) => postJson(`/api/services/${name}/stop`)
export const restartService = (name: string) => postJson(`/api/services/${name}/restart`)
export const deleteService = (name: string, opts: { deleteData?: boolean; confirmName?: string }) =>
  api(`/api/services/${name}`, { method: 'DELETE', body: JSON.stringify(opts) })
export const getServiceLogs = (name: string, tail = 200) =>
  api(`/api/services/${name}/logs?tail=${tail}`) as Promise<{ logs: string }>
export const streamCreateService = (input: CreateServiceInput, onEvent: (e: BaseProgressEvent) => void) =>
  streamOp('/api/services', input, onEvent)

// —— 全局 hosts 配置 ——
export interface HostsView {
  content: string
  isCustom: boolean
  isHostDefault: boolean
  hostError?: string
}
export const getHosts = () => api('/api/hosts') as Promise<HostsView>
export const getHostHosts = () =>
  api('/api/hosts/host') as Promise<{ content: string; error?: string }>
// hosts 应用结果：比通用 BatchResult 多 skipped（hash 命中跳过的容器数）
export type HostsApplyResult = BatchResult & { skipped: number }
// 保存即生效：PUT 写入侧车并立即应用到所有运行中容器（空内容 applied=null，不动容器）
export const putHosts = (content: string) =>
  api('/api/hosts', { method: 'PUT', body: JSON.stringify({ content }) }) as Promise<{
    ok: true
    applied: HostsApplyResult | null
  }>
export const applyHosts = (content: string, ids?: string[]) =>
  postJson('/api/hosts/apply', { content, ids }) as Promise<HostsApplyResult>

// —— 容器文件浏览/编辑 ——
export interface FileEntry {
  name: string
  type: 'dir' | 'file' | 'link'
  size: number
  mtime: number
}
export interface FilesView {
  path: string
  parent: string | null
  entries: FileEntry[]
}
export interface FileView {
  path: string
  name: string
  size: number
  mtime: number
  binary: boolean
  content?: string
}
export const listFiles = (id: string, path: string) =>
  api(`${filesBase(id)}/files?path=${encodeURIComponent(path)}`) as Promise<FilesView>
export const readFile = (id: string, path: string) =>
  api(`${filesBase(id)}/file?path=${encodeURIComponent(path)}`) as Promise<FileView>
export const writeFile = (id: string, path: string, content: string, baseMtime?: number) =>
  api(`${filesBase(id)}/file`, {
    method: 'PUT',
    body: JSON.stringify({ path, content, baseMtime }),
  }) as Promise<{ ok: true; mtime?: number }>
export const getTermCwd = (id: string, termId: string) =>
  api(`${filesBase(id)}/cwd?termId=${encodeURIComponent(termId)}`) as Promise<{ cwd: string }>
export const createEntry = (id: string, path: string, type: 'file' | 'dir') =>
  postJson(`${filesBase(id)}/fs/create`, { path, type }) as Promise<{ ok: true }>
export const renameEntry = (id: string, path: string, name: string) =>
  postJson(`${filesBase(id)}/fs/rename`, { path, name }) as Promise<{ ok: true; to: string }>
export const deleteEntry = (id: string, path: string) =>
  postJson(`${filesBase(id)}/fs/delete`, { path }) as Promise<{ ok: true }>
export const getListenPorts = (id: string) =>
  // ports：全部监听端口；web：其中实测返回 HTML 的（真网页，可放心点击打开）
  api(`/api/containers/${id}/listen`) as Promise<{ ports: number[]; web: number[] }>
