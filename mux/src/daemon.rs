//! 本地 Unix socket 守护，以及所有传输共用的请求循环。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use bytes::Bytes;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::{TcpStream, UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tokio_util::codec::{Framed, LengthDelimitedCodec};
use tracing::{debug, warn};

use crate::protocol::{BUILD_VERSION, Frame, PROTOCOL_VERSION, Request, Response};
use crate::session::{AttachGuard, Manager, SessionEvent};

const MAX_FRAME: usize = 64 * 1024 * 1024;

pub enum Conn {
    Unix(Framed<UnixStream, LengthDelimitedCodec>),
    Ws(Box<WebSocketStream<MaybeTlsStream<TcpStream>>>),
}

impl Conn {
    pub async fn send_frame(&mut self, frame: Frame) -> Result<()> {
        let bytes = frame.encode();
        match self {
            Self::Unix(framed) => framed.send(Bytes::from(bytes)).await.context("unix send")?,
            Self::Ws(ws) => ws
                .send(Message::Binary(bytes.into()))
                .await
                .context("ws send")?,
        }
        Ok(())
    }

    pub async fn recv_frame(&mut self) -> Option<Result<Frame>> {
        match self {
            Self::Unix(framed) => match framed.next().await {
                Some(Ok(bytes)) => Some(Frame::decode(&bytes).map_err(anyhow::Error::msg)),
                Some(Err(e)) => Some(Err(e.into())),
                None => None,
            },
            Self::Ws(ws) => match ws.next().await {
                Some(Ok(Message::Binary(bytes))) => {
                    Some(Frame::decode(&bytes).map_err(anyhow::Error::msg))
                }
                Some(Ok(Message::Text(text))) => {
                    let mut payload = Vec::with_capacity(1 + text.len());
                    payload.push(crate::protocol::KIND_JSON);
                    payload.extend_from_slice(text.as_bytes());
                    Some(Frame::decode(&payload).map_err(anyhow::Error::msg))
                }
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => Some(Ok(Frame::Ping)),
                Some(Ok(Message::Close(_))) | Some(Ok(Message::Frame(_))) => None,
                Some(Err(e)) => Some(Err(e.into())),
                None => None,
            },
        }
    }

    pub fn split(self) -> (ConnReader, ConnWriter) {
        match self {
            Self::Unix(framed) => {
                let (sink, stream) = framed.split();
                (ConnReader::Unix(stream), ConnWriter::Unix(sink))
            }
            Self::Ws(ws) => {
                let (sink, stream) = (*ws).split();
                (ConnReader::Ws(stream), ConnWriter::Ws(sink))
            }
        }
    }
}

pub enum ConnReader {
    Unix(SplitStream<Framed<UnixStream, LengthDelimitedCodec>>),
    Ws(SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>),
}

impl ConnReader {
    pub async fn next_frame(&mut self) -> Option<Result<Frame>> {
        match self {
            Self::Unix(stream) => match stream.next().await {
                Some(Ok(bytes)) => Some(Frame::decode(&bytes).map_err(anyhow::Error::msg)),
                Some(Err(e)) => Some(Err(e.into())),
                None => None,
            },
            Self::Ws(stream) => match stream.next().await {
                Some(Ok(Message::Binary(bytes))) => {
                    Some(Frame::decode(&bytes).map_err(anyhow::Error::msg))
                }
                Some(Ok(Message::Text(text))) => {
                    let mut payload = Vec::with_capacity(1 + text.len());
                    payload.push(crate::protocol::KIND_JSON);
                    payload.extend_from_slice(text.as_bytes());
                    Some(Frame::decode(&payload).map_err(anyhow::Error::msg))
                }
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => Some(Ok(Frame::Ping)),
                Some(Ok(Message::Close(_))) | Some(Ok(Message::Frame(_))) => None,
                Some(Err(e)) => Some(Err(e.into())),
                None => None,
            },
        }
    }
}

pub enum ConnWriter {
    Unix(SplitSink<Framed<UnixStream, LengthDelimitedCodec>, Bytes>),
    Ws(SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>),
}

impl ConnWriter {
    pub async fn send_frame(&mut self, frame: Frame) -> Result<()> {
        let bytes = frame.encode();
        match self {
            Self::Unix(sink) => sink.send(Bytes::from(bytes)).await.context("unix send")?,
            Self::Ws(sink) => sink
                .send(Message::Binary(bytes.into()))
                .await
                .context("ws send")?,
        }
        Ok(())
    }
}

struct AttachedState {
    cancel: watch::Sender<bool>,
    _guard: AttachGuard,
}

/// 本地或回连连接共用的请求循环。一个连接可以同时 attach 多个会话。
///
/// `ready` 在 hello 写出后触发：agent 用它区分「TCP/WS 握手成功」和「服务端
/// 真的接受了这条 mux 连接」。token 错误会在 upgrade 前被 HTTP 层拒绝，不过
/// 短时间内的异常关闭也能被这个信号覆盖。
pub async fn serve_conn(
    conn: Conn,
    manager: Arc<Manager>,
    role: &'static str,
    ready: Option<oneshot::Sender<()>>,
) -> Result<()> {
    let (mut reader, mut writer) = conn.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Frame>(1024);
    let writer_task = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if let Err(e) = writer.send_frame(frame).await {
                debug!("writer closed: {e}");
                break;
            }
        }
    });

    let hello = Response::Hello {
        version: PROTOCOL_VERSION,
        pid: std::process::id(),
        role: role.to_string(),
        app_version: Some(BUILD_VERSION.to_string()),
    };
    send_control(&out_tx, None, &hello).await;
    if let Some(ready) = ready {
        let _ = ready.send(());
    }

    let mut attached: HashMap<u32, AttachedState> = HashMap::new();
    loop {
        let Some(frame) = reader.next_frame().await else {
            break;
        };
        let frame = match frame {
            Ok(frame) => frame,
            Err(e) => {
                send_event(
                    &out_tx,
                    &Response::Error {
                        message: e.to_string(),
                    },
                )
                .await;
                break;
            }
        };

        match frame {
            Frame::Ping => {
                if out_tx.send(Frame::Ping).await.is_err() {
                    break;
                }
            }
            Frame::Data { sid, data } => {
                if !attached.contains_key(&sid) {
                    continue;
                }
                if let Some(session) = manager.get_by_id(sid)
                    && let Err(e) = session.write_input(&data)
                {
                    warn!("pty input failed: {e}");
                }
            }
            Frame::Json(payload) => {
                let (req_id, parsed) = parse_request(&payload);
                let req: Request = match parsed {
                    Ok(req) => req,
                    Err(e) => {
                        send_control(
                            &out_tx,
                            req_id,
                            &Response::Error {
                                message: e.to_string(),
                            },
                        )
                        .await;
                        continue;
                    }
                };
                match req {
                    Request::Hello { .. } => {
                        send_control(&out_tx, req_id, &hello).await;
                    }
                    Request::List => {
                        send_control(
                            &out_tx,
                            req_id,
                            &Response::Sessions {
                                sessions: manager.list(),
                            },
                        )
                        .await;
                    }
                    req @ Request::New { .. } => match manager.create(req) {
                        Ok(info) => {
                            send_control(
                                &out_tx,
                                req_id,
                                &Response::Ok {
                                    message: Some(format!("created {} ({})", info.name, info.id)),
                                },
                            )
                            .await;
                        }
                        Err(e) => send_error(&out_tx, req_id, e).await,
                    },
                    Request::Attach {
                        name,
                        cols,
                        rows,
                        resume,
                    } => {
                        let Some(session) = manager.get(&name) else {
                            send_error(&out_tx, req_id, anyhow::anyhow!("no such session: {name}"))
                                .await;
                            continue;
                        };
                        match session.attach(cols, rows, resume) {
                            Ok(mut attached_session) => {
                                let sid = attached_session.sid;
                                let name = attached_session.name.clone();
                                let (cancel_tx, cancel_rx) = watch::channel(false);
                                let out = out_tx.clone();
                                let manager = Arc::clone(&manager);
                                let resp = Response::Attached {
                                    sid,
                                    name: attached_session.name,
                                    cols: attached_session.cols,
                                    rows: attached_session.rows,
                                    history: base64::engine::general_purpose::STANDARD
                                        .encode(&attached_session.history),
                                    history_encoding: "base64".into(),
                                    modes: base64::engine::general_purpose::STANDARD
                                        .encode(&attached_session.modes),
                                    last_seq: attached_session.last_seq,
                                    title: attached_session.title,
                                    cwd: attached_session.cwd,
                                    foreground: attached_session.foreground,
                                };
                                send_control(&out_tx, req_id, &resp).await;
                                // 首次 attach：当前屏紧跟应答作为本连接首个数据帧——前端把
                                // history 推进 scrollback 后视口为空，这里把 attach 时刻的
                                // 屏幕画回去（与 tmux 的整屏重绘同构；时序在 output_task
                                // 订阅的事件回放之前，保证「快照 → 后续增量」顺序）。
                                if !resume && !attached_session.screen.is_empty() {
                                    let _ = out_tx
                                        .send(Frame::data(sid, std::mem::take(
                                            &mut attached_session.screen,
                                        )))
                                        .await;
                                }
                                tokio::spawn(output_task(
                                    manager,
                                    sid,
                                    name,
                                    attached_session.last_seq,
                                    attached_session.rx,
                                    out,
                                    cancel_rx,
                                ));
                                attached.insert(
                                    sid,
                                    AttachedState {
                                        cancel: cancel_tx,
                                        _guard: attached_session.guard,
                                    },
                                );
                            }
                            Err(e) => send_error(&out_tx, req_id, e).await,
                        }
                    }
                    Request::Resize { sid, cols, rows } => {
                        if let Some(session) = manager.get_by_id(sid)
                            && let Err(e) = session.resize(cols, rows)
                        {
                            send_error(&out_tx, req_id, e).await;
                        }
                    }
                    Request::Detach { sid } => {
                        if let Some(state) = attached.remove(&sid) {
                            let _ = state.cancel.send(true);
                            send_control(
                                &out_tx,
                                req_id,
                                &Response::Ok {
                                    message: Some("detached".into()),
                                },
                            )
                            .await;
                        }
                    }
                    Request::Capture {
                        name,
                        ansi,
                        max_lines,
                    } => {
                        let Some(session) = manager.get(&name) else {
                            send_error(&out_tx, req_id, anyhow::anyhow!("no such session: {name}"))
                                .await;
                            continue;
                        };
                        let (bytes, seq) = session.capture(ansi, max_lines);
                        send_control(
                            &out_tx,
                            req_id,
                            &Response::Captured {
                                name,
                                text: base64::engine::general_purpose::STANDARD.encode(bytes),
                                encoding: "base64".into(),
                                seq,
                            },
                        )
                        .await;
                    }
                    Request::Kill { name } => {
                        if manager.kill(&name) {
                            send_control(
                                &out_tx,
                                req_id,
                                &Response::Ok {
                                    message: Some(format!("killed {name}")),
                                },
                            )
                            .await;
                        } else {
                            send_error(&out_tx, req_id, anyhow::anyhow!("no such session: {name}"))
                                .await;
                        }
                    }
                    Request::Rename { from, to } => match manager.rename(&from, &to) {
                        Ok(()) => {
                            send_control(
                                &out_tx,
                                req_id,
                                &Response::Ok {
                                    message: Some(format!("renamed {from} -> {to}")),
                                },
                            )
                            .await;
                        }
                        Err(e) => send_error(&out_tx, req_id, e).await,
                    },
                    Request::Ping => {
                        send_control(
                            &out_tx,
                            req_id,
                            &Response::Ok {
                                message: Some("pong".into()),
                            },
                        )
                        .await;
                    }
                }
            }
        }
    }

    for state in attached.drain().map(|(_, state)| state) {
        let _ = state.cancel.send(true);
    }
    drop(out_tx);
    let _ = writer_task.await;
    Ok(())
}

async fn output_task(
    manager: Arc<Manager>,
    sid: u32,
    name: String,
    mut last_seq: u64,
    mut rx: tokio::sync::broadcast::Receiver<SessionEvent>,
    out: mpsc::Sender<Frame>,
    mut cancel: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            changed = cancel.changed() => {
                if changed.is_err() || *cancel.borrow() { break; }
            }
            event = rx.recv() => match event {
                Ok(SessionEvent::Output { seq, data }) => {
                    if seq <= last_seq { continue; }
                    if out.send(Frame::data(sid, data)).await.is_err() { break; }
                }
                Ok(SessionEvent::Title { title }) => {
                    let _ = send_event(&out, &Response::Title { sid, title }).await;
                }
                Ok(SessionEvent::Cwd { cwd }) => {
                    let _ = send_event(&out, &Response::Cwd { sid, cwd }).await;
                }
                Ok(SessionEvent::Foreground { foreground }) => {
                    let _ = send_event(&out, &Response::Foreground { sid, foreground }).await;
                }
                Ok(SessionEvent::Exit { code }) => {
                    let _ = send_event(&out, &Response::Exit { sid, name, code }).await;
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    // 事件缓冲被打爆（链路慢/浏览器跟不上）：以前直接 break，输出永久停在
                    // 这一帧而浏览器 socket 还开着 → 界面静默冻结、只能手动刷新。这里改成
                    // 原地重绘（真实状态在 vt100 模型里），锚点推到当前 seq 后继续收增量。
                    warn!(sid, lagged = n, "output lagged; resyncing screen");
                    let Some(session) = manager.get_by_id(sid) else {
                        break;
                    };
                    let (seq, bytes) = session.resync();
                    if out.send(Frame::data(sid, bytes)).await.is_err() {
                        break;
                    }
                    last_seq = seq;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }
}

/// 控制响应：请求带 `id` 时原样回带，调用方按 id 关联；事件帧不带 id。
async fn send_control(out: &mpsc::Sender<Frame>, id: Option<u64>, response: &Response) {
    let mut value = match serde_json::to_value(response) {
        Ok(value) => value,
        Err(_) => return,
    };
    if let Some(id) = id
        && let Some(obj) = value.as_object_mut()
    {
        obj.insert("id".into(), serde_json::json!(id));
    }
    if let Ok(frame) = Frame::json(&value) {
        let _ = out.send(frame).await;
    }
}

async fn send_event(out: &mpsc::Sender<Frame>, response: &Response) {
    if let Ok(frame) = Frame::json(response) {
        let _ = out.send(frame).await;
    }
}

async fn send_error(out: &mpsc::Sender<Frame>, id: Option<u64>, error: anyhow::Error) {
    send_control(
        out,
        id,
        &Response::Error {
            message: error.to_string(),
        },
    )
    .await;
}

pub async fn run_daemon(path: PathBuf, manager: Arc<Manager>) -> Result<()> {
    prepare_socket(&path).await?;
    let listener = UnixListener::bind(&path).with_context(|| format!("bind {}", path.display()))?;
    set_socket_permissions(&path)?;
    tracing::info!(socket = %path.display(), "msmux daemon listening");

    loop {
        let (stream, _) = listener.accept().await?;
        let manager = Arc::clone(&manager);
        tokio::spawn(async move {
            let codec = LengthDelimitedCodec::builder()
                .max_frame_length(MAX_FRAME)
                .new_codec();
            let framed = Framed::new(stream, codec);
            if let Err(e) = serve_conn(Conn::Unix(framed), manager, "daemon", None).await {
                debug!("unix connection closed: {e}");
            }
        });
    }
}

/// 解析控制请求，并把 envelope 里的 `id` 摘出来。
///
/// id 放在协议外层而不是每个 Request 变体上：老客户端不带 id 仍然可用，
/// Request/Response 的 serde 形状保持稳定。
fn parse_request(payload: &[u8]) -> (Option<u64>, Result<Request, String>) {
    let mut value: Value = match serde_json::from_slice(payload) {
        Ok(value) => value,
        Err(e) => return (None, Err(format!("bad json: {e}"))),
    };
    let id = value.get("id").and_then(Value::as_u64);
    if let Some(obj) = value.as_object_mut() {
        obj.remove("id");
    }
    (
        id,
        serde_json::from_value(value).map_err(|e| format!("bad json: {e}")),
    )
}

pub async fn connect_unix(path: &Path) -> Result<Conn> {
    let stream = UnixStream::connect(path)
        .await
        .with_context(|| format!("connect {}", path.display()))?;
    let codec = LengthDelimitedCodec::builder()
        .max_frame_length(MAX_FRAME)
        .new_codec();
    Ok(Conn::Unix(Framed::new(stream, codec)))
}

async fn prepare_socket(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    if path.exists() {
        match UnixStream::connect(path).await {
            Ok(_) => bail!("msmux daemon already running at {}", path.display()),
            Err(_) => {
                std::fs::remove_file(path)
                    .with_context(|| format!("remove stale {}", path.display()))?;
            }
        }
    }
    Ok(())
}

fn set_socket_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
