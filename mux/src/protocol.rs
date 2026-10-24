//! msmux 的线路协议。
//!
//! 帧格式刻意保持很小：一个 kind 字节 + payload。Unix socket 用 4 字节长度前缀，
//! WebSocket 直接用二进制消息。控制面是 JSON，终端数据是二进制，避免把任意字节
//! 塞进 JSON 字符串。

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u16 = 2;

pub const KIND_JSON: u8 = 1;
pub const KIND_DATA: u8 = 2;
pub const KIND_PING: u8 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Hello {
        version: u16,
    },
    List,
    New {
        name: String,
        cwd: Option<String>,
        argv: Vec<String>,
        env: Vec<(String, String)>,
        cols: u16,
        rows: u16,
    },
    Attach {
        name: String,
        cols: u16,
        rows: u16,
        resume: bool,
    },
    Resize {
        sid: u32,
        cols: u16,
        rows: u16,
    },
    Detach {
        sid: u32,
    },
    Capture {
        name: String,
        ansi: bool,
        max_lines: usize,
    },
    Kill {
        name: String,
    },
    Rename {
        from: String,
        to: String,
    },
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Hello {
        version: u16,
        pid: u32,
        role: String,
    },
    Ok {
        message: Option<String>,
    },
    Error {
        message: String,
    },
    Sessions {
        sessions: Vec<SessionInfo>,
    },
    Attached {
        sid: u32,
        name: String,
        cols: u16,
        rows: u16,
        /// 已渲染屏幕（含 scrollback），base64 后的 ANSI 字节。
        history: String,
        history_encoding: String,
        /// 终端输入模式回放（input_mode_formatted），base64。旧 daemon 不发该字段，
        /// serde default 兼容；消费方见 session.rs attach() 的注释。
        #[serde(default)]
        modes: String,
        last_seq: u64,
        title: String,
        cwd: String,
        foreground: String,
    },
    Captured {
        name: String,
        /// base64 后的文本；ansi=true 时带 SGR。
        text: String,
        encoding: String,
        seq: u64,
    },
    Title {
        sid: u32,
        title: String,
    },
    Cwd {
        sid: u32,
        cwd: String,
    },
    Foreground {
        sid: u32,
        foreground: String,
    },
    Exit {
        sid: u32,
        name: String,
        code: Option<u32>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionInfo {
    pub id: u32,
    pub name: String,
    pub attached: u32,
    pub created_at: u64,
    pub cols: u16,
    pub rows: u16,
    pub title: String,
    pub cwd: String,
    pub foreground: String,
    pub alive: bool,
    /// 会话输出序号；前端/服务端活动监测拿它判断「停手后是否又出过输出」。
    pub last_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Json(Vec<u8>),
    Data { sid: u32, data: Vec<u8> },
    Ping,
}

impl Frame {
    pub fn json<T: Serialize>(value: &T) -> Result<Self, serde_json::Error> {
        Ok(Self::Json(serde_json::to_vec(value)?))
    }

    pub fn data(sid: u32, data: Vec<u8>) -> Self {
        Self::Data { sid, data }
    }

    pub fn encode(&self) -> Vec<u8> {
        match self {
            Self::Json(payload) => {
                let mut out = Vec::with_capacity(1 + payload.len());
                out.push(KIND_JSON);
                out.extend_from_slice(payload);
                out
            }
            Self::Data { sid, data } => {
                let mut out = Vec::with_capacity(5 + data.len());
                out.push(KIND_DATA);
                out.extend_from_slice(&sid.to_be_bytes());
                out.extend_from_slice(data);
                out
            }
            Self::Ping => vec![KIND_PING],
        }
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        let Some((&kind, rest)) = bytes.split_first() else {
            return Err("empty frame".into());
        };
        match kind {
            KIND_JSON => Ok(Self::Json(rest.to_vec())),
            KIND_DATA => {
                if rest.len() < 4 {
                    return Err("data frame missing session id".into());
                }
                let sid = u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]);
                Ok(Self::Data {
                    sid,
                    data: rest[4..].to_vec(),
                })
            }
            KIND_PING => Ok(Self::Ping),
            other => Err(format!("unknown frame kind {other}")),
        }
    }

    pub fn as_json<T: for<'de> Deserialize<'de>>(&self) -> Result<T, String> {
        match self {
            Self::Json(payload) => {
                serde_json::from_slice(payload).map_err(|e| format!("bad json: {e}"))
            }
            _ => Err("expected json frame".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip_json() {
        let frame = Frame::json(&Request::Ping).unwrap();
        assert_eq!(Frame::decode(&frame.encode()).unwrap(), frame);
    }

    #[test]
    fn frame_round_trip_data() {
        let frame = Frame::data(42, b"hello\0world".to_vec());
        assert_eq!(Frame::decode(&frame.encode()).unwrap(), frame);
    }

    #[test]
    fn request_shape_is_stable() {
        let req = Request::New {
            name: "mysandbox-x".into(),
            cwd: Some("/home/dev".into()),
            argv: vec!["zsh".into()],
            env: vec![("TERM".into(), "xterm-256color".into())],
            cols: 120,
            rows: 40,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"type\":\"new\""));
        assert!(json.contains("\"name\":\"mysandbox-x\""));
    }
}
