// Monaco 离线 + 精简配置。mysandbox 默认只监听 127.0.0.1、可能离线，不能依赖
// @monaco-editor/loader 的默认 CDN（jsdelivr）。这里：
//   1) loader.config({ monaco }) 把 loader 指向本地打包的 monaco-editor 包
//   2) 只引核心 API（editor.api）+ 一个 editor base worker——不引 editor.main
//      （那会注册全部语言模式，把首屏打到 ~4MB）。hosts 用自定义 Monarch 词法着色。
//   3) MonacoEnvironment.getWorker 接到 Vite 产出的 worker chunk（vite.config 别名绕过 exports map）。
import * as monaco from 'monaco-editor/api'
// worker：相对路径（带 ?worker）让 Vite 单独打成 worker chunk。别名 + ?worker 在 rollup
// 解析阶段不稳定，故 worker 用相对路径、仅 api 走别名。
import editorWorker from '../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker'
import { loader } from '@guolao/vue-monaco-editor'

// 文件编辑器用的语言集：每语言只引 register.js（<1KB 元数据），语法本体是懒加载
// chunk（用不到不下载）。register.js 内部相对引用 '../../editor/editor.api.js'，
// 与上面 alias 'monaco-editor/api' 解析到同一物理文件，Monaco 单例不重复。
// 注意：json 不在 definitions/（它是带 json worker 的智能语言，走 features 注册路径），
// 其余都是 Monarch 语法。typescript 的 definitions 版只有词法着色，已够本用途。
import '../../node_modules/monaco-editor/esm/vs/languages/features/json/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/yaml/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/markdown/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/shell/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/python/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/javascript/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/typescript/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/dockerfile/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/ini/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/go/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/rust/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/sql/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/xml/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/css/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/scss/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/html/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/java/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/lua/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/ruby/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/cpp/register.js'
import '../../node_modules/monaco-editor/esm/vs/languages/definitions/graphql/register.js'

// 编辑器功能贡献（features/*）：editor.api 只有内核，任何交互功能都要显式注册。
// 路径形状与上面的语言 register 同构（磁盘直指绕 exports map，内部相对引用回落同一份
// editor.api.js，Monaco 单例不重复）。升级 monaco 若挪走这些入口，构建期即报错，不会静默丢功能。
import '../../node_modules/monaco-editor/esm/vs/features/codicon/register.js' // 图标字体 CSS（不引则查找框图标空白）
import '../../node_modules/monaco-editor/esm/vs/features/find/register.js' // Ctrl+F 查找（FindController + FindWidget）
import '../../node_modules/monaco-editor/esm/vs/features/diffEditor/register.js' // diff 视图的命令/菜单贡献

;(self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
}

loader.config({ monaco })

// hosts 词法（Monarch）：注释、IPv4/IPv6、主机名/别名、关键字 localhost。
// 注册成语言 id 'hosts'，HostsPanel 的 <VueMonacoEditor language="hosts"> 用它。
monaco.languages.register({ id: 'hosts' })
monaco.languages.setMonarchTokensProvider('hosts', {
  ignoreCase: false,
  tokenizer: {
    root: [
      [/#.*$/, 'comment'],
      // 行首 IP（v4 / v6）后跟空白
      [/^\s*(?:[0-9a-fA-F:.]+)\b/, { token: 'number' }],
      [/\blocalhost\b/i, 'keyword'],
      [/[a-zA-Z0-9._-]+/, 'identifier'],
      [/\s+/, 'white'],
    ],
  },
})

// 文件名 -> monaco 语言 id（按上面已注册的子集）。缺省 plaintext。
// 0.56 的 definitions 无 toml -> 映射 ini（同为键值对，够用）。
const EXT_LANG: Record<string, string> = {
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  'jsonc': 'json',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  dockerfile: 'dockerfile',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  properties: 'ini',
  toml: 'ini',
  env: 'ini',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  vue: 'html',
  java: 'java',
  lua: 'lua',
  rb: 'ruby',
  c: 'cpp',
  h: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  graphql: 'graphql',
  gql: 'graphql',
}
const NAME_LANG: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'shell', // 近似：make 语法与 shell 相近，无专用模式
}
export function langForFilename(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  return NAME_LANG[base] || EXT_LANG[base.slice(base.lastIndexOf('.') + 1).toLowerCase()] || 'plaintext'
}

export { monaco }
