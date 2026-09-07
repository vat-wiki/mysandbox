// 自签名 TLS 材料：本地 CA（10y）+ 泛域名叶子证书（825d），落 STATE_DIR/tls/。
//
// 信任模型：**CA 是唯一信任锚**——导入一次浏览器/系统信任库，控制台与所有 vhost
// 子域（*.mysandbox.test、*.sslip 基、IP 直连）全部免警告；裸自签名证书做不到这点
// （每个子域一条信任记录），所以必须是 CA + 叶子两级。
// 叶子按 SAN 集合与有效期惰性重签（SAN 变化 / 30d 内到期才动），CA 生成后永不变，
// 导入一次终身有效。openssl 由 PATH 提供（宿主必有；mysandbox 以用户身份跑，无需 root）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';
import { STATE_DIR } from './config.js';
import { proxyBases } from './proxy.js';
import { log } from './logger.js';

const pexec = promisify(execFile);
const TLS_DIR = join(STATE_DIR, 'tls');
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface TlsMaterial {
  key: string; // 叶子私钥 PEM（fastify https.key）
  cert: string; // 叶子证书 PEM（fastify https.cert）
  caPath: string; // CA 证书文件路径（浏览器/系统导入 + CLI fetch 用）
  caCert: string; // CA 证书 PEM（/tls-ca.crt 下载）
}

// SAN 集合：代理基域名（及其泛域名）+ 全部非 internal IPv4 + localhost/环回。
// proxyBases 含 mysandbox.test / sslip 基 / tailscale 基——IP 变了 SAN 跟着重签。
async function tlsSans(cfg: Config): Promise<string[]> {
  const set = new Set<string>(['localhost', '127.0.0.1']);
  for (const b of await proxyBases(cfg)) {
    set.add(b.base);
    set.add(`*.${b.base}`);
  }
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) set.add(a.address);
    }
  }
  if (IP_RE.test(cfg.listen.host)) set.add(cfg.listen.host);
  return [...set].sort();
}

const tlsFile = (name: string) => join(TLS_DIR, name);

async function genCa(): Promise<void> {
  await pexec('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
    '-keyout', tlsFile('ca.key'), '-out', tlsFile('ca.crt'),
    '-subj', '/CN=mysandbox local CA/O=mysandbox',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  log.info({ dir: TLS_DIR }, 'local CA generated');
}

async function genLeaf(cfg: Config, sans: string[]): Promise<void> {
  const cn = sans.find((s) => !s.startsWith('*') && !IP_RE.test(s)) ?? 'mysandbox';
  await pexec('openssl', [
    'req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', tlsFile('leaf.key'), '-out', tlsFile('leaf.csr'),
    '-subj', `/CN=${cn}/O=mysandbox`,
  ]);
  await writeFile(
    tlsFile('leaf.ext'),
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${sans.map((s) => (IP_RE.test(s) ? `IP:${s}` : `DNS:${s}`)).join(', ')}`,
      '',
    ].join('\n'),
  );
  await pexec('openssl', [
    'x509', '-req', '-in', tlsFile('leaf.csr'),
    '-CA', tlsFile('ca.crt'), '-CAkey', tlsFile('ca.key'), '-CAcreateserial',
    '-days', '825', '-sha256', '-extfile', tlsFile('leaf.ext'), '-out', tlsFile('leaf.crt'),
  ]);
  // 有效期记录用近似值（825d）足够驱动 30d 提前重签的判定。
  await writeFile(
    tlsFile('leaf.meta.json'),
    JSON.stringify({ sans, notAfter: new Date(Date.now() + 820 * 86400e3).toISOString() }, null, 2),
  );
  log.info({ cn, sans }, 'leaf certificate generated');
}

export async function ensureTlsMaterial(cfg: Config): Promise<TlsMaterial> {
  await mkdir(TLS_DIR, { recursive: true });
  if (!(await readFile(tlsFile('ca.crt'), 'utf8').then(() => true).catch(() => false))) {
    await genCa();
  }
  const sans = await tlsSans(cfg);
  let stale = !(await readFile(tlsFile('leaf.crt'), 'utf8').then(() => true).catch(() => false));
  if (!stale) {
    try {
      const meta = JSON.parse(await readFile(tlsFile('leaf.meta.json'), 'utf8')) as {
        sans: string[];
        notAfter: string;
      };
      stale =
        JSON.stringify(meta.sans) !== JSON.stringify(sans) ||
        Date.parse(meta.notAfter) - Date.now() < 30 * 86400e3;
    } catch {
      stale = true;
    }
  }
  if (stale) await genLeaf(cfg, sans);

  const [key, cert, caCert] = await Promise.all([
    readFile(tlsFile('leaf.key'), 'utf8'),
    readFile(tlsFile('leaf.crt'), 'utf8'),
    readFile(tlsFile('ca.crt'), 'utf8'),
  ]);
  return { key, cert, caPath: tlsFile('ca.crt'), caCert };
}
