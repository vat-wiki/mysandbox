//! 回连客户端：目标侧不监听 TCP 端口，主动连到 mysandbox 的 /ws/mux-agent。
//!
//! 连接断开只影响控制流；会话仍在本地 Manager 里活着，重连后继续可用。
//! 除回连外，agent 同时在本机 Unix socket（daemon 同款路径）上服务本地控制请求——
//! `msmux ls / kill / attach` 在目标侧随时可用，回连断开时宿主也能经 exec 通道枚举
//! 会话（tmux 的「查询时问源头」语义，见 server/muxAgent.ts 的离线枚举）。

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use http::HeaderValue;
use tokio::sync::oneshot;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tracing::{info, warn};

use crate::daemon::{Conn, run_daemon, serve_conn};
use crate::session::{Manager, socket_path};

pub async fn run_agent(
    url: String,
    token: String,
    target: String,
    manager: Arc<Manager>,
) -> Result<()> {
    // 本地控制 socket 与回连并存，共享同一个 Manager。绑定失败（残留 socket 且真有
    // 别的 daemon 在跑、权限问题等）只降级为「无本地入口」，不拖累回连主路径；残留的
    // 死 socket 由 run_daemon 的 prepare_socket 自行清理。
    {
        let manager = Arc::clone(&manager);
        tokio::spawn(async move {
            if let Err(e) = run_daemon(socket_path(None), manager).await {
                warn!("local control socket unavailable: {e}");
            }
        });
    }
    loop {
        match connect_once(&url, &token, &target).await {
            Ok(ws) => {
                let (ready_tx, ready_rx) = oneshot::channel();
                let mut serve = Box::pin(serve_conn(
                    Conn::Ws(Box::new(ws)),
                    Arc::clone(&manager),
                    "agent",
                    Some(ready_tx),
                ));
                tokio::select! {
                    result = &mut serve => {
                        if let Err(e) = result {
                            warn!("agent connection ended before hello: {e}");
                        }
                    }
                    ready = ready_rx => {
                        if ready.is_ok() {
                            info!(url = %url, target = %target, "msmux agent connected");
                        }
                        if let Err(e) = serve.await {
                            warn!("agent connection ended: {e}");
                        }
                    }
                }
            }
            Err(e) => warn!("agent connect failed: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
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
