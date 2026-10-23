# AI 工具与技能中心（aiconfig / skillSync / TestLens）

## 模型供应商 × Agent 绑定

`server/aiconfig.ts` 写入器 + `server/aiState.ts` 状态，路由 `/api/ai/*` 在 ai.ts；web `AiWorkspace.vue` 三板块：技能中心/模型供应商/Agent 工具。

三层模型——provider 库（`state.aiProviders`，N 个 OpenAI/Anthropic 兼容网关的凭据与端点）→ 绑定（`state.aiBinding` 全局一份 + `state.aiTargetOverrides` 容器覆盖，引用 provider id 不内联端点）→ 写入器（解析成 `AiApplyPlan` 逐 base 落盘）。

- **与 batch.ts 的 exec 路线不同，走宿主直写 rootfs**（D1 uid 直通，属主天然正确、容器不必在跑；宿主 home 是同套 writer 的另一 base，与容器同权，旧 `__host__` 覆盖已退役自愈清除）。
- **claude**：`.claude/settings.json` env 块（单槽，工具自身配置 toolConfig 合并进来、受管绑定键恒赢，一个保存按钮走 `POST /api/ai/claude-config`）。
- **codex**：`.codex/config.toml` 锚点块 + 顶层 `model_provider`/`model`（单槽重绑即覆盖；**model 必填**——不写 codex 落回内置 gpt-5.x slug、网关没有必 404；model_provider 恒写 = 绑定即启用；toolConfig.codex（approval/sandbox/推理力度/输出详略/上下文窗口等）→ 顶层对应键，保存路径差集回收、sweep 只合并不删，与 claude 顶级键同口径）。非 `gpt-*`/内置 slug 的 Codex 模型自动生成 `.codex/model-catalog.json`：含 provider 的 responses 模型清单、选中模型的上下文窗口与 reasoning 元数据，顶层指向 `model-catalog.json`，避免 Codex fallback metadata 告警；内置 slug 不写本地 catalog，防止替换官方清单。Codex 绑定槽可带 `metadata`，表单「模型元数据」折叠块覆盖 displayName/description、输入模态、并行工具、截断阈值、推理档位与自定义系统提示——未填字段由写入器补安全默认值。codex 另有 `.codex/.env` env 键值锚点块（codex 0.149+ 启动自读 CODEX_HOME/.env，不依赖 shell——tmux 老窗口也好使；旧版写 `.zshrc` export 的遗留块在写入时按同锚点回收）。
- **opencode**：`opencode.json`；**pi**：`.pi/agent/models.json`（多槽多 provider 共存）。opencode 的 anthropic 变体 baseURL 要补 `/v1`（@ai-sdk/anthropic 只拼 /messages，与 ANTHROPIC_BASE_URL 客户端自拼 /v1/messages 的约定差一级）。
- **幂等两类锚点**：JSON 只深改本方案的键（保留用户其余配置）；TOML/.env 用 `# >>> <pid> >>>` 标记块整块替换（旧 pid 恒为 myapikey、形状一致 → 存量零迁移）。变体 key = `<pid>-<wire 后缀>`。
- **保存按工具槽过滤下发**——各工具页签独立保存，Claude 页签保存不连带重写 opencode 配置。

## 技能中心（`server/skillSync.ts`，路由 `/api/skills/*` 在 skills.ts）

技能库 `STATE_DIR/skills/registry/<名>/` 是唯一技能真相源——**静态快照中心**（入库一律拷贝快照与来源解耦，来源改动不订阅不自动进库，更新走显式动作、先比对内容指纹再动手，源没了库副本冻结保留）。

- 安装规则（sidecar `state.skillsHub.rules`：技能集合+去向+范围，同 to 不允许两条规则）驱动两步同步：库 → 聚合副本 `hub-<hash(to)>/` → 容器去向（按 `<id>.json` 清单记账，「分发过而已消失」的真删，用户自装的其他 skills 不动）。
- **订阅单向：只订阅库，不订阅来源**——库内容一变安装位置自动跟走。
- 容器 start 事件补发停机期间克隆的项目；规则删除/改去向 → 孤儿按清单收回。
- 落点两处独立实体副本（无软链）见 [containers.md](containers.md)。

## TestLens 种子（`server/testlens.ts`）

往目标 home 写 `~/.agent-browser/config.json`（cdp 地址）+ `~/.testlens.json`（CLI host），**文件即真相**（view 读实际文件不存 sidecar 状态），install 读-改-写只动 cdp/host 两键；容器内走服务名 `http://testlens:<port>`、本机换算 `localhost`（端口已发布到宿主）。
