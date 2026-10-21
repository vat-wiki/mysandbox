// web 终端剪贴板桥的容器侧 shim：AI CLI（claude 等）在本容器里调 xclip/wl-paste 读
// 「系统剪贴板」——无头容器没有 X/Wayland，真工具必然失败。这里铺两个同名 shim 进
// ~/.local/bin（PATH 首位，见 container-cli.ts 文件头），把 CLI 的调用转发到宿主：
// 浏览器剪贴板（web 终端 Ctrl+V 时前端读到并推送，routes.ts /api/terminal-clipboard）
// → peer API GET /clipboard（peer.ts，暂存区 terminalClipboard.ts）→ shim 吐给 CLI。
//
// 语义逐字对齐 claude 的调用链（对本机二进制 strings 核实）：
//   探测: xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)"
//         （wl-paste 分支: wl-paste -l）
//   取图: xclip -selection clipboard -t image/png -o > 临时文件（失败再试 bmp 链）
//   取文: xclip -selection clipboard -t text/plain -o 2>/dev/null || wl-paste
// 前端推送前统一把图片转成 PNG（浏览器剪贴板可能是 jpeg/webp），所以 shim 只需供 png。
//
// 种子语义同 container-cli.ts：内容变就覆盖，用户手改会被刷掉（刻意的）。
export const CLIP_CORE_SCRIPT = `#!/usr/bin/env node
// mysandbox 剪贴板桥内核（宿主 mysandbox 种子写入，内容变更会自动覆盖——勿手改）。
// xclip / wl-paste 两个 shim 薄壳都转发到这里；数据来自宿主 peer API。
import { readFileSync } from 'node:fs';
import http from 'node:http';

const NL = String.fromCharCode(10);
const home = process.env.HOME || '/home/dev';
const tool = process.argv[2];
const args = process.argv.slice(3);

function fail(msg) {
  if (msg) process.stderr.write('mysandbox clip: ' + msg + NL);
  process.exit(1);
}

// peer.json 读不到 = peer 未启用/宿主没跑 = 没有剪贴板，静默 exit 1（CLI 走降级链）。
let peer;
try {
  peer = JSON.parse(readFileSync(home + '/.config/mysandbox/peer.json', 'utf8'));
} catch {
  fail();
}

function fetchClipboard() {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(peer.url); } catch { reject(new Error('bad peer url')); return; }
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: '/clipboard',
      method: 'GET',
      headers: { 'x-peer-token': peer.token || '' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 404) { resolve(null); return; }
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('bad json')); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// 参数归一（顺序无关；CC 的调用形状固定，宽容一点防用户脚本换序）。
let out = false;
let list = false;
let wantType = null;
let selection = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') out = true;
  else if (a === '-l') list = true;
  else if (a === '-t' || a === '--type') wantType = args[++i] || null;
  else if (a === '-selection' || a === '--selection') selection = args[++i] || null;
  else if (a.indexOf('=') > 0 && (a.startsWith('-t=') || a.startsWith('--type='))) wantType = a.slice(a.indexOf('=') + 1);
  else if (a.indexOf('=') > 0 && (a.startsWith('-selection=') || a.startsWith('--selection='))) selection = a.slice(a.indexOf('=') + 1);
}

fetchClipboard().then((payload) => {
  const text = payload && typeof payload.text === 'string' ? payload.text : null;
  const img = payload && payload.image && typeof payload.image.b64 === 'string' ? payload.image : null;
  // wl-paste -l / xclip -t TARGETS 的类型清单（CC 只 grep image/，其余是礼节项）。
  const types = ['TARGETS', 'MULTIPLE', 'UTF8_STRING', 'COMPOUND_TEXT', 'TEXT', 'STRING', 'text/plain'];
  if (img) types.push(img.mime);
  const isTextType = (t) => t == null || t === 'text/plain' || t.startsWith('text/plain;') ||
    t === 'TEXT' || t === 'UTF8_STRING' || t === 'STRING' || t === 'COMPOUND_TEXT';

  if (tool === 'xclip') {
    // 只支持读（-o）：写剪贴板按失败处理——容器没有 X 剪贴板可写，终端内复制走
    // OSC 52（Terminal.vue + tmux set-clipboard 已通），CLI 的 /copy 也有文本兜底。
    if (!out || list) fail();
    if (selection && selection !== 'clipboard') fail();  // 只桥 CLIPBOARD
    if (wantType === 'TARGETS') {
      if (!text && !img) fail();
      process.stdout.write(types.join(NL) + NL);
      return;
    }
    if (img && wantType === img.mime) {
      process.stdout.write(Buffer.from(img.b64, 'base64'));
      return;
    }
    if (isTextType(wantType)) {
      if (text == null) fail();
      process.stdout.write(text);
      return;
    }
    fail();
  } else if (tool === 'wl-paste') {
    if (list) {
      if (!text && !img) fail();
      const mimeTypes = types.filter((t) => t === 'text/plain' || t.startsWith('image/'));
      process.stdout.write(mimeTypes.join(NL) + NL);
      return;
    }
    if (img && wantType === img.mime) {
      process.stdout.write(Buffer.from(img.b64, 'base64'));
      return;
    }
    if (isTextType(wantType)) {
      if (text == null) fail();
      process.stdout.write(text);
      return;
    }
    fail();
  } else {
    fail('unknown tool ' + tool);
  }
}).catch(() => fail());
`;

// 两个薄壳：sh exec node（PATH 首位的 ~/.local/bin 命中它们，真 xclip 永远轮不到——
// 模板镜像不装 xclip；用户后装了也会被 shim 遮住，这是刻意的：容器里「系统剪贴板」
// 只有一个真相源，就是桥）。
export const XCLIP_SHIM_SCRIPT = `#!/bin/sh
# mysandbox 剪贴板桥 shim（宿主 mysandbox 种子写入，内容变更会自动覆盖——勿手改）。
# claude 等 AI CLI 调 xclip 读剪贴板；无头容器没有 X，这里转发给宿主的浏览器剪贴板。
exec node "\${HOME:-/home/dev}/.config/mysandbox/clip.mjs" xclip "$@"
`;

export const WLPASTE_SHIM_SCRIPT = `#!/bin/sh
# mysandbox 剪贴板桥 shim（宿主 mysandbox 种子写入，内容变更会自动覆盖——勿手改）。
# 同 xclip shim：wl-paste 形状的调用转发给宿主的浏览器剪贴板。
exec node "\${HOME:-/home/dev}/.config/mysandbox/clip.mjs" wl-paste "$@"
`;
