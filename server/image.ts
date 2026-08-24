// docker 基础镜像：build / pull / push / status。dockerode 直连，与容器侧同 socket、同权限模型。
// 引擎无关的入口在 base.ts（`/api/base*` + `mysandbox base`），本文件是 docker 引擎的基座实现
// （LXC 的对应物是 engine/template.ts 的模板容器）。
// 设计：build 与 pull 对称——两者落地后本地都有名为 cfg.image 的可用镜像；push 是 pull 的逆。
//   - build：用内置 image/ 构建上下文，产物 tag = cfg.image（默认 dev），立即可被 createContainer 用。
//   - pull：拉 ${registry}:${imageTag}，再 retag 成 cfg.image。
//   - push：把本地 cfg.image tag 成 ${registry}:${imageTag} 后推。
// 进度流：CLI 走 stdout 实时打印（followProgress）；HTTP 端点由 base.ts 转成 SSE。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type Docker from 'dockerode';
import type { Config } from './config.js';
import { expandTilde } from './config.js';
import { getDocker } from './engine/index.js';
import type { BaseStatus } from './engine/index.js';
import { badRequest } from './errors.js';
import { log } from './logger.js';
import type { ProgressEvent } from './sse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// image/ 构建上下文里的文件（dockerode {context,src} 形式只 tar 列出的 src，保持上下文最小）。
const IMAGE_CONTEXT_FILES = ['Dockerfile', 'entrypoint.sh', 'zshrc.docker'];
// 打到自建镜像上的 label，便于辨识 mysandbox 产物。
export const IMAGE_LABEL = 'mysandbox.image-built-by';

// dockerode followProgress 事件用 sse.ts 的 ProgressEvent（两处形状一致，别再定义一份）。

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

// —— 归一到引擎无关的 BaseStatus（docker 引擎的 baseStatus 实现，见 engine/types.ts）——
// docker 下 exists 即 ready（镜像没有「在运行所以不能用」这种状态，LXC 模板才有）。
// id/tags 这类 docker 特有字段进 detail，前端原样列出、不为它设跨引擎结构。
export async function imageBaseStatus(cfg: Config): Promise<BaseStatus> {
  const s = await imageStatus(cfg);
  const detail: Record<string, string> = {};
  if (s.image) {
    detail.id = s.image.id;
    detail.tags = s.image.repoTags.join(', ') || '—';
  }
  return {
    kind: 'image',
    name: cfg.image,
    exists: s.exists,
    ready: s.exists,
    ...(s.exists ? {} : { notReady: `基础镜像 ${cfg.image} 本地不存在——先构建或拉取一个` }),
    context: s.context,
    ...(s.contextError ? { contextError: s.contextError } : {}),
    ...(s.image ? { size: s.image.size, createdAt: s.image.created } : {}),
    detail,
  };
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

// —— REST 路由已收编到 base.ts ——
// `/api/base` + `/api/base/<action>` 是引擎无关的基座入口（docker=镜像，lxc=模板容器），
// build/pull/push 经 dockerEngine.runBaseAction 转发到本文件的函数。
// `/api/image*` 不再保留：唯一消费方是自家 web，同版本一起发布，留兼容别名只是养一份死代码。
// CLI 侧 `mysandbox image …` 仍作为 `base …` 的别名保留（写进文档和肌肉记忆了，见 cli.ts）。
