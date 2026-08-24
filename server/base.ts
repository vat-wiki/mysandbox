// 「基座」入口：新建容器的来源物，docker 下是镜像、lxc 下是模板容器（见 engine/types.ts BaseStatus）。
//
// 为什么合成一个入口而不是两套路由：前端只需要回答三个问题——基座就绪吗？能做哪些动作？
// 做的时候进度是什么？这三个问题两个引擎完全同构，只有「动作集」不同，而动作集已经由
// caps.baseActions 声明了。所以路由是 `/api/base` + `/api/base/<action>`，准入查 caps，
// 具体实现落到 engine.runBaseAction（docker -> image.ts，lxc -> engine/template.ts）。
//
// 鉴权由 index.ts 的全局 hook 覆盖 /api/*（本文件不做也不能绕过）。
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { getEngine } from './engine/index.js';
import type { BaseAction, BaseActionOpts, BaseProgress } from './engine/index.js';
import { badRequest } from './errors.js';
import { beginSse } from './sse.js';

// 请求体 -> BaseActionOpts。未知字段忽略；各引擎自行取用需要的项。
function parseOpts(body: unknown): BaseActionOpts {
  const b = (body as Record<string, unknown> | null) || {};
  const str = (k: string): string | undefined => (b[k] == null ? undefined : String(b[k]));
  return {
    tag: str('tag'),
    ref: str('ref'),
    path: str('path'),
    from: str('from'),
    noCache: !!b.noCache,
    force: !!b.force,
  };
}

const ALL_ACTIONS: BaseAction[] = ['build', 'pull', 'push', 'export', 'import', 'clone'];

export async function registerBaseRoutes(app: FastifyInstance, cfg: Config): Promise<void> {
  // 基座状态。App 轮询这个接口，所以实现里 context 定位失败不能变 500（见 BaseStatus 注释）。
  app.get('/api/base', async () => getEngine(cfg).baseStatus(cfg));

  // 体积单独一个接口：LXC 下算一次要遍历整个 rootfs（2.8G），不能塞进被轮询的 status。
  // docker 侧 inspect 直接带 size，顺手返回，前端无需分引擎。
  app.get('/api/base/size', async () => {
    const engine = getEngine(cfg);
    if (engine.name === 'lxc') {
      const { lxcTemplateSize } = await import('./engine/lxc.js');
      return { size: await lxcTemplateSize(cfg) };
    }
    const s = await engine.baseStatus(cfg);
    return { size: s.size ?? null };
  });

  // 动作。SSE 流式进度：耗时从秒（clone 小模板）到十几分钟（build / export 2.8G）不等，
  // 同步等完对用户就是「点了没反应」。
  app.post<{ Params: { action: string } }>('/api/base/:action', async (req, reply) => {
    const engine = getEngine(cfg);
    const action = req.params.action as BaseAction;
    if (!ALL_ACTIONS.includes(action)) throw badRequest(`unknown base action "${action}"`);
    // 准入查 caps 而非等实现抛：错误信息里能带上「这个引擎支持哪些」，比 500 有用。
    if (!engine.caps.baseActions.includes(action)) {
      throw badRequest(
        `engine "${engine.name}" does not support base action "${action}" ` +
          `(supported: ${engine.caps.baseActions.join(', ')})`,
      );
    }
    const opts = parseOpts(req.body);
    const { sink, finalize } = beginSse(reply);
    await finalize(() =>
      engine.runBaseAction(cfg, action, opts, (e: BaseProgress) => sink(e)),
    );
  });
}

// —— CLI：mysandbox base <action> ——
// `mysandbox image build|pull|push|status` 保留为别名（见 cli.ts 分发），
// 因为它已经写进文档和肌肉记忆里；docker 引擎下两者完全等价。
const BASE_HELP = `mysandbox base <command> — manage the container base
                   (docker: the base image; lxc: the template container)

Usage:
  mysandbox base status
      Show whether the base is present and ready to create containers from.
  mysandbox base build [--tag <name>] [--no-cache]     (docker only)
      Build the base image from the image/ build context.
  mysandbox base pull [<ref>]                          (docker only)
      Pull <ref> (default \${registry}:\${imageTag}) and retag as cfg.image.
  mysandbox base push [<ref>]                          (docker only)
      Tag cfg.image as <ref> (default \${registry}:\${imageTag}) and push.
  mysandbox base clone --from <container> [--force]     (lxc only)
      Freeze an existing container into the template (stops it first).
  mysandbox base export [<path>] [--force]             (lxc only)
      Pack the template into <path> (default ~/<template>.tar.zst).
  mysandbox base import <path> [--force]               (lxc only)
      Restore the template from an archive.

Which actions are available depends on the engine — \`base status\` prints the list.
`;

const BOOL_FLAGS = new Set(['no-cache', 'force']);

function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (BOOL_FLAGS.has(name)) flags[name] = 'true';
      else if (eq >= 0) flags[name] = a.slice(eq + 1);
      else flags[name] = argv[++i] ?? '';
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function cliProgress(e: BaseProgress): void {
  if (e.stream) {
    process.stdout.write(e.stream); // 步骤输出自带换行
    return;
  }
  if (e.error) {
    process.stderr.write(`>> ${e.error}\n`);
    return;
  }
  if (e.status) {
    process.stdout.write(`${e.id ? `${e.id}: ` : ''}${e.status}\n`);
  }
}

function fmtSize(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// `mysandbox base ...`（`mysandbox image ...` 走同一函数，见 cli.ts）。
export async function runBaseCommand(argv: string[], cfg: Config): Promise<void> {
  const { positionals, flags } = parseArgs(argv);
  const sub = positionals[0];
  const engine = getEngine(cfg);

  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(BASE_HELP);
    return;
  }

  if (sub === 'status') {
    const s = await engine.baseStatus(cfg);
    const label = s.kind === 'image' ? 'image' : 'template';
    process.stdout.write(
      `>> ${label} ${s.name}: ${s.exists ? (s.ready ? 'ready' : 'present but NOT ready') : 'NOT FOUND'}\n`,
    );
    if (s.notReady) process.stdout.write(`   ${s.notReady}\n`);
    for (const [k, v] of Object.entries(s.detail ?? {})) {
      process.stdout.write(`   ${k.padEnd(8)} ${v}\n`);
    }
    if (s.size != null) process.stdout.write(`   size     ${fmtSize(s.size)}\n`);
    if (s.createdAt) process.stdout.write(`   created  ${s.createdAt}\n`);
    if (s.context) process.stdout.write(`   from     ${s.context}\n`);
    else if (s.contextError) process.stdout.write(`   from     ERROR — ${s.contextError}\n`);
    process.stdout.write(`   actions  ${engine.caps.baseActions.join(', ')}\n`);
    return;
  }

  if (!ALL_ACTIONS.includes(sub as BaseAction)) {
    throw new Error(`unknown base subcommand "${sub}". Run \`mysandbox base help\`.`);
  }
  const action = sub as BaseAction;
  if (!engine.caps.baseActions.includes(action)) {
    throw new Error(
      `engine "${engine.name}" does not support "${action}" ` +
        `(supported: ${engine.caps.baseActions.join(', ')})`,
    );
  }

  // 位置参数按动作映射：pull/push 收 ref，export/import 收路径（与 HTTP 的 body 字段同名）。
  const positional = positionals[1];
  const opts: BaseActionOpts = {
    tag: flags.tag,
    ref: action === 'pull' || action === 'push' ? positional : undefined,
    path: action === 'export' || action === 'import' ? positional || flags.path : undefined,
    from: flags.from,
    noCache: 'no-cache' in flags,
    force: 'force' in flags,
  };
  if (action === 'clone' && !opts.from) {
    throw new Error('base clone needs --from <container> (the container to freeze into a template)');
  }
  if (action === 'import' && !opts.path) {
    throw new Error('base import needs an archive path');
  }

  process.stdout.write(`>> ${engine.name} base ${action}…\n`);
  const result = await engine.runBaseAction(cfg, action, opts, cliProgress);
  const summary = Object.entries(result)
    .map(([k, v]) => `${k}=${typeof v === 'number' && k === 'size' ? fmtSize(v) : String(v)}`)
    .join(' ');
  process.stdout.write(`>> done${summary ? `: ${summary}` : ''}\n`);
}
