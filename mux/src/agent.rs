//! 回连客户端：目标侧不监听 TCP 端口，主动连到 mysandbox 的 /ws/mux-agent。
//!
//! **会话宿主是独立的 daemon 进程，agent 只做 WS ↔ Unix socket 的帧转发**：重部署/
//! 升级/崩溃重启只影响控制通道，会话（PTY + vt100 屏幕模型）不会被 systemd 按 cgroup
//! 连带杀掉。此前 daemon 内嵌在 agent 进程里，agent 一重启全部会话消失。
//!
//! daemon 由部署装成独立 unit（host/LXC）或 nohup 独立进程（SSH/docker）；agent 启动
//! 时若本地 socket 上没有 daemon，会兜底拉起一个——systemd 下这个兜底仍落在 agent 的
//! cgroup 里，只适合手动运行 agent 的场景，正式部署以独立 unit 为准。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use http::HeaderValue;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tracing::{info, warn};

use crate::daemon::{Conn, connect_unix};

pub async fn run_agent(url: String, token: String, target: String, socket: PathBuf) -> Result<()> {
    let mut attempts = 0u32;
    loop {
        let daemon = match connect_unix(&socket).await {
            Ok(conn) => conn,
            Err(e) => {
                // 先让部署装的独立 daemon unit 有机会启动（它和 agent 由 systemd 同时拉起，
                // 抢着起两个 daemon 只会让后到的那个退出）。等 10s 还连不上才兜底拉起，
                // 之后每 30s 再试一次。
                if attempts >= 10 && attempts % 30 == 0 {
                    warn!(
                        socket = %socket.display(),
                        "msmux daemon not reachable ({e}); spawning one"
                    );
                    spawn_daemon(&socket);
                }
                attempts = attempts.wrapping_add(1);
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        match connect_once(&url, &token, &target).await {
            Ok(ws) => {
                info!(url = %url, target = %target, "msmux agent connected");
                if let Err(e) = bridge(Conn::Ws(Box::new(ws)), daemon).await {
                    warn!("agent connection ended: {e}");
                }
            }
            Err(e) => warn!("agent connect failed: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// 双向纯帧转发：两侧协议同形（WS 二进制帧 / Unix 长度前缀帧），解码成 Frame 后换
/// 一种编码写出，不需要理解业务语义。
async fn bridge(ws: Conn, daemon: Conn) -> Result<()> {
    let (mut ws_r, mut ws_w) = ws.split();
    let (mut d_r, mut d_w) = daemon.split();
    loop {
        tokio::select! {
            frame = ws_r.next_frame() => match frame {
                Some(Ok(frame)) => d_w.send_frame(frame).await.context("daemon write")?,
                Some(Err(e)) => bail!("ws frame: {e}"),
                None => return Ok(()),
            },
            frame = d_r.next_frame() => match frame {
                Some(Ok(frame)) => ws_w.send_frame(frame).await.context("ws write")?,
                Some(Err(e)) => bail!("daemon frame: {e}"),
                None => return Ok(()),
            },
        }
    }
}

/// 兜底拉起 daemon（正式部署走独立 unit / nohup，不依赖这里）。setsid 让 daemon 脱离
/// agent 的会话与进程组——agent 退出/被 kill 时不会跟着收 SIGHUP。
fn spawn_daemon(socket: &Path) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("--socket")
        .arg(socket)
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    match cmd.spawn() {
        Ok(child) => info!(socket = %socket.display(), pid = child.id(), "spawned msmux daemon"),
        Err(e) => warn!("spawn msmux daemon failed: {e}"),
    }
}

async fn connect_once(
    url: &str,
    token: &str,
    target: &str,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
> {
    let mut request = url
        .into_client_request()
        .with_context(|| format!("bad agent url: {url}"))?;
    let auth = HeaderValue::from_str(&format!("Bearer {token}")).context("invalid agent token")?;
    let sectoken = HeaderValue::from_str(token).context("invalid agent token")?;
    request.headers_mut().insert("authorization", auth);
    request.headers_mut().insert("x-sandbox-token", sectoken);
    let target = HeaderValue::from_str(target).context("invalid agent target")?;
    request.headers_mut().insert("x-msmux-target", target);
    let (ws, _) = connect_async(request).await.context("websocket connect")?;
    Ok(ws)
}
