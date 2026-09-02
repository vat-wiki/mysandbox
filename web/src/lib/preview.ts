// 文件在线预览类型判定（纯前端关注点）：按扩展名映射 MIME 与预览形态。
// 覆盖浏览器原生能渲染的四大类（图片/视频/音频/PDF）；svg 刻意不进图片类——
// 它是文本，编辑器里改源码比看渲染结果更常用。二进制死胡同卡（不可编辑）只留给
// 没有任何预览形态的扩展名。
export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf'

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  pdf: 'application/pdf',
}

// 预览整文件进内存（Blob），给个硬顶防误点几个 GB 的录像把标签页打爆。
export const PREVIEW_MAX_BYTES = 100 * 1024 * 1024

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function previewMime(name: string): string | null {
  return EXT_MIME[extOf(name)] ?? null
}

export function previewKind(name: string): PreviewKind | null {
  const mime = previewMime(name)
  if (!mime) return null
  if (mime === 'application/pdf') return 'pdf'
  return mime.split('/')[0] as PreviewKind
}
