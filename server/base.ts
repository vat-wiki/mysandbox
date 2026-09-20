// 「基座」入口：新建容器的来源物 = 模板容器（见 engine/types.ts BaseStatus）。
//
// 前端只需要回答三个问题——基座就绪吗？能做哪些动作？做的时候进度是什么？
// 动作集由 caps.baseActions 声明。路由是 `/api/base` + `/api/base/<action>`，
// 准入查 caps，具体实现落到 engine.runBaseAction（engine/template.ts）。
//
// 鉴权由 index.ts 的全局 hook 覆盖 /api/*（本文件不做也不能绕过）。
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { getEngine } from './engine/index.js';
import { readHostHosts } from './hosts.js';
import { readContainerHosts } from './hosts-sync.js';
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

const ALL_ACTIONS: BaseAction[] = ['create', 'export', 'import', 'clone'];

export async function registerBaseRoutes(app: FastifyInstance, cfg: Config): Promise<void> {
  // 基座状态。App 轮询这个接口，所以实现里 context 定位失败不能变 500（见 BaseStatus 注释）。
  app.get('/api/base', async () => getEngine(cfg).baseStatus(cfg));

  // 体积单独一个接口：算一次要遍历整个 rootfs（LXC 2.8G）/ stat VHD（wsl2），
  // 不能塞进被轮询的 status。
  app.get('/api/base/size', async () => {
    return { size: await getEngine(cfg).baseSize(cfg) };
  });

  // 新建容器的 hosts 多源预览（CreateDialog）：模板 rootfs 的 /etc/hosts（源头，
  // 克隆原样继承）与宿主 /etc/hosts（可选覆写源）。读不到返回 null，前端显示降级说明。
  // query 带 container=/archive= 时追加对应来源的内容（「从现有容器/从包建容器」预览）——
  // 仅请求时带键才查，包预览要跑 tar，不该无脑算。
  app.get<{ Querystring: { container?: string; archive?: string } }>('/api/base/hosts', async (req) => {
    const q = req.query;
    const template = await getEngine(cfg).readTemplateHosts(cfg);
    const host = await readHostHosts();
    return {
      template: template ?? null,
      host: host || null,
      ...(q.container != null ? { container: await readContainerHosts(cfg, q.container) } : {}),
      ...(q.archive != null ? { archive: await getEngine(cfg).readArchiveHosts(cfg, q.archive) } : {}),
    };
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
// `mysandbox image ...` 保留为历史别名（见 cli.ts 分发）。
const BASE_HELP = `mysandbox base <command> — manage the template container

Usage:
  mysandbox base status
      Show whether the template is present and ready to create containers from.
  mysandbox base create [--force]
      Build the template from scratch: download ubuntu noble rootfs, boot it,
      run scripts/lxc-template.sh (10-20 min), then stop it.
  mysandbox base clone --from <container> [--force]
      Freeze an existing container into the template (stops it first).
  mysandbox base export [<path>] [--from <container>] [--force]
      Pack the template (default) or any container into <path> (default ~/<name>.tar.zst).
  mysandbox base import <path> [--force]
      Restore the template from an archive.
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
    process.stdout.write(
      `>> template ${s.name}: ${s.exists ? (s.ready ? 'ready' : 'present but NOT ready') : 'NOT FOUND'}\n`,
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

  // 位置参数按动作映射：export/import 收路径（与 HTTP 的 body 字段同名）。
  const positional = positionals[1];
  const opts: BaseActionOpts = {
    tag: flags.tag,
    ref: undefined,
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
