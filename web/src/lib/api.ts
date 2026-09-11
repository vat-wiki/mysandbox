// API 客户端：token 存 localStorage，请求带 X-Sandbox-Token。
import { PREVIEW_MAX_BYTES } from './preview'

const TOKEN_KEY = 'mysandbox.token'

// 宿主哨兵 id：ContainerList 的 host 终端组用它当 containerId；文件 API 据此切宿主端点
// （两侧路由形状一一对应，FilePanel/FileEditorPane 无需感知）。
export const HOST_ID = '__host__'
// SSH 终端组的 containerId 前缀（同 HOST_ID 哨兵思路）：组 containerId = 'ssh:'+目标名。
// 前缀隔离与容器名的撞名面（目标名可自由起，容器名来自 docker/LXC）；WS/会话 key 在
// 边界处剥前缀用真名。与 SVC_FILE_PREFIX 的差异：SSH 组**没有**文件端点，前缀全程
// 身份用，不进 filesBase。
export const SSH_ID_PREFIX = 'ssh:'
export const sshGroupId = (name: string): string => SSH_ID_PREFIX + name
export const sshTargetName = (id: string): string => id.slice(SSH_ID_PREFIX.length)
// 服务文件端点哨兵前缀：服务终端组（kind='service'）的文件目标 id = 's:'+服务名，
// filesBase 据此切 /api/services/<name>/*（后端 server/serviceFiles.ts）。约定与
// termSessionKey 的 's:' 前缀同源。与 HOST_ID 的差异：服务组的 containerId 本体是真名
// （WS /卡片/会话 key 都用它），只有**文件目标**在边界处（ContainerList/TermLayoutNode）
// 加前缀，进了 FilePanel/编辑器/复制粘贴后全程透传无需感知。
export const SVC_FILE_PREFIX = 's:'
export const serviceFileId = (id: string): string => SVC_FILE_PREFIX + id
export const isServiceFileId = (id: string): boolean => id.startsWith(SVC_FILE_PREFIX)
// 容器 / 宿主 / 服务文件端点前缀。
const filesBase = (id: string) =>
  id === HOST_ID
    ? '/api/host-terminal'
    : id.startsWith(SVC_FILE_PREFIX)
      ? `/api/services/${id.slice(SVC_FILE_PREFIX.length)}`
      : `/api/containers/${id}`

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
    // 10s 超时默认：后端挂死（TCP 半开不断连）时 fetch 会无限等待，UI 卡在「刷新中…」。
    // 普通请求都应在秒级返回；SSE 流式（streamBaseAction）不走这条路径，不受影响。
    // 耗时请求（跨面板复制等）可通过 init.signal 传入更宽的超时覆盖默认值。
    signal: init.signal ?? AbortSignal.timeout(10_000),
    headers: {
      'x-sandbox-token': getToken() ?? '',
      // content-type 只在有 body 时带：无 body 的请求（GET、无参 POST）带 JSON
      // content-type 会被 Fastify 拒收（FST_ERR_CTP_EMPTY_JSON_BODY）。
      ...(init.body ? { 'content-type': 'application/json' } : {}),
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
export type BaseAction = 'create' | 'export' | 'import' | 'clone'
export interface EngineCaps {
  dataInsideContainer: boolean // true：home 在容器内，删容器必连数据一起删
  liveRename: boolean // false：改名前必须先停容器
  portMappings: boolean // false：固定 IP 直连，无端口映射
  baseKind: 'image' | 'template' // 基座形态：模板容器（决定文案）
  baseActions: BaseAction[] // 可用动作（决定按钮）：create/clone/export/import
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

// —— Web 代理（server/proxy.ts）——
// vhost 门面基域名信息 + 会话 cookie 下发。URL 拼装在 lib/proxy.ts（单例）。
export interface ProxyBaseInfo {
  base: string
  // local = 固定本地域 mysandbox.test（需宿主侧 DNS 应答）；lan/tailscale = sslip 兜底
  kind: 'custom' | 'local' | 'lan' | 'tailscale'
}
export interface ProxyConfigInfo {
  mode: 'vhost' | 'subpath'
  bases: ProxyBaseInfo[]
  primary: string | null
}
export const getProxyConfig = () => api('/api/proxy/config') as Promise<ProxyConfigInfo>
// 登录后种会话 cookie（vhost 门面的页面路径任意，Path=/；仅在 /proxy 被承认）：
// 浏览器直接导航到代理 URL 带不上 X-Sandbox-Token header，cookie 是鉴权凭证。
export const startAuthSession = () => postJson('/api/auth/session')

// POST 空 body 时不能带 content-type: application/json——Fastify 对「声明 JSON 却无 body」
// 的请求直接 400（FST_ERR_CTP_EMPTY_JSON_BODY），无参的 start/stop 会被挡掉。
async function postJson(path: string, body?: unknown, timeoutMs?: number): Promise<any> {
  return api(path, {
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : { method: 'POST' }),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  })
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
  // /etc/hosts 来源：template = 继承所选来源 rootfs 的 hosts（缺省）；host = 宿主 /etc/hosts
  hosts?: 'template' | 'host'
  // 建容器的来源：缺省 = 模板；container = 克隆现有容器（在跑会先停）；
  // archive = 从 tar.zst 包解包
  source?: { kind: 'container'; name: string } | { kind: 'archive'; path: string }
}
export interface CreateResult {
  id: string
  name: string
  ip: string
}
// 建容器走 SSE（克隆/解包 + 启动分钟级，10s 超时的 api() 路径撑不住）。
// done 帧的 result = {id,name,ip}；错误走 error 帧，由 streamOp 抛出。
export async function streamCreateContainer(
  input: CreateInput,
  onEvent: (e: BaseProgressEvent) => void,
): Promise<void> {
  await streamOp('/api/containers', input, onEvent)
}

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

// —— 终端会话（跨窗口/浏览器找回 tmux 会话）——
// 后端 TermSessionView（server/terminal.ts）。cwd = 会话活跃 pane 当前目录（识别用）；
// title = pane 动态标题（命令行/空闲路径/CC·opencode 任务标题，比 cwd 更好认）。
export interface TermSessionView {
  kind: 'host' | 'container' | 'service' | 'ssh'
  containerId?: string // container=容器 id；service=服务名；ssh=SSH 目标名（web 侧解析显示名/颜色）
  termId: string
  attached: number
  created: number
  cwd?: string
  title?: string
}
// 会话去重 key：ContainerList 算「本窗口已占用」（可见 + 隐藏组的全部叶子）、
// TermSessionsDialog 过滤远端列表，两处必须同构，收拢在这里。
export function termSessionKey(
  kind: 'host' | 'container' | 'service' | 'ssh',
  containerId: string | undefined,
  termId: string,
): string {
  return kind === 'host'
    ? `host:${termId}`
    : kind === 'service'
      ? `s:${containerId}:${termId}`
      : kind === 'ssh'
        ? `x:${containerId}:${termId}`
        : `c:${containerId}:${termId}`
}
export const listTermSessions = () =>
  api('/api/terminal-sessions') as Promise<{ sessions: TermSessionView[] }>
export const killTermSession = (s: TermSessionView) =>
  api(
    s.kind === 'host'
      ? `/api/terminal-sessions/host/${encodeURIComponent(s.termId)}`
      : s.kind === 'service'
        ? `/api/terminal-sessions/service/${encodeURIComponent(s.termId)}`
        : s.kind === 'ssh'
          ? `/api/terminal-sessions/ssh/${encodeURIComponent(s.containerId ?? '')}/${encodeURIComponent(s.termId)}`
          : `/api/terminal-sessions/container/${encodeURIComponent(s.containerId ?? '')}/${encodeURIComponent(s.termId)}`,
    { method: 'DELETE' },
  ) as Promise<{ ok: true }>

// —— SSH 终端目标（server/sshTerminal.ts；存 sidecar，UI 可增删）——
export interface SshTargetView {
  name: string
  host: string // ssh 目的地：host / user@host / ~/.ssh/config 别名（凭据全走宿主 ssh）
  user?: string
  port?: number
  createdAt?: string
}
export interface SshConfigHost {
  name: string
  host?: string
  user?: string
  port?: number
}
export const listSshTargets = () => api('/api/ssh/targets') as Promise<{ targets: SshTargetView[] }>
export const addSshTarget = (t: { name: string; host: string; user?: string; port?: number }) =>
  api('/api/ssh/targets', { method: 'POST', body: JSON.stringify(t) }) as Promise<{ ok: true; target: SshTargetView }>
export const deleteSshTarget = (name: string) =>
  api(`/api/ssh/targets/${encodeURIComponent(name)}`, { method: 'DELETE' }) as Promise<{ ok: true }>
export const listSshConfigHosts = () =>
  api('/api/ssh/config-hosts') as Promise<{ hosts: SshConfigHost[] }>

// —— 终端输出活动（「无输出提醒」）——
// 后端 TermActivityView（server/activity.ts）：服务端周期扫 tmux 尾部输出，
// state=quiet 表示出现过输出且已安静超过 threshold 秒。「谁在看着」服务端不知道
// （可见 tab v-show 常驻，tmux attached ≠ 用户在看），由前端自己关联激活 tab。
export interface TermActivityView {
  kind: 'host' | 'container'
  containerId?: string
  termId: string
  state: 'active' | 'quiet'
  quietSeconds: number
}
export const listTermActivity = () =>
  api('/api/terminal-activity') as Promise<{ threshold: number; items: TermActivityView[] }>
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
  env: Record<string, string>
  connect: string[]
  displayName?: string
  description?: string
  createdAt?: string
  command?: string[]
  metaMissing?: boolean
  adopted?: boolean // 收编的外部容器：无删除/改配置，只可取消收编（接管式收编完成后转正，此标志清位）
  hasCompose?: boolean // compose 底账在（可改配置可应用）；managed 而无文件 = 旧版创建 → 迁移入口
  container?: string // 实际容器名（目录注册表服务 compose 项目名 ≠ 容器名时不同）
}

export interface ServicesStatus {
  enabled: boolean
  reachable: boolean
  version?: string
  error?: string
  network: { name: string; bridgeOk: boolean; subnet: string | null; detail?: string }
  pool: { from: string; to: string; reserved: string[]; assigned: string[]; free: string[] }
  // undefined = 探测失败省略；[] = daemon 未配 registry-mirrors（直连 Docker Hub）
  registryMirrors?: string[]
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
  volumePath?: string // custom 可选：数据卷挂载路径（留空不建卷）
  env?: Record<string, string>
  command?: string
  ip?: string
  description?: string
}

export const listServices = () =>
  api('/api/services') as Promise<{ items: ServiceView[]; status: ServicesStatus }>
export const getServicePresets = () =>
  api('/api/services/presets') as Promise<{ presets: ServicePresetView[] }>
// 宿主已有镜像（创建对话框「自定义镜像」的候选下拉）；失败/daemon 不可达 = 空列表。
export interface DockerImageRef {
  ref: string
  repository: string
  tag: string
  size: string
  createdSince: string
}
export const listDockerImages = () =>
  api('/api/services/images') as Promise<{ images: DockerImageRef[] }>
export const startService = (name: string) => postJson(`/api/services/${name}/start`)
export const stopService = (name: string) => postJson(`/api/services/${name}/stop`)
export const restartService = (name: string) => postJson(`/api/services/${name}/restart`)
// 元数据（显示名）：与容器 updateMeta 同语义——改 sidecar，不动容器真名
export const updateServiceMeta = (name: string, patch: { displayName?: string }) =>
  api(`/api/services/${name}/meta`, { method: 'PATCH', body: JSON.stringify(patch) })
export const deleteService = (name: string, opts: { deleteData?: boolean; confirmName?: string }) =>
  api(`/api/services/${name}`, { method: 'DELETE', body: JSON.stringify(opts) })
export const getServiceLogs = (name: string, tail = 200) =>
  api(`/api/services/${name}/logs?tail=${tail}`) as Promise<{ logs: string }>
// 监听端口（实测）：对齐容器的 /api/containers/:id/listen。ports = 容器内 LISTEN
// 端口（回环监听已剔除），web = 其中实测返回 HTML 的（可点开）。
export const getServiceListenPorts = (name: string) =>
  api(`/api/services/${name}/listen`) as Promise<{ ports: number[]; web: number[] }>
// —— 配置底账（compose.yaml）：文件是唯一配置真相 ——
export interface ServiceConfigView {
  name: string
  path: string // compose.yaml 绝对路径（终端手改入口）
  yaml: string | null // null = 无文件（旧版创建 → 迁移入口；收编容器无底账）
  hasBuild: boolean // 文件带 build: → 给「构建并应用」
  hash: string | null // 当前文件 hash（compose config --hash）
  appliedHash: string | null // 容器 label 里最后一次 up 的 hash
  drift: boolean // 改了文件还没应用（或应用失败）
}
export const getServiceConfig = (name: string) =>
  api(`/api/services/${name}/config`) as Promise<ServiceConfigView>
// 应用 = 写文件（后端先校验）+ compose up -d（后台 job，build=true 时带 --build）。
export const applyServiceConfig = (name: string, yaml: string, build = false) =>
  postJson(`/api/services/${name}/apply`, { yaml, build }) as Promise<{ jobId: string }>
// 迁移（旧版 docker create 服务 → compose 底账）：按现容器形状生成文件后接管。
export const migrateService = (name: string) =>
  postJson(`/api/services/${name}/migrate`) as Promise<{ jobId: string }>
// 创建走后台任务：POST 只做快校验 + 预占，成功返回 jobId（进度看 jobs 轮询），
// 失败（重名/池尽/缺必填）4xx 内联显示在对话框。
export const createService = (input: CreateServiceInput) =>
  postJson('/api/services', input) as Promise<{ jobId: string }>

// —— 收编外部容器 ——
// 宿主上非 mysandbox 管理的 docker 容器（无 label）纳入服务层：sidecar 登记 + 接入
// 服务网络（LXC 按名字可达）。收编是同步动作，不走 job。
export interface AdoptableContainerView {
  name: string
  image: string
  state: string
  status: string
  networks: string
  onServiceNetwork: boolean // 已在服务网络（adopt 复用现 IP，不再 connect）
  compose: boolean // compose 栈容器（有 project label）——只能只读收编，底账在原编排方
  ip: string | null
}
export const listAdoptables = () =>
  api('/api/services/adoptables') as Promise<{ items: AdoptableContainerView[]; enabled: boolean }>
// 只读收编：sidecar 登记 + 接入服务网络，本体不动（同步返回 ServiceView）。
// takeover = 接管式收编（裸容器专用）：复刻启动方式进 compose 底账并重建容器
// （可写层数据丢失，卷无损），走后台 job——响应附 jobId 供任务横幅挂进度。
export const adoptService = (name: string, takeover = false) =>
  postJson('/api/services/adopt', { name, takeover }) as Promise<ServiceView & { jobId?: string }>
export const unadoptService = (name: string) => postJson(`/api/services/${name}/unadopt`)

// —— 服务任务 ——
export interface ServiceJobView {
  id: string
  kind: 'create' | 'apply' | 'migrate' | 'adopt'
  name: string
  image: string
  ip: string
  state: 'running' | 'done' | 'error' | 'canceled'
  statusText: string
  error?: string
  createdAt: number
  updatedAt: number
  cancellable: boolean
  logTail?: string[]
  result?: ServiceView
}
export const listServiceJobs = (tail = 30) =>
  api(`/api/services/jobs?tail=${tail}`) as Promise<{ jobs: ServiceJobView[] }>
export const getServiceJob = (id: string) =>
  api(`/api/services/jobs/${id}`) as Promise<{ job: ServiceJobView; log: string[] }>
export const cancelServiceJob = (id: string) => postJson(`/api/services/jobs/${id}/cancel`)

// —— hosts（新模型：全局面板已删） ——
// 新建容器的 hosts 多源预览（模板 rootfs / 宿主 /etc/hosts / 所选来源容器 / 包内），
// null = 读不到。container/archive 仅在请求时带键返回（包预览要跑 tar）。
export interface BaseHostsView {
  template: string | null
  host: string | null
  container?: string | null
  archive?: string | null
}
export function getBaseHosts(opts: { container?: string; archive?: string } = {}): Promise<BaseHostsView> {
  const q = new URLSearchParams()
  if (opts.container) q.set('container', opts.container)
  if (opts.archive) q.set('archive', opts.archive)
  const s = q.toString()
  return api(`/api/base/hosts${s ? `?${s}` : ''}`)
}
// hosts 覆写结果：比通用 BatchResult 多 skipped（读-比-写跳过的容器数）
export type HostsApplyResult = BatchResult & { skipped: number }
// 显式整体覆写所选容器的 /etc/hosts（批量配置 tab；服务块自动组合进内容）
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
  // 目录对应的宿主机实际路径（容器 = rootfs 前缀直拼；宿主面板 = path 本身）。
  hostPath?: string | null
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
// 终端路径链接解析（Ctrl+点击打开）：raw token（可相对/带 ~）→ 权威绝对路径 + 类型。
// HOST_ID 哨兵天然切宿主端点。missing 前端按 file 走编辑器新建态。
export interface ResolveView {
  path: string
  kind: 'dir' | 'file' | 'missing'
}
export const resolveTermPath = (id: string, termId: string, raw: string) =>
  api(
    `${filesBase(id)}/resolve?termId=${encodeURIComponent(termId)}&path=${encodeURIComponent(raw)}`,
  ) as Promise<ResolveView>
export const createEntry = (id: string, path: string, type: 'file' | 'dir') =>
  postJson(`${filesBase(id)}/fs/create`, { path, type }) as Promise<{ ok: true }>
// 改名（name 只含最后一段）；可选 toDir = 目标目录（文件面板拖拽移动用，缺省 = 原父目录）。
export const renameEntry = (id: string, path: string, name: string, toDir?: string) =>
  postJson(`${filesBase(id)}/fs/rename`, { path, name, toDir }) as Promise<{ ok: true; to: string }>
export const deleteEntry = (id: string, path: string) =>
  postJson(`${filesBase(id)}/fs/delete`, { path }) as Promise<{ ok: true }>
// —— 跨面板复制粘贴 ——
// 面板内部剪贴板：模块级单例（非系统剪贴板），跨 FilePanel 实例共享——复制后切到目标
// 容器/宿主的文件面板粘贴。服务端统一 /api/files/copy（双端解析宿主实址走 tar 管道），
// containerId 用 HOST_ID 哨兵表示宿主端。items 支持多项：文件面板 Ctrl/⌘ 点选多行
// 后整体复制（VS Code 式多选），粘贴端逐项调 copyEntry。
export interface FileClipItem {
  path: string
  name: string
  isDir: boolean
}
export interface FileClipboard {
  containerId: string
  containerName: string
  items: FileClipItem[]
}
let fileClip: FileClipboard | null = null
export const setFileClipboard = (c: FileClipboard | null): void => {
  fileClip = c
}
export const getFileClipboard = (): FileClipboard | null => fileClip
// 大目录是分钟级 tar 管道：显式 10min 超时覆盖 api() 默认的 10s（服务端 watchdog 同长）。
export const copyEntry = (p: {
  srcContainer: string
  srcPath: string
  dstContainer: string
  dstPath: string
}) =>
  api('/api/files/copy', {
    method: 'POST',
    body: JSON.stringify(p),
    signal: AbortSignal.timeout(10 * 60_000),
  }) as Promise<{ ok: true }>
// 下载（文件/目录）：fetch + Blob 中转而非 <a href="?token="> 裸导航——token 不落 URL/
// 浏览器历史，401/4xx 能解析 JSON 走统一报错（裸导航会把错误 JSON 直接存成文件）。
// Blob 由浏览器磁盘后端兜内存，大文件无压力；目录是服务端现打的 tar.gz 流。
// 不走 api()：那条路径有 10s 超时，掐死大下载。
export async function downloadEntry(id: string, path: string, name: string, isDir: boolean): Promise<void> {  const res = await fetch(`${filesBase(id)}/download?path=${encodeURIComponent(path)}`, {
    headers: { 'x-sandbox-token': getToken() ?? '' },
  })
  if (res.status === 401) throw new Unauthorized()
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(body?.error?.message || res.statusText, res.status, body?.error?.code || 'error')
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = isDir ? `${name}.tar.gz` : name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 保存流程还要读 URL 指向的 Blob，点完立即 revoke 在部分浏览器会断下载；延时回收。
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// 在线预览取流：与 downloadEntry 同一端点（二进制安全、无 2MB 文本上限），但不落盘。
// mime 由调用方按扩展名给出（服务端统一 octet-stream，浏览器对 blob URL 靠 MIME 解码）。
// Content-Length 先查后读：超过 PREVIEW_MAX_BYTES 直接拒（整文件进内存的硬顶）。
export async function fetchFileBlob(id: string, path: string, mime: string): Promise<Blob> {
  const res = await fetch(`${filesBase(id)}/download?path=${encodeURIComponent(path)}`, {
    headers: { 'x-sandbox-token': getToken() ?? '' },
  })
  if (res.status === 401) throw new Unauthorized()
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(body?.error?.message || res.statusText, res.status, body?.error?.code || 'error')
  }
  const len = res.headers.get('content-length')
  if (len && Number(len) > PREVIEW_MAX_BYTES) {
    throw new ApiError(`文件超过 ${Math.round(PREVIEW_MAX_BYTES / 1024 / 1024)}MB，不在线预览（可用下载）`, 413, 'too_large')
  }
  const buf = await res.arrayBuffer()
  return new Blob([buf], { type: mime })
}
export const getListenPorts = (id: string) =>
  // ports：全部监听端口；web：其中实测返回 HTML 的（真网页，可放心点击打开）
  api(`/api/containers/${id}/listen`) as Promise<{ ports: number[]; web: number[] }>

// —— git 面板（容器/宿主双端，filesBase 哨兵同文件 API）——
export interface GitChange {
  file: string
  x: string
  y: string
  oldFile?: string
}
export interface GitStatusView {
  repo: boolean
  toplevel?: string
  branch?: string | null
  label?: string
  unborn?: boolean
  ahead?: number
  behind?: number
  changes?: GitChange[]
  truncated?: boolean
}
export interface GitDiffSide {
  absent?: 'unborn' | 'no_head_path' | 'deleted' | 'too_large'
  binary?: boolean
  content?: string
  size?: number
}
export interface GitDiffView {
  repo: boolean
  toplevel: string
  file: string
  headFile?: string
  base: GitDiffSide
  work: GitDiffSide
}
export interface GitBranchesView {
  repo: boolean
  toplevel?: string
  current?: string | null // detached HEAD / 空仓库为 null
  branches?: string[] // 本地分支（当前分支排最前）
  remotes?: string[] // 远端分支短名原始列表（剔 origin/HEAD；本地已有对应者的由前端过滤展示）
}
export const getGitStatus = (id: string, path: string) =>
  api(`${filesBase(id)}/git/status?path=${encodeURIComponent(path)}`) as Promise<GitStatusView>
export const getGitDiff = (id: string, path: string, headPath?: string) =>
  api(
    `${filesBase(id)}/git/diff?path=${encodeURIComponent(path)}` +
      (headPath ? `&headPath=${encodeURIComponent(headPath)}` : ''),
  ) as Promise<GitDiffView>
export const getGitBranches = (id: string, path: string) =>
  api(`${filesBase(id)}/git/branches?path=${encodeURIComponent(path)}`) as Promise<GitBranchesView>
// 切换 / 新建（create）本地分支 / 检出远端分支（remote + name=origin/xxx 短名）；
// 冲突等 git 校验错误以 stderr 原话抛 ApiError
export const gitCheckout = (
  id: string,
  path: string,
  name: string,
  opts: { create?: boolean; remote?: boolean } = {},
) => postJson(`${filesBase(id)}/git/checkout`, { path, name, ...opts }) as Promise<{ ok: true }>
// 远端三件套 + 删本地分支（-d 安全删）。fetch/pull/push 涉及网络，超时放宽到 120s
const GIT_NET_TIMEOUT = 120_000
export const gitFetch = (id: string, path: string) =>
  postJson(`${filesBase(id)}/git/fetch`, { path }, GIT_NET_TIMEOUT) as Promise<{ ok: true }>
export const gitPull = (id: string, path: string) =>
  postJson(`${filesBase(id)}/git/pull`, { path }, GIT_NET_TIMEOUT) as Promise<{ ok: true }>
export const gitPush = (id: string, path: string) =>
  postJson(`${filesBase(id)}/git/push`, { path }, GIT_NET_TIMEOUT) as Promise<{ ok: true }>
export const gitBranchDelete = (id: string, path: string, name: string) =>
  postJson(`${filesBase(id)}/git/branch-delete`, { path, name }) as Promise<{ ok: true }>
// 撤销变更（恢复到 HEAD），三种目标互斥：file（tracked 丢 index+工作区改动、D 复活；
// untracked = 删除文件，前端二次确认；R/C 条目传 oldFile，撤销重命名 = 恢复旧路径 + 移除
// 新路径）/ dir（目录下全部，含删 untracked）/ all（整个工作区，reset --hard + clean）
export type GitRestoreTarget = { file: string; oldFile?: string } | { dir: string } | { all: true }
export const gitRestore = (id: string, path: string, target: GitRestoreTarget) =>
  postJson(`${filesBase(id)}/git/restore`, { path, ...target }) as Promise<{ ok: true }>

// —— worktree 管理（容器/宿主双端同哨兵；类型与 server/gitpanel.ts 对齐）——
export interface GitWorktree {
  path: string
  head?: string
  branch?: string // 检出的分支短名；detached/bare 无
  bare?: boolean
  detached?: boolean
  locked?: boolean
  lockedReason?: string
  prunable?: boolean
  prunableReason?: string
}
export interface GitWorktreesView {
  repo: boolean
  toplevel?: string // 面板路径所在 worktree 的根（即列表中的「当前」）
  worktrees?: GitWorktree[] // porcelain 原序，首个恒为主工作树（前端隐藏其移除钮）
}
export const getGitWorktrees = (id: string, path: string) =>
  api(`${filesBase(id)}/git/worktrees?path=${encodeURIComponent(path)}`) as Promise<GitWorktreesView>
// add 三模式：branch = 检出既有本地分支；remote = 从远端短名建跟踪分支（name=origin/xxx）；
// new = -b 新建（起点 HEAD）。dir 为目标绝对路径。
export const gitWorktreeAdd = (
  id: string,
  path: string,
  dir: string,
  mode: 'branch' | 'new' | 'remote',
  name: string,
) => postJson(`${filesBase(id)}/git/worktree-add`, { path, dir, mode, name }) as Promise<{ ok: true }>
// remove：普通删被拒（dirty/locked）时错误含 git 原话，前端二次提供 force
export const gitWorktreeRemove = (id: string, path: string, dir: string, force = false) =>
  postJson(`${filesBase(id)}/git/worktree-remove`, { path, dir, ...(force ? { force: true } : {}) }) as Promise<{
    ok: true
  }>
export const gitWorktreePrune = (id: string, path: string) =>
  postJson(`${filesBase(id)}/git/worktree-prune`, { path }) as Promise<{ ok: true }>
