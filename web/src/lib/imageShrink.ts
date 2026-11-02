// 传图前端压缩：手机相册/截图动辄数 MB PNG——base64 再膨胀 4/3 后是「传图超时」（v0.15.19
// 把超时放到 120s）与服务端 12MB 解码上限（server/files.ts MAX_BINARY_BYTES）共同的根源。
// 下游主要是 claude 视觉通道，API 侧本来就会把图缩到长边 1568px——前端先重采样到同一规格
// 不损用途，体积通常降一个数量级（数 MB PNG → 百 KB 级 JPEG）。
// 策略：长边 ≤ maxEdge 且体积 ≤ keepUnder 原样放过；GIF 跳过（动画会被重编码抹掉）；
// 解码失败原样放过（让服务端 413/400 给出明确报错）；压完反而更大也放弃（罕见，防负优化）。

/** 长边上限：与 Anthropic 视觉 API 的内部重采样规格对齐，再大也是白传 */
const MAX_EDGE = 1568
/** 体积免压阈值：低于此值不值得一趟 canvas 重采样 */
const KEEP_UNDER = 2 * 1024 * 1024

export async function shrinkImage(file: File): Promise<File> {
  if (file.type === 'image/gif' || file.size <= KEEP_UNDER) return file
  let bmp: ImageBitmap
  try {
    // from-image：相册图常带 EXIF 旋转，canvas 重采样前必须先归位，否则横竖颠倒
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file // 解不动（HEIC 等浏览器不支持的格式）：原样交后端报错
  }
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height))
    const w = Math.round(bmp.width * scale)
    const h = Math.round(bmp.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    // JPEG 无 alpha：白底兜底（截图/照片不透明，纯防透明区变黑）
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bmp, 0, 0, w, h)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85))
    if (!blob || blob.size >= file.size) return file
    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
    return new File([blob], name, { type: 'image/jpeg' })
  } catch {
    return file // 压缩链路任何一环失败：退回原图，别让「优化」挡了上传
  } finally {
    bmp.close()
  }
}
