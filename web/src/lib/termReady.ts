// 终端会话就绪登记表（feedback #64）。
// 背景：终端「新建」时 tmux/msmux 会话要等 WS attach 完成才在服务端存在（实测几百 ms），
// 而文件面板跟随 / pane 头部 cwd 的轮询在此窗口内发出的查询注定 404（一发后自愈）。
// Terminal 收到服务端首帧（二进制终端流 = attach 已完成、会话必然存在）时在此登记
// termId，轮询方据此把「会话未就绪」的拍子静默跳过，不发注定失败的请求。
// 刻意用普通 Set 不用响应式：轮询方都是定时器驱动，下一拍自然能看到登记，无需触发更新。
// 只增不删：termId 一次性（每次新建都是新 id），残留条目可忽略；会话死掉后的 404
// 仍由轮询方自己的 miss 计数处理（这里不负责「已死」语义，只负责「尚未出生」）。

const ready = new Set<string>()

/** Terminal 收到服务端首帧（attach 完成）时登记。 */
export function markTermReady(termId: string): void {
  ready.add(termId)
}

/** 该终端会话是否已在服务端建好（至少收到过一帧输出）。 */
export function isTermReady(termId: string): boolean {
  return ready.has(termId)
}
