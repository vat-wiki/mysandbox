//! msmux：可携带的会话守护与回连客户端。
//!
//! 子命令分三类：
//! - `daemon`：目标侧常驻，Unix socket 提供会话；
//! - `new/ls/attach/capture/kill/rename`：本地 CLI；
//! - `agent`：主动回连 mysandbox，让远端目标无需暴露入站端口。

use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use base64::Engine as _;
use clap::{Parser, Subcommand};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

use msmux::agent::run_agent;
use msmux::daemon::{Conn, connect_unix, run_daemon};
use msmux::protocol::{Frame, PROTOCOL_VERSION, Request, Response};
use msmux::session::{Manager, socket_path};

#[derive(Parser)]
#[command(
    name = "msmux",
    version,
    about = "Portable session multiplexer for mysandbox"
)]
struct Cli {
    /// daemon socket path（缺省：$XDG_RUNTIME_DIR/msmux/msmux.sock）
    #[arg(long, global = true)]
    socket: Option<String>,
    #[command(subcommand)]
    cmd: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 前台运行本地会话守护
    Daemon,
    /// 新建会话
    New {
        name: String,
        #[arg(long)]
        cwd: Option<String>,
        #[arg(long, default_value_t = 120)]
        cols: u16,
        #[arg(long, default_value_t = 40)]
        rows: u16,
        /// 目标命令，缺省为 $SHELL 或 /bin/sh
        #[arg(last = true)]
        argv: Vec<String>,
    },
    /// 列出会话
    Ls {
        #[arg(long)]
        json: bool,
    },
    /// attach 会话；Ctrl-] 本地 detach
    Attach { name: String },
    /// 导出屏幕与 scrollback
    Capture {
        name: String,
        /// 保留 ANSI 颜色与光标状态
        #[arg(long)]
        ansi: bool,
        #[arg(long, default_value_t = 10000)]
        max_lines: usize,
    },
    /// 结束会话
    Kill { name: String },
    /// 重命名会话
    Rename { from: String, to: String },
    /// 回连 mysandbox（目标侧无需监听端口）
    Agent {
        #[arg(long)]
        url: String,
        /// 目标派生 token；不传时用 --token-file（避免 token 出现在 ps 命令行）
        #[arg(long)]
        token: Option<String>,
        #[arg(long)]
        token_file: Option<PathBuf>,
        #[arg(long, default_value = "default")]
        target: String,
    },
    /// 打印协议版本
    Version,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "msmux=info".into()),
        )
        .with_target(false)
        .init();

    let cli = Cli::parse();
    let socket = socket_path(cli.socket);
    match cli.cmd {
        Command::Daemon => {
            let manager = Arc::new(Manager::new(50_000));
            match run_daemon(socket, manager).await {
                Ok(()) => Ok(()),
                // 已有 daemon 占着 socket（部署的 unit 与 agent 兜底撞车）：按正常退出处理，
                // 别让 Restart=on-failure 反复重启抢 socket。
                Err(e) if e.to_string().contains("already running") => {
                    eprintln!("msmux daemon already running; exiting");
                    Ok(())
                }
                Err(e) => Err(e),
            }
        }
        Command::New {
            name,
            cwd,
            cols,
            rows,
            argv,
        } => {
            let argv = if argv.is_empty() {
                vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())]
            } else {
                argv
            };
            let mut conn = connect_unix(&socket).await?;
            let resp = request_once(
                &mut conn,
                &Request::New {
                    name,
                    cwd,
                    argv,
                    env: vec![],
                    cols,
                    rows,
                },
            )
            .await?;
            print_ok(resp)?;
            Ok(())
        }
        Command::Ls { json } => {
            let mut conn = connect_unix(&socket).await?;
            let resp = request_once(&mut conn, &Request::List).await?;
            match resp {
                Response::Sessions { sessions } => {
                    if json {
                        println!("{}", serde_json::to_string_pretty(&sessions)?);
                    } else if sessions.is_empty() {
                        println!("no sessions");
                    } else {
                        println!(
                            "{:<4} {:<32} {:>4} {:<10} TITLE/CWD",
                            "ID", "NAME", "ATT", "SIZE"
                        );
                        for s in sessions {
                            let label = if !s.title.is_empty() { s.title } else { s.cwd };
                            println!(
                                "{:<4} {:<32} {:>4} {:<10} {}",
                                s.id,
                                s.name,
                                s.attached,
                                format!("{}x{}", s.cols, s.rows),
                                label
                            );
                        }
                    }
                    Ok(())
                }
                other => print_ok(other),
            }
        }
        Command::Attach { name } => attach(socket, name).await,
        Command::Capture {
            name,
            ansi,
            max_lines,
        } => {
            let mut conn = connect_unix(&socket).await?;
            let resp = request_once(
                &mut conn,
                &Request::Capture {
                    name,
                    ansi,
                    max_lines,
                },
            )
            .await?;
            match resp {
                Response::Captured { text, .. } => {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(text)
                        .context("bad base64 capture")?;
                    std::io::stdout().write_all(&bytes)?;
                    Ok(())
                }
                other => print_ok(other),
            }
        }
        Command::Kill { name } => {
            let mut conn = connect_unix(&socket).await?;
            print_ok(request_once(&mut conn, &Request::Kill { name }).await?)
        }
        Command::Rename { from, to } => {
            let mut conn = connect_unix(&socket).await?;
            print_ok(request_once(&mut conn, &Request::Rename { from, to }).await?)
        }
        Command::Agent {
            url,
            token,
            token_file,
            target,
        } => {
            let token = match token {
                Some(token) => token,
                None => match token_file {
                    Some(path) => tokio::fs::read_to_string(&path)
                        .await
                        .with_context(|| format!("read token file {}", path.display()))?
                        .trim()
                        .to_string(),
                    None => anyhow::bail!("agent 需要 --token 或 --token-file"),
                },
            };
            if token.is_empty() {
                anyhow::bail!("agent token 为空");
            }
            // 会话归独立 daemon 进程所有（agent 只转发帧）：agent 重启不再带走会话。
            run_agent(url, token, target, socket).await
        }
        Command::Version => {
            println!("msmux protocol {}", PROTOCOL_VERSION);
            Ok(())
        }
    }
}

fn print_ok(resp: Response) -> Result<()> {
    match resp {
        Response::Ok { message } => {
            if let Some(message) = message {
                println!("{message}");
            }
            Ok(())
        }
        Response::Error { message } => anyhow::bail!(message),
        other => {
            println!("{}", serde_json::to_string_pretty(&other)?);
            Ok(())
        }
    }
}

async fn request_once(conn: &mut Conn, request: &Request) -> Result<Response> {
    conn.send_frame(Frame::json(request)?).await?;
    loop {
        let Some(frame) = conn.recv_frame().await else {
            anyhow::bail!("daemon closed the connection");
        };
        let frame = frame?;
        match frame {
            Frame::Json(_) => {
                let resp: Response = frame.as_json().map_err(anyhow::Error::msg)?;
                match resp {
                    Response::Error { message } => anyhow::bail!(message),
                    Response::Hello { .. } => continue,
                    other => return Ok(other),
                }
            }
            Frame::Ping => continue,
            Frame::Data { .. } => continue,
        }
    }
}

async fn attach(socket: PathBuf, name: String) -> Result<()> {
    let conn = connect_unix(&socket).await?;
    let (mut reader, mut writer) = conn.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Frame>(256);
    let writer_task = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if writer.send_frame(frame).await.is_err() {
                break;
            }
        }
    });

    let (cols, rows) = crossterm::terminal::size().unwrap_or((120, 40));
    out_tx
        .send(Frame::json(&Request::Attach {
            name: name.clone(),
            cols,
            rows,
            resume: false,
        })?)
        .await?;

    let attached = loop {
        let Some(frame) = reader.next_frame().await else {
            anyhow::bail!("daemon closed before attach");
        };
        let frame = frame?;
        match frame {
            Frame::Json(_) => {
                let resp: Response = match frame.as_json() {
                    Ok(resp) => resp,
                    Err(e) => anyhow::bail!(e),
                };
                match resp {
                    Response::Attached {
                        sid,
                        name: attached_name,
                        cols,
                        rows,
                        history,
                        last_seq,
                        title,
                        cwd,
                        foreground,
                        ..
                    } => {
                        break (
                            sid,
                            attached_name,
                            cols,
                            rows,
                            history,
                            last_seq,
                            title,
                            cwd,
                            foreground,
                        );
                    }
                    Response::Error { message } => anyhow::bail!(message),
                    _ => continue,
                }
            }
            Frame::Ping => continue,
            Frame::Data { .. } => continue,
        }
    };

    let (
        sid,
        _attached_name,
        attached_cols,
        attached_rows,
        history,
        _last_seq,
        title,
        cwd,
        foreground,
    ) = attached;
    let history = base64::engine::general_purpose::STANDARD
        .decode(history)
        .context("bad base64 history")?;
    let mut stdout = std::io::stdout();
    stdout.write_all(&history)?;
    stdout.flush()?;
    let _ = crossterm::terminal::enable_raw_mode();
    let _ = (attached_cols, attached_rows, title, cwd, foreground);

    let input_tx = out_tx.clone();
    let input_task = tokio::spawn(async move {
        let mut stdin = tokio::io::stdin();
        let mut buf = [0u8; 8192];
        loop {
            match stdin.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    if let Some(pos) = chunk.iter().position(|b| *b == 0x1d) {
                        if pos > 0 {
                            let _ = input_tx.send(Frame::data(sid, chunk[..pos].to_vec())).await;
                        }
                        let _ = input_tx
                            .send(Frame::json(&Request::Detach { sid }).unwrap_or(Frame::Ping))
                            .await;
                        break;
                    }
                    if input_tx
                        .send(Frame::data(sid, chunk.to_vec()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });

    let resize_tx = out_tx.clone();
    let resize_task = tokio::spawn(async move {
        let mut sig =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change()) {
                Ok(sig) => sig,
                Err(_) => return,
            };
        while sig.recv().await.is_some() {
            let (cols, rows) = crossterm::terminal::size().unwrap_or((120, 40));
            let _ = resize_tx
                .send(Frame::json(&Request::Resize { sid, cols, rows }).unwrap_or(Frame::Ping))
                .await;
        }
    });

    let mut stdout = std::io::stdout();
    let result = loop {
        let Some(frame) = reader.next_frame().await else {
            break Ok(());
        };
        match frame {
            Ok(Frame::Data { sid: got, data }) => {
                if got != sid {
                    continue;
                }
                if let Err(e) = stdout.write_all(&data).and_then(|_| stdout.flush()) {
                    break Err(e.into());
                }
            }
            Ok(Frame::Ping) => {
                let _ = out_tx.send(Frame::Ping).await;
            }
            Ok(Frame::Json(payload)) => {
                let resp: Response = match serde_json::from_slice(&payload) {
                    Ok(resp) => resp,
                    Err(_) => continue,
                };
                match resp {
                    Response::Exit { code, .. } => {
                        let _ = crossterm::terminal::disable_raw_mode();
                        eprintln!("\r\n[msmux] session exited ({code:?})");
                        break Ok(());
                    }
                    Response::Error { message } => {
                        let _ = crossterm::terminal::disable_raw_mode();
                        break Err(anyhow::anyhow!(message));
                    }
                    Response::Ok { .. } => break Ok(()),
                    Response::Title { .. } => {}
                    _ => {}
                }
            }
            Err(e) => break Err(e),
        }
    };
    let _ = crossterm::terminal::disable_raw_mode();
    input_task.abort();
    resize_task.abort();
    drop(out_tx);
    let _ = writer_task.await;
    result
}
