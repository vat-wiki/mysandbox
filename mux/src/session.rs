//! 会话核心：PTY + VT 屏幕模型 + 多客户端广播。
//!
//! 这里刻意不实现 window/pane/键位。msmux 只需要复刻 tmux 的会话语义：
//! 客户端断开后 shell 继续跑，重新 attach 时把已渲染屏幕和 scrollback 写回。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU64, Ordering};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use parking_lot::{Mutex, RwLock};
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::broadcast;

use crate::protocol::{Request, SessionInfo};

const DEFAULT_SCROLLBACK: usize = 50_000;
const EVENT_BUFFER: usize = 1024;
const RESUME_HISTORY_LINES: usize = 2_000;

#[derive(Debug, Clone)]
pub enum SessionEvent {
    Output { seq: u64, data: Vec<u8> },
    Title { title: String },
    Cwd { cwd: String },
    Foreground { foreground: String },
    Exit { code: Option<u32> },
}

pub struct Session {
    pub id: u32,
    pub name: Mutex<String>,
    created_at: u64,
    cols: AtomicU16,
    rows: AtomicU16,
    attached: AtomicU32,
    seq: AtomicU64,
    alive: AtomicBool,
    exit_code: Mutex<Option<u32>>,
    screen: Mutex<vt100::Parser>,
    tx: broadcast::Sender<SessionEvent>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    default_cwd: String,
    default_command: String,
    last_title: Mutex<String>,
    last_cwd: Mutex<String>,
    last_foreground: Mutex<String>,
}

pub struct AttachedSession {
    pub sid: u32,
    pub name: String,
    pub cols: u16,
    pub rows: u16,
    /// scrollback 历史（每行带 \n）。**不含当前屏**——当前屏经 `screen` 单独走
    /// attach 应答后的首个数据帧，由前端画在回填后的空视口上（与 tmux 整屏重绘
    /// 同构；混在 history 里会被前端回填尾部的 rows×CRLF 一并推进 scrollback，
    /// 视口剩全空白，实测复现过）。
    pub history: Vec<u8>,
    /// attach 时刻的当前屏（state_formatted，含光标位置）。resume 时空——前端拿
    /// 自己的尾屏做增量拼接，重发当前屏会整体重复。
    pub screen: Vec<u8>,
    /// 终端输入模式回放（input_mode_formatted：鼠标上报/括号粘贴/应用光标键）。
    /// app 在无人 attach 时开的这些模式已被 daemon 的 vt100 模型消费、原始字节不再有；
    /// 不回放的话浏览器端 xterm 永远停在无鼠标模式，触屏滚动的 SGR 滚轮转换
    /// （Terminal.vue altWheel）判不出来，claude 这类全屏 TUI 在手机上没法滚。
    pub modes: Vec<u8>,
    pub last_seq: u64,
    pub title: String,
    pub cwd: String,
    pub foreground: String,
    pub rx: broadcast::Receiver<SessionEvent>,
    pub guard: AttachGuard,
}

pub struct AttachGuard {
    session: Arc<Session>,
}

impl Drop for AttachGuard {
    fn drop(&mut self) {
        self.session
            .attached
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                Some(n.saturating_sub(1))
            })
            .ok();
    }
}

impl Session {
    pub fn write_input(&self, data: &[u8]) -> Result<()> {
        let mut writer = self.writer.lock();
        writer.write_all(data).context("write pty")?;
        writer.flush().context("flush pty")?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let cols = cols.max(1);
        let rows = rows.max(1);
        self.master.lock().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        self.cols.store(cols, Ordering::SeqCst);
        self.rows.store(rows, Ordering::SeqCst);
        self.screen.lock().set_size(rows, cols);
        Ok(())
    }

    pub fn kill(&self) {
        let _ = self.killer.lock().kill();
    }

    pub fn attach(self: &Arc<Self>, cols: u16, rows: u16, resume: bool) -> Result<AttachedSession> {
        self.resize(cols, rows).ok();
        let mut screen = self.screen.lock();
        let rx = self.tx.subscribe();
        let last_seq = self.seq.load(Ordering::SeqCst);
        let (scrollback, current) = capture_parts(&mut screen, true);
        // 输入模式回放：首次 attach 把备用屏 ?1049h + input 模式拼在当前屏前面走首屏
        // Data 帧（?1049h 清屏后紧跟 state_formatted 整屏重绘，时序自洽，清掉也无所谓）；
        // resume 时 screen 留空、modes 单独走应答字段由服务端桥转成控制帧补发（鼠标等
        // 模式幂等；不带 ?1049——xterm 已在备用屏时重收 ?1049h 会清屏且无人重绘）。
        // vt100 不把备用屏算 input 模式，按 alternate_screen() 自补。
        let modes = screen.screen().input_mode_formatted();
        let (history, screen_bytes) = if resume {
            let mut combined = scrollback;
            if !combined.is_empty() && !combined.ends_with(b"\n") {
                combined.push(b'\n');
            }
            combined.extend_from_slice(&current);
            (tail_lines(&combined, RESUME_HISTORY_LINES), Vec::new())
        } else {
            let mut first_frame = Vec::new();
            if screen.screen().alternate_screen() {
                first_frame.extend_from_slice(b"\x1b[?1049h");
            }
            first_frame.extend_from_slice(&modes);
            first_frame.extend_from_slice(&current);
            (scrollback, first_frame)
        };
        self.attached.fetch_add(1, Ordering::SeqCst);
        let (title, cwd, foreground) = snapshot_meta(self, &screen);
        drop(screen);
        Ok(AttachedSession {
            sid: self.id,
            name: self.name.lock().clone(),
            cols: self.cols.load(Ordering::SeqCst),
            rows: self.rows.load(Ordering::SeqCst),
            history,
            screen: screen_bytes,
            modes,
            last_seq,
            title,
            cwd,
            foreground,
            rx,
            guard: AttachGuard {
                session: Arc::clone(self),
            },
        })
    }

    pub fn capture(&self, ansi: bool, max_lines: usize) -> (Vec<u8>, u64) {
        let mut screen = self.screen.lock();
        let seq = self.seq.load(Ordering::SeqCst);
        let mut bytes = capture_locked(&mut screen, ansi);
        if !ansi && max_lines > 0 {
            bytes = tail_lines(&bytes, max_lines);
        }
        (bytes, seq)
    }

    pub fn info(&self) -> SessionInfo {
        let screen = self.screen.lock();
        let (title, cwd, foreground) = snapshot_meta(self, &screen);
        SessionInfo {
            id: self.id,
            name: self.name.lock().clone(),
            attached: self.attached.load(Ordering::SeqCst),
            created_at: self.created_at,
            cols: self.cols.load(Ordering::SeqCst),
            rows: self.rows.load(Ordering::SeqCst),
            title,
            cwd,
            foreground,
            alive: self.alive.load(Ordering::SeqCst),
            last_seq: self.seq.load(Ordering::SeqCst),
        }
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

/// 拆开捕获：(scrollback, 当前屏)。scrollback 每行带 \n（可能为空）；当前屏为
/// state_formatted（ansi）/纯文本（非 ansi）。`capture_locked` 在其上拼回组合格式。
fn capture_parts(screen: &mut vt100::Parser, ansi: bool) -> (Vec<u8>, Vec<u8>) {
    let old = screen.screen().scrollback();
    screen.set_scrollback(usize::MAX);
    let total = screen.screen().scrollback();
    let history = if total > 0 {
        if ansi {
            let mut bytes = screen.screen().contents_formatted();
            // 当 scrollback 比屏幕矮时，visible_rows 会带出当前屏顶部几行；
            // 按已知行数截掉，避免回填时重复。
            trim_to_lines(&mut bytes, total);
            bytes
        } else {
            let mut text = screen.screen().contents();
            trim_text_to_lines(&mut text, total);
            text.into_bytes()
        }
    } else {
        Vec::new()
    };
    screen.set_scrollback(0);
    let current = if ansi {
        screen.screen().state_formatted()
    } else {
        screen.screen().contents().into_bytes()
    };
    screen.set_scrollback(old);
    (history, current)
}

fn capture_locked(screen: &mut vt100::Parser, ansi: bool) -> Vec<u8> {
    let (history, current) = capture_parts(screen, ansi);
    if history.is_empty() {
        return current;
    }
    let mut out = history;
    // xterm 的 \x1b[2J 不清 scrollback；当前屏重绘前把历史留在 scrollback 里。
    if !out.ends_with(b"\n") {
        out.push(b'\n');
    }
    out.extend_from_slice(&current);
    out
}

fn trim_to_lines(bytes: &mut Vec<u8>, lines: usize) {
    if lines == 0 {
        bytes.clear();
        return;
    }
    let mut seen = 0usize;
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            seen += 1;
            if seen == lines {
                bytes.truncate(i + 1);
                return;
            }
        }
    }
}

fn trim_text_to_lines(text: &mut String, lines: usize) {
    if lines == 0 {
        text.clear();
        return;
    }
    let mut seen = 0usize;
    for (i, ch) in text.char_indices() {
        if ch == '\n' {
            seen += 1;
            if seen == lines {
                text.truncate(i + 1);
                return;
            }
        }
    }
}

fn tail_lines(bytes: &[u8], max_lines: usize) -> Vec<u8> {
    if max_lines == 0 {
        return bytes.to_vec();
    }
    let mut seen = 0usize;
    for i in (0..bytes.len()).rev() {
        if bytes[i] == b'\n' {
            seen += 1;
            if seen > max_lines {
                return bytes[i + 1..].to_vec();
            }
        }
    }
    bytes.to_vec()
}

fn snapshot_meta(session: &Session, screen: &vt100::Parser) -> (String, String, String) {
    let pgrp = session.master.lock().process_group_leader();
    let cwd = pgrp
        .and_then(|pid| std::fs::read_link(format!("/proc/{pid}/cwd")).ok())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| session.default_cwd.clone());
    let foreground = pgrp
        .and_then(|pid| std::fs::read_to_string(format!("/proc/{pid}/comm")).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| session.default_command.clone());
    let title = screen.screen().title().to_string();
    let title = if title.is_empty() {
        session.last_title.lock().clone()
    } else {
        title
    };
    (title, cwd, foreground)
}

/// 输出驱动式元数据探测：PTY 有新数据时检查 cwd / 前台进程。
/// 无输出的等待变化仍靠 attach 快照兜底，避免常驻轮询每个会话。
fn emit_meta_if_changed(session: &Arc<Session>) {
    let screen = session.screen.lock();
    let (_, cwd, foreground) = snapshot_meta(session, &screen);
    drop(screen);
    if *session.last_cwd.lock() != cwd {
        *session.last_cwd.lock() = cwd.clone();
        let _ = session.tx.send(SessionEvent::Cwd { cwd });
    }
    if *session.last_foreground.lock() != foreground {
        *session.last_foreground.lock() = foreground.clone();
        let _ = session.tx.send(SessionEvent::Foreground { foreground });
    }
}

pub struct Manager {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    by_name: RwLock<HashMap<String, u32>>,
    next_id: AtomicU32,
    scrollback: usize,
}

impl Default for Manager {
    fn default() -> Self {
        Self::new(DEFAULT_SCROLLBACK)
    }
}

impl Manager {
    pub fn new(scrollback: usize) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            by_name: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            scrollback,
        }
    }

    pub fn create(self: &Arc<Self>, req: Request) -> Result<SessionInfo> {
        let Request::New {
            name,
            cwd,
            argv,
            env,
            cols,
            rows,
        } = req
        else {
            bail!("create expects new request");
        };
        validate_name(&name)?;
        let argv = if argv.is_empty() {
            vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())]
        } else {
            argv
        };
        if self.by_name.read().contains_key(&name) {
            bail!("session already exists: {name}");
        }

        let cols = cols.max(1);
        let rows = rows.max(1);
        let cwd = cwd.unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/".into()));
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(&argv[0]);
        for arg in &argv[1..] {
            cmd.arg(arg);
        }
        cmd.cwd(&cwd);
        for (key, value) in &env {
            cmd.env(key, value);
        }
        cmd.env("MSMUX_SESSION", &name);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair.slave.spawn_command(cmd).context("spawn pty command")?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().context("pty reader")?;
        let writer = pair.master.take_writer().context("pty writer")?;
        let killer = child.clone_killer();

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let created_at = now_ms();
        let (tx, _) = broadcast::channel(EVENT_BUFFER);
        let session = Arc::new(Session {
            id,
            name: Mutex::new(name.clone()),
            created_at,
            cols: AtomicU16::new(cols),
            rows: AtomicU16::new(rows),
            attached: AtomicU32::new(0),
            seq: AtomicU64::new(0),
            alive: AtomicBool::new(true),
            exit_code: Mutex::new(None),
            screen: Mutex::new(vt100::Parser::new(rows, cols, self.scrollback)),
            tx,
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            killer: Mutex::new(killer),
            default_cwd: cwd,
            default_command: PathBuf::from(&argv[0])
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| argv[0].clone()),
            last_title: Mutex::new(String::new()),
            last_cwd: Mutex::new(String::new()),
            last_foreground: Mutex::new(String::new()),
        });

        self.sessions.write().insert(id, Arc::clone(&session));
        self.by_name.write().insert(name, id);
        *session.last_cwd.lock() = session.default_cwd.clone();
        *session.last_foreground.lock() = session.default_command.clone();

        let reader_session = Arc::clone(&session);
        thread::Builder::new()
            .name(format!("msmux-read-{id}"))
            .spawn(move || read_loop(reader, reader_session))
            .context("spawn reader")?;

        let wait_session = Arc::clone(&session);
        let manager = Arc::downgrade(self);
        thread::Builder::new()
            .name(format!("msmux-wait-{id}"))
            .spawn(move || wait_loop(child, wait_session, manager))
            .context("spawn waiter")?;

        Ok(session.info())
    }

    pub fn get(&self, name: &str) -> Option<Arc<Session>> {
        let id = *self.by_name.read().get(name)?;
        self.sessions.read().get(&id).cloned()
    }

    pub fn get_by_id(&self, id: u32) -> Option<Arc<Session>> {
        self.sessions.read().get(&id).cloned()
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let mut out: Vec<_> = self.sessions.read().values().map(|s| s.info()).collect();
        out.sort_by_key(|s| s.created_at);
        out
    }

    pub fn kill(&self, name: &str) -> bool {
        let Some(session) = self.get(name) else {
            return false;
        };
        session.kill();
        true
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        validate_name(to)?;
        let mut by_name = self.by_name.write();
        let Some(id) = by_name.get(from).copied() else {
            bail!("no such session: {from}");
        };
        if by_name.contains_key(to) {
            bail!("session already exists: {to}");
        }
        by_name.remove(from);
        by_name.insert(to.to_string(), id);
        drop(by_name);
        if let Some(session) = self.sessions.read().get(&id) {
            *session.name.lock() = to.to_string();
        }
        Ok(())
    }

    fn remove(&self, id: u32) {
        let mut sessions = self.sessions.write();
        let Some(session) = sessions.remove(&id) else {
            return;
        };
        let name = session.name.lock().clone();
        self.by_name.write().remove(&name);
    }
}

fn read_loop(mut reader: Box<dyn Read + Send>, session: Arc<Session>) {
    let mut buf = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let data = buf[..n].to_vec();
                let seq = {
                    let mut screen = session.screen.lock();
                    screen.process(&data);
                    let seq = session.seq.fetch_add(1, Ordering::SeqCst) + 1;
                    let title = screen.screen().title().to_string();
                    if !title.is_empty() && title != *session.last_title.lock() {
                        *session.last_title.lock() = title.clone();
                        let _ = session.tx.send(SessionEvent::Title { title });
                    }
                    seq
                };
                let _ = session.tx.send(SessionEvent::Output { seq, data });
                emit_meta_if_changed(&session);
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    session.alive.store(false, Ordering::SeqCst);
}

fn wait_loop(
    mut child: Box<dyn Child + Send + Sync>,
    session: Arc<Session>,
    manager: std::sync::Weak<Manager>,
) {
    let code = match child.wait() {
        Ok(status) => Some(status.exit_code()),
        Err(_) => None,
    };
    *session.exit_code.lock() = code;
    session.alive.store(false, Ordering::SeqCst);
    let _ = session.tx.send(SessionEvent::Exit { code });
    if let Some(manager) = manager.upgrade() {
        manager.remove(session.id);
    }
}

pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 64 {
        bail!("session name must be 1..=64 chars");
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        bail!("invalid session name: {name}");
    }
    if name.starts_with('-') {
        bail!("session name must not start with '-'");
    }
    Ok(())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn socket_path(cli: Option<String>) -> PathBuf {
    if let Some(path) = cli {
        return PathBuf::from(path);
    }
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR")
        && !dir.is_empty()
    {
        return PathBuf::from(dir).join("msmux").join("msmux.sock");
    }
    let uid = unsafe { libc::getuid() };
    std::env::temp_dir().join(format!("msmux-{uid}.sock"))
}

pub fn missing_session(name: &str) -> anyhow::Error {
    anyhow!("no such session: {name}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_validation() {
        assert!(validate_name("mysandbox-abcd-1234").is_ok());
        assert!(validate_name("-bad").is_err());
        assert!(validate_name("bad name").is_err());
        assert!(validate_name("").is_err());
    }

    #[test]
    fn simple_session_capture() {
        let manager = Arc::new(Manager::new(1000));
        let req = Request::New {
            name: "test-one".into(),
            cwd: None,
            argv: vec![
                "sh".into(),
                "-c".into(),
                "printf 'hello-msmux'; sleep 1".into(),
            ],
            env: vec![],
            cols: 80,
            rows: 24,
        };
        let info = manager.create(req).unwrap();
        assert_eq!(info.name, "test-one");
        thread::sleep(std::time::Duration::from_millis(300));
        let session = manager.get("test-one").unwrap();
        let (text, _) = session.capture(false, 100);
        assert!(String::from_utf8_lossy(&text).contains("hello-msmux"));
        assert!(manager.kill("test-one"));
    }
}
