//! 回连客户端：目标侧不监听端口，主动连到 mysandbox 的 /ws/mux-agent。
//!
//! 连接断开只影响控制流；会话仍在本地 Manager 里活着，重连后继续可用。

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use http::HeaderValue;
use tokio::sync::oneshot;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tracing::{info, warn};

use crate::daemon::{Conn, serve_conn};
use crate::session::Manager;

pub async fn run_agent(
    url: String,
    token: String,
    target: String,
    manager: Arc<Manager>,
) -> Result<()> {
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
