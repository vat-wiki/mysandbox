// web 终端剪贴板桥的暂存区（进程内单槽）：前端 Ctrl+V 手势里读到浏览器剪贴板（图片
// + 文本）推上来，容器内种子 shim（xclip/wl-paste，见 clipShim.ts）在 AI CLI 触发
// ^V 后经 peer API（GET /clipboard）取走——CLI 走的是它自己的原生剪贴板读取路径，
// 体验与真机一致（[Image #1] 内联）。
//
// 单槽「最新者赢」：系统剪贴板本就是每机一份的全局语义；前端在每次转发 ^V 前先推，
// 两个终端窗口竞争的窗口期 ~百毫秒级，后推者覆盖前者的场景可忽略。TTL 兜底清掉
// 「推了但 CLI 没来取」的残留（^V 发给了普通 shell / CLI 没装 shim）。刻意不持久化。
const TTL_MS = 120_000;

// 与文件端点 MAX_BINARY_BYTES 同量级：解码后 ≤12MB，base64 后 ~16MB。
const MAX_IMAGE_B64 = 16 * 1024 * 1024;
const MAX_TEXT = 2 * 1024 * 1024;

export interface TerminalClipboardPayload {
  // 前端 canvas 统一转成 PNG 再推（CC 的取图链只认 png/bmp，jpeg 等就近转化）。
  image?: { mime: 'image/png'; b64: string };
  text?: string;
}

interface Store {
  ts: number;
  payload: TerminalClipboardPayload;
}

let slot: Store | undefined;

export function putTerminalClipboard(payload: TerminalClipboardPayload): void {
  if (payload.image && payload.image.b64.length > MAX_IMAGE_B64) {
    throw new Error('image too large');
  }
  if (payload.text && payload.text.length > MAX_TEXT) {
    throw new Error('text too large');
  }
  slot = { ts: Date.now(), payload };
}

// 过期 / 不存在返回 null（shim 侧按取不到处理，exit 1 走 CLI 自己的降级链）。
export function getTerminalClipboard(): TerminalClipboardPayload | null {
  if (!slot) return null;
  if (Date.now() - slot.ts > TTL_MS) {
    slot = undefined;
    return null;
  }
  return slot.payload;
}
