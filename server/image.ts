// 基础镜像生命周期：build / pull / push / status。dockerode 直连，与容器侧同 socket、同权限模型。
// 设计：build 与 pull 对称——两者落地后本地都有名为 cfg.image 的可用镜像；push 是 pull 的逆。
//   - build：用内置 image/ 构建上下文，产物 tag = cfg.image（默认 dev），立即可被 createContainer 用。
//   - pull：拉 ${registry}:${imageTag}，再 retag 成 cfg.image。
//   - push：把本地 cfg.image tag 成 ${registry}:${imageTag} 后推。
// 进度流：CLI 走 stdout 实时打印（followProgress）；HTTP 端点同步等待完成（流式 SSE 留作 follow-up）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type Docker from 'dockerode';
import type { Config } from './config.js';
import { expandTilde } from './config.js';
import { getDocker } from './docker.js';
import { badRequest } from './errors.js';
import { log } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// image/ 构建上下文里的文件（dockerode {context,src} 形式只 tar 列出的 src，保持上下文最小）。
const IMAGE_CONTEXT_FILES = ['Dockerfile', 'entrypoint.sh', 'zshrc.docker'];
// 打到自建镜像上的 label，便于辨识 mysandbox 产物。
export const IMAGE_LABEL = 'mysandbox.image-built-by';

// dockerode followProgress 事件（取会用到的字段）。
interface ProgressEvent {
  stream?: string;
  status?: string;
  id?: string;
  progress?: string;
  error?: string;
  aux?: unknown;
}

// —— 定位镜像构建上下文：配置 imageDir（外部目录）优先，否则内置 image/（dev: server/../image；packaged: dist/server/../../image）——
// 内置定位与 config.ts:loadDefaultYaml / index.ts:findWebDist 同款双候选。发布时 image/ 必须在 package.json files[] 里。
export function findImageContext(cfg: Config): string {
  if (cfg.imageDir) {
    const p = expandTilde(cfg.imageDir);
    if (!isAbsolute(p)) {
      throw new Error(`config imageDir must be an absolute path (got "${cfg.imageDir}")`);
    }
    if (!existsSync(p)) {
      throw new Error(`config imageDir points to a missing directory: ${p}`);
    }
    return resolve(p);
  }
  const candidates = [
    join(__dirname, '..', 'image'), // dev: server/ -> root
    join(__dirname, '..', '..', 'image'), // dist/server/ -> root
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    'image build context not found (image/ dir missing — packaged install without "image" in files[]?)',
  );
}

// 外部上下文目录的默认排除项（内置目录走白名单，不经过这里）。
const CONTEXT_EXCLUDE = new Set(['.git', '.svn', '.DS_Store', 'Thumbs.db', '.direnv']);

// 递归枚举上下文目录，产出 posix 相对路径（dockerode 以相对路径应用 .dockerignore）。
// 只列文件不列目录——tar-fs 会展开目录 entries，dir+file 并列会产生重复 tar 成员。
export function listContextFiles(ctx: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (CONTEXT_EXCLUDE.has(ent.name) || ent.name.endsWith('.swp')) continue;
      const abs = join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      let stat;
      try {
        stat = statSync(abs); // 跟随 symlink；断链会 throw
      } catch {
        log.warn({ path: abs }, 'skip unreadable context entry');
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs, relPath);
      } else if (stat.isFile()) {
        out.push(relPath.split(sep).join('/'));
      }
    }
  };
  walk(ctx, '');
  if (!out.includes('Dockerfile')) {
    throw new Error(`image build context has no Dockerfile: ${ctx}`);
  }
  return out.sort();
}

// —— 镜像存在性 ——
export async function imageExists(cfg: Config, name: string): Promise<boolean> {
  try {
    await getDocker(cfg).getImage(name).inspect();
    return true;
  } catch {
    return false;
  }
}

export interface ImageStatus {
  exists: boolean;
  // 当前构建上下文绝对路径（imageDir 或内置 image/ 定位结果）；定位失败为 null + contextError。
  // 独立于 exists 计算（App 轮询此接口，context 出错不能拖垮镜像存在性判断）。
  context?: string | null;
  contextError?: string;
  image?: {
    id: string;
    repoTags: string[];
    created: string;
    size: number;
    labels: Record<string, string>;
  };
}

export async function imageStatus(cfg: Config): Promise<ImageStatus> {
  let context: string | null = null;
  let contextError: string | undefined;
  try {
    context = findImageContext(cfg);
  } catch (e) {
    contextError = e instanceof Error ? e.message : String(e);
  }
  const base: ImageStatus = { exists: false, context, ...(contextError ? { contextError } : {}) };
  try {
    const info = (await getDocker(cfg).getImage(cfg.image).inspect()) as Docker.ImageInspectInfo;
    return {
      ...base,
      exists: true,
      image: {
        id: info.Id,
        repoTags: info.RepoTags ?? [],
        created: info.Created,
        size: info.Size,
        labels: (info.Config?.Labels as Record<string, string> | undefined) ?? {},
      },
    };
  } catch {
    return base;
  }
}

// ref 缺省时回退 ${registry}:${imageTag}；都没则报清晰错误。
export function resolveImageRef(cfg: Config, ref?: string): string {
  const r = (ref ?? '').trim();
  if (r) return r;
  if (cfg.registry) return `${cfg.registry}:${cfg.imageTag || 'latest'}`;
  throw badRequest(
    'no image ref given and config.registry is empty — set `registry` in config or pass an explicit ref',
  );
}

// 把 ref 拆成 repo + tag。注意 `localhost:5000/x` 的 host 里也有冒号：tag 冒号必在最后一个 / 之后。
export function splitRef(ref: string): { repo: string; tag: string } {
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  if (lastColon > lastSlash) {
    return { repo: ref.slice(0, lastColon), tag: ref.slice(lastColon + 1) || 'latest' };
  }
  return { repo: ref, tag: 'latest' };
}

// —— build ——
export async function buildImage(
  cfg: Config,
  opts: { tag?: string; noCache?: boolean },
  onProgress?: (e: ProgressEvent) => void,
): Promise<{ tag: string }> {
  const docker = getDocker(cfg);
  const tag = opts.tag || cfg.image;
  const ctx = findImageContext(cfg);
  // 内置目录走白名单（行为零回归）；外部目录递归枚举（.dockerignore 由 dockerode 按相对路径应用）。
  const src = cfg.imageDir ? listContextFiles(ctx) : IMAGE_CONTEXT_FILES;
  type BuildArgs = Parameters<Docker['buildImage']>;
  const stream = await docker.buildImage(
    { context: ctx, src } as BuildArgs[0],
    {
      t: tag,
      nocache: opts.noCache ?? false,
      labels: { [IMAGE_LABEL]: 'mysandbox' },
      version: '2', // BuildKit：镜像 Dockerfile 用 `COPY --chmod`，legacy builder 不支持
    } as BuildArgs[1],
  );
  await followProgress(docker, stream, onProgress);
  // 安全网：followProgress 可能吞掉个别错误形态，按「产物是否真的存在」做最终判定，绝不静默谎报成功。
  if (!(await imageExists(cfg, tag))) {
    throw new Error(
      `build reported success but image "${tag}" not found — a build step likely failed (see progress output above).`,
    );
  }
  log.info({ tag, context: ctx, noCache: !!opts.noCache, files: src.length }, 'image built');
  return { tag };
}

// —— pull：拉完后 retag 成 cfg.image，使其立即可用（与 build 对称）——
export async function pullImage(
  cfg: Config,
  ref: string,
  onProgress?: (e: ProgressEvent) => void,
): Promise<{ ref: string }> {
  const docker = getDocker(cfg);
  const stream = await docker.pull(ref);
  await followProgress(docker, stream, onProgress);
  // retag 成 cfg.image（拉下来的 ref 可能带 registry 前缀，统一落到本地 cfg.image 名）。
  const dst = splitRef(cfg.image);
  await docker.getImage(ref).tag({ repo: dst.repo, tag: dst.tag });
  log.info({ ref, image: cfg.image }, 'image pulled + retagged');
  return { ref };
}

// —— push：先把本地 cfg.image tag 成目标 ref，再推 ——
export async function pushImage(
  cfg: Config,
  ref: string,
  onProgress?: (e: ProgressEvent) => void,
): Promise<{ ref: string }> {
  const docker = getDocker(cfg);
  const { repo, tag } = splitRef(ref);
  // 本地 cfg.image -> 目标 repo:tag（docker tag 等价）。
  const src = splitRef(cfg.image);
  await docker.getImage(`${src.repo}:${src.tag}`).tag({ repo, tag });
  // 推；私有 registry 需 authconfig（取自 ~/.docker/config.json，即 `docker login` 的结果）。
  const authconfig = readDockerAuth(registryHostOf(ref));
  const stream = await docker.getImage(`${repo}:${tag}`).push(authconfig ? { authconfig } : {});
  await followProgress(docker, stream, onProgress);
  log.info({ ref, image: cfg.image, auth: !!authconfig }, 'image pushed');
  return { ref };
}

// followProgress 收敛：docker-modem 的 onFinish 即便 build 出错也常传 null（错误以 {error} 事件流式到达），
// 故自行累积 error 事件、结束时若有过错则 reject，避免 build 失败却谎报成功。
async function followProgress(
  docker: Docker,
  stream: NodeJS.ReadableStream,
  onProgress?: (e: ProgressEvent) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let failed: string | null = null;
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) return reject(err);
        if (failed) return reject(new Error(failed));
        resolve();
      },
      (e: unknown) => {
        const ev = e as ProgressEvent;
        if (ev?.error && !failed) failed = ev.error;
        onProgress?.(ev);
      },
    );
  });
}

// —— push 鉴权：读 $DOCKER_CONFIG/config.json（默认 ~/.docker/config.json）里对应 host 的条目 ——
// docker login 存的 auths[host] 形如 { auth: base64(user:pass) } 或 { identitytoken }。credsStore（osxkeychain 等）
// 不解析——那种情况让 dockerode 自然报错、提示 docker login。
export function readDockerAuth(
  host: string,
): { username: string; password: string; serveraddress: string } | { identitytoken: string; serveraddress: string } | undefined {
  const cfgPath = process.env.DOCKER_CONFIG
    ? join(process.env.DOCKER_CONFIG, 'config.json')
    : join(homedir(), '.docker', 'config.json');
  let parsed: { auths?: Record<string, { auth?: string; username?: string; password?: string; identitytoken?: string }> };
  try {
    parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    return undefined;
  }
  const entry = parsed.auths?.[host];
  if (!entry) return undefined;
  if (entry.username && entry.password) {
    return { username: entry.username, password: entry.password, serveraddress: host };
  }
  if (entry.auth) {
    const [username, ...rest] = Buffer.from(entry.auth, 'base64').toString('utf8').split(':');
    return { username, password: rest.join(':'), serveraddress: host };
  }
  if (entry.identitytoken) {
    return { identitytoken: entry.identitytoken, serveraddress: host };
  }
  return undefined;
}

// 由 ref 推断 registry host（docker config 里 auths 的 key）。
// 无 host / host 段无 '.' ':' 且非 localhost → Docker Hub（config.json 里是 https://index.docker.io/v1/）。
export function registryHostOf(ref: string): string {
  const slash = ref.indexOf('/');
  const first = slash >= 0 ? ref.slice(0, slash) : '';
  if (!first) return 'https://index.docker.io/v1/';
  if (first === 'localhost' || first.includes('.') || first.includes(':')) return first;
  return 'https://index.docker.io/v1/';
}

// —— REST 路由（鉴权由 index.ts 全局 hook 覆盖 /api/*）——

// SSE：把 build/pull/push 的 followProgress 事件逐条推给前端（data: {...}\n\n），done/error 收尾。
// reply.hijack() 接管响应手动写 text/event-stream；鉴权仍在 hijack 前由全局 onRequest 完成。
// finalize 接 thunk：ref 解析 / 构建过程中任一抛错都转成 SSE error 帧，保持"要么流式进度、要么流式错误"的契约。
function beginSse(reply: FastifyReply): {
  sink: (e: ProgressEvent) => void;
  finalize: (thunk: () => Promise<unknown>) => Promise<void>;
} {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // 防 nginx 等反向代理缓冲
  });
  const write = (obj: Record<string, unknown>): void => {
    if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  return {
    sink: (e) =>
      write({ type: 'progress', stream: e.stream, status: e.status, id: e.id, progress: e.progress }),
    finalize: async (thunk) => {
      try {
        const result = await thunk();
        write({ type: 'done', result });
      } catch (err) {
        write({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    },
  };
}

export async function registerImageRoutes(app: FastifyInstance, cfg: Config): Promise<void> {
  app.get('/api/image', async () => imageStatus(cfg));

  app.post('/api/image/build', async (req, reply) => {
    const body = (req.body as Record<string, unknown> | null) || {};
    const tag = body.tag ? String(body.tag) : cfg.image;
    const noCache = !!body.noCache;
    const { sink, finalize } = beginSse(reply);
    await finalize(() => buildImage(cfg, { tag, noCache }, sink));
  });

  app.post('/api/image/pull', async (req, reply) => {
    const body = (req.body as Record<string, unknown> | null) || {};
    const { sink, finalize } = beginSse(reply);
    await finalize(() => {
      const resolved = resolveImageRef(cfg, body.ref ? String(body.ref) : undefined);
      return pullImage(cfg, resolved, sink);
    });
  });

  app.post('/api/image/push', async (req, reply) => {
    const body = (req.body as Record<string, unknown> | null) || {};
    const { sink, finalize } = beginSse(reply);
    await finalize(() => {
      const resolved = resolveImageRef(cfg, body.ref ? String(body.ref) : undefined);
      return pushImage(cfg, resolved, sink);
    });
  });
}

// —— CLI 子命令分发：mysandbox image build|pull|push|status ——
const IMAGE_HELP = `mysandbox image <command> — manage the base image

Usage:
  mysandbox image build [--tag <name>] [--no-cache]
      Build the base image from the bundled image/ context, tagged cfg.image (default: dev).
  mysandbox image pull [<ref>]
      Pull <ref> (default \${registry}:\${imageTag}) and retag as cfg.image.
  mysandbox image push [<ref>]
      Tag cfg.image as <ref> (default \${registry}:\${imageTag}) and push.
  mysandbox image status
      Show whether cfg.image is present locally + inspect summary.

Config: registry / imageTag in the config file drive push/pull defaults when <ref> is omitted.
`;

const BOOL_FLAGS = new Set(['no-cache']);

interface ParsedImageArgs {
  positionals: string[];
  flags: Record<string, string>;
}

function parseImageArgs(argv: string[]): ParsedImageArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (BOOL_FLAGS.has(name)) {
        flags[name] = 'true';
      } else if (eq >= 0) {
        flags[name] = a.slice(eq + 1);
      } else {
        flags[name] = argv[++i] ?? '';
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function cliProgress(e: ProgressEvent): void {
  if (e.stream) {
    process.stdout.write(e.stream); // Dockerfile 步骤输出自带换行
    return;
  }
  if (e.error) {
    process.stderr.write(`>> docker: ${e.error}\n`);
    return;
  }
  if (e.status) {
    const id = e.id ? `${e.id}: ` : '';
    process.stdout.write(`${id}${e.status}\n`);
  }
}

export async function runImageCommand(argv: string[], cfg: Config): Promise<void> {
  const { positionals, flags } = parseImageArgs(argv);
  const sub = positionals[0];

  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(IMAGE_HELP);
    return;
  }

  if (sub === 'build') {
    const tag = flags.tag || cfg.image;
    const noCache = 'no-cache' in flags;
    process.stdout.write(`>> building from ${findImageContext(cfg)} -> ${tag}\n`);
    await buildImage(cfg, { tag, noCache }, cliProgress);
    process.stdout.write(`>> built: ${tag}\n`);
    return;
  }

  if (sub === 'pull') {
    const ref = resolveImageRef(cfg, positionals[1]);
    process.stdout.write(`>> pulling ${ref} -> retag as ${cfg.image}\n`);
    await pullImage(cfg, ref, cliProgress);
    process.stdout.write(`>> pulled: ${ref} (available as ${cfg.image})\n`);
    return;
  }

  if (sub === 'push') {
    const ref = resolveImageRef(cfg, positionals[1]);
    process.stdout.write(`>> pushing ${cfg.image} -> ${ref}\n`);
    await pushImage(cfg, ref, cliProgress);
    process.stdout.write(`>> pushed: ${ref}\n`);
    return;
  }

  if (sub === 'status') {
    const s = await imageStatus(cfg);
    if (s.exists && s.image) {
      const im = s.image;
      process.stdout.write(`>> image ${cfg.image}: present\n`);
      process.stdout.write(`   id:      ${im.id}\n`);
      process.stdout.write(`   tags:    ${im.repoTags.join(', ') || '(none)'}\n`);
      process.stdout.write(`   created: ${im.created}\n`);
      process.stdout.write(`   size:    ${(im.size / 1024 / 1024).toFixed(1)} MB\n`);
    } else {
      process.stdout.write(`>> image ${cfg.image}: NOT FOUND locally\n`);
      process.stdout.write(`   build: mysandbox image build\n`);
      process.stdout.write(`   pull:  mysandbox image pull\n`);
    }
    if (s.context) process.stdout.write(`   context: ${s.context}\n`);
    else if (s.contextError) process.stdout.write(`   context: ERROR — ${s.contextError}\n`);
    return;
  }

  throw new Error(`unknown image subcommand "${sub}". Run \`mysandbox image help\`.`);
}
