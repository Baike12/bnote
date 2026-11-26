//! Relay-visible frames (`protocol/v2.md` §3–§5).
//!
//! Only the relay reads these fields. The payload is opaque to it; the Mac's
//! client validates it the same way the Go relay does, so a broken sender is
//! caught before decryption.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use super::crypto::{self, CryptoError};

pub const VERSION: u32 = 2;
pub const MAX_FRAME: usize = 1 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameType {
    Hello,
    Ready,
    Data,
    Ping,
    Pong,
    Error,
    Presence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Host,
    Terminal,
}

impl Role {
    /// The `sender` string bound into the AEAD AAD.
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Host => "host",
            Role::Terminal => "terminal",
        }
    }

    pub fn other(self) -> Role {
        match self {
            Role::Host => Role::Terminal,
            Role::Terminal => Role::Host,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameError {
    pub code: &'static str,
    pub message: String,
}

impl FrameError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for FrameError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayFrame {
    pub v: u32,
    #[serde(rename = "type")]
    pub kind: FrameType,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub room: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub device: String,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "opt_b64")]
    pub host_token: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub seq: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub msg_id: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub chunk: usize,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub chunks: usize,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub total: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty", with = "b64")]
    pub payload: Vec<u8>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub code: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub message: String,
    /// Relay presence only. `Some(false)` must reach the wire: an omitted
    /// field would make the phone believe a host is still attached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub present: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<u64>,
}

fn is_zero<T: PartialEq + From<u8>>(value: &T) -> bool {
    *value == T::from(0)
}

mod b64 {
    use super::*;

    pub fn serialize<S: serde::Serializer>(bytes: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let raw = String::deserialize(d)?;
        STANDARD.decode(raw).map_err(serde::de::Error::custom)
    }
}

mod opt_b64 {
    use super::*;

    pub fn serialize<S: serde::Serializer>(
        bytes: &Option<Vec<u8>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(b) => s.serialize_str(&STANDARD.encode(b)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Vec<u8>>, D::Error> {
        let raw = Option::<String>::deserialize(d)?;
        match raw {
            Some(s) => STANDARD
                .decode(s)
                .map(Some)
                .map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}

impl RelayFrame {
    pub fn decode(data: &[u8]) -> Result<RelayFrame, FrameError> {
        if data.len() > MAX_FRAME {
            return Err(FrameError::new("OVERSIZE", "frame over 1 MiB"));
        }
        let frame: RelayFrame = serde_json::from_slice(data)
            .map_err(|e| FrameError::new("BAD_FRAME", format!("invalid json: {e}")))?;
        if frame.v != VERSION {
            return Err(FrameError::new(
                "BAD_FRAME",
                format!("unsupported version {}", frame.v),
            ));
        }
        Ok(frame)
    }

    pub fn encode(&self) -> Result<Vec<u8>, FrameError> {
        serde_json::to_vec(self).map_err(|e| FrameError::new("INTERNAL", e.to_string()))
    }

    pub fn hello_host(room: &str, device: &str, host_token: &[u8]) -> Self {
        Self {
            v: VERSION,
            kind: FrameType::Hello,
            room: room.into(),
            role: Some(Role::Host),
            device: device.into(),
            host_token: Some(host_token.to_vec()),
            seq: 0,
            msg_id: String::new(),
            chunk: 0,
            chunks: 0,
            total: 0,
            payload: Vec::new(),
            code: String::new(),
            message: String::new(),
            present: None,
            epoch: None,
        }
    }

    pub fn hello_terminal(room: &str, device: &str) -> Self {
        Self {
            v: VERSION,
            kind: FrameType::Hello,
            room: room.into(),
            role: Some(Role::Terminal),
            device: device.into(),
            host_token: None,
            seq: 0,
            msg_id: String::new(),
            chunk: 0,
            chunks: 0,
            total: 0,
            payload: Vec::new(),
            code: String::new(),
            message: String::new(),
            present: None,
            epoch: None,
        }
    }

    pub fn data(
        room: &str,
        device: &str,
        seq: u64,
        msg_id: &str,
        chunk: usize,
        chunks: usize,
        total: usize,
        payload: Vec<u8>,
    ) -> Self {
        Self {
            v: VERSION,
            kind: FrameType::Data,
            room: room.into(),
            role: None,
            device: device.into(),
            host_token: None,
            seq,
            msg_id: msg_id.into(),
            chunk,
            chunks,
            total,
            payload,
            code: String::new(),
            message: String::new(),
            present: None,
            epoch: None,
        }
    }

    pub fn ping() -> Self {
        Self::bare(FrameType::Ping)
    }

    pub fn pong() -> Self {
        Self::bare(FrameType::Pong)
    }

    fn bare(kind: FrameType) -> Self {
        Self {
            v: VERSION,
            kind,
            room: String::new(),
            role: None,
            device: String::new(),
            host_token: None,
            seq: 0,
            msg_id: String::new(),
            chunk: 0,
            chunks: 0,
            total: 0,
            payload: Vec::new(),
            code: String::new(),
            message: String::new(),
            present: None,
            epoch: None,
        }
    }

    pub fn presence(present: bool, epoch: u64) -> Self {
        Self {
            present: Some(present),
            epoch: Some(epoch),
            ..Self::bare(FrameType::Presence)
        }
    }

    pub fn validate_hello(&self) -> Result<(Role, &str, &str), FrameError> {
        if !valid_hex(&self.room, 32) {
            return Err(FrameError::new(
                "BAD_FRAME",
                "room must be 32 lowercase hex",
            ));
        }
        if !valid_hex(&self.device, 32) {
            return Err(FrameError::new(
                "BAD_FRAME",
                "device must be 32 lowercase hex",
            ));
        }
        match self.role {
            Some(Role::Host) => match &self.host_token {
                Some(token) if token.len() == 32 => Ok((Role::Host, &self.room, &self.device)),
                _ => Err(FrameError::new(
                    "BAD_FRAME",
                    "host needs a 32-byte hostToken",
                )),
            },
            Some(Role::Terminal) => {
                if self.host_token.is_some() {
                    return Err(FrameError::new(
                        "BAD_FRAME",
                        "terminal must not send hostToken",
                    ));
                }
                Ok((Role::Terminal, &self.room, &self.device))
            }
            None => Err(FrameError::new("BAD_FRAME", "role is required")),
        }
    }

    pub fn validate_data(&self, room: &str, device: &str) -> Result<(), FrameError> {
        if self.room != room || self.device != device {
            return Err(FrameError::new("BAD_FRAME", "room or device mismatch"));
        }
        if !valid_hex(&self.msg_id, 32) {
            return Err(FrameError::new(
                "BAD_FRAME",
                "msgId must be 32 lowercase hex",
            ));
        }
        if self.total == 0 || self.total > crypto::MAX_MESSAGE {
            return Err(FrameError::new("OVERSIZE", "total out of range"));
        }
        if self.chunks != chunk_count(self.total) || self.chunk >= self.chunks {
            return Err(FrameError::new("BAD_FRAME", "chunk arithmetic mismatch"));
        }
        if self.payload.len() != chunk_len(self.total, self.chunk) {
            return Err(FrameError::new("BAD_FRAME", "payload length mismatch"));
        }
        // seq 0 is the handshake's: those frames are plaintext and carry no
        // AEAD AAD. seq 1 is the encrypted `hs_confirm`; application messages
        // start at 2. The E2E layer enforces the split.
        Ok(())
    }
}

fn valid_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn chunk_count(total: usize) -> usize {
    total.div_ceil(crypto::CHUNK_SIZE)
}

pub fn chunk_len(total: usize, index: usize) -> usize {
    let chunks = chunk_count(total);
    if index + 1 == chunks {
        total - crypto::CHUNK_SIZE * (chunks - 1)
    } else {
        crypto::CHUNK_SIZE
    }
}

/// Splits one logical message into already-encoded data frames.
pub fn frames_for(
    room: &str,
    device: &str,
    seq: u64,
    msg_id: &str,
    message: &[u8],
) -> Result<Vec<RelayFrame>, CryptoError> {
    if message.is_empty() || message.len() > crypto::MAX_MESSAGE {
        return Err(CryptoError(format!(
            "message length {} out of range",
            message.len()
        )));
    }
    let chunks = chunk_count(message.len());
    let mut out = Vec::with_capacity(chunks);
    for index in 0..chunks {
        let start = index * crypto::CHUNK_SIZE;
        let end = start + chunk_len(message.len(), index);
        out.push(RelayFrame::data(
            room,
            device,
            seq,
            msg_id,
            index,
            chunks,
            message.len(),
            message[start..end].to_vec(),
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn vectors(name: &str) -> Value {
        let path = format!("{}/tests/vectors/{}", env!("CARGO_MANIFEST_DIR"), name);
        serde_json::from_str(&std::fs::read_to_string(path).expect("vector")).expect("json")
    }

    const ROOM: &str = "00112233445566778899aabbccddeeff";
    const DEVICE: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn fragment_vectors_match() {
        let v = vectors("fragment.json");
        for case in v["cases"].as_array().expect("cases") {
            let total = case["total"].as_u64().expect("total") as usize;
            let chunks = case["chunks"].as_u64().expect("chunks") as usize;
            let last = case["lastLength"].as_u64().expect("last") as usize;
            let offsets = case["offsets"].as_array().expect("offsets");
            assert_eq!(chunk_count(total), chunks, "total={total}");
            assert_eq!(chunk_len(total, chunks - 1), last, "total={total}");
            for (i, off) in offsets.iter().enumerate() {
                assert_eq!(off.as_u64().unwrap() as usize, i * crypto::CHUNK_SIZE);
            }
        }
    }

    #[test]
    fn frames_round_trip_and_split() {
        let message = vec![7u8; crypto::CHUNK_SIZE + 5];
        let frames = frames_for(ROOM, DEVICE, 2, &"ab".repeat(16), &message).expect("frames");
        assert_eq!(frames.len(), 2);
        let json = frames[0].encode().expect("encode");
        let back = RelayFrame::decode(&json).expect("decode");
        assert_eq!(back, frames[0]);
        assert_eq!(back.payload.len(), crypto::CHUNK_SIZE);
        assert!(String::from_utf8_lossy(&json).contains("\"payload\":\""));

        // The receiver's arithmetic accepts every frame it produced.
        for f in &frames {
            f.validate_data(ROOM, DEVICE).expect("valid");
        }
        let mut joined = Vec::new();
        for f in frames {
            joined.extend_from_slice(&f.payload);
        }
        assert_eq!(joined, message);
    }

    #[test]
    fn hello_validation() {
        let host = RelayFrame::hello_host(ROOM, DEVICE, &[1u8; 32]);
        assert_eq!(host.validate_hello().expect("host").0, Role::Host);

        let mut no_token = host.clone();
        no_token.host_token = None;
        assert!(no_token.validate_hello().is_err());

        let mut terminal = RelayFrame::hello_terminal(ROOM, DEVICE);
        terminal.host_token = Some(vec![1u8; 32]);
        assert!(terminal.validate_hello().is_err());

        let mut uppercase = RelayFrame::hello_terminal(ROOM, DEVICE);
        uppercase.room = ROOM.to_uppercase();
        assert!(uppercase.validate_hello().is_err());
    }

    #[test]
    fn data_validation() {
        let good = RelayFrame::data(ROOM, DEVICE, 2, &"ab".repeat(16), 0, 1, 3, vec![1, 2, 3]);
        good.validate_data(ROOM, DEVICE).expect("valid");

        let mut wrong = good.clone();
        wrong.payload = vec![1, 2];
        assert!(wrong.validate_data(ROOM, DEVICE).is_err());

        let mut oversize = good;
        oversize.total = crypto::MAX_MESSAGE + 1;
        assert_eq!(
            oversize.validate_data(ROOM, DEVICE).unwrap_err().code,
            "OVERSIZE"
        );
    }

    #[test]
    fn unknown_fields_are_ignored_and_version_is_checked() {
        let raw = format!(r#"{{"v":2,"type":"ping","future":"x","room":"{ROOM}"}}"#);
        assert_eq!(
            RelayFrame::decode(raw.as_bytes()).expect("decode").kind,
            FrameType::Ping
        );
        assert!(RelayFrame::decode(br#"{"v":1,"type":"ping"}"#).is_err());
        assert!(RelayFrame::decode(br#"{"v":2,"type":"nope"}"#).is_err());
    }

    #[test]
    fn presence_false_survives_the_wire() {
        let frame = RelayFrame::presence(false, 0);
        let raw = frame.encode().expect("encode");
        let text = String::from_utf8(raw).expect("utf8");
        assert!(text.contains(r#""present":false"#), "{text}");
        assert!(text.contains(r#""epoch":0"#), "{text}");
        let back = RelayFrame::decode(text.as_bytes()).expect("decode");
        assert_eq!(back.present, Some(false));
        assert_eq!(back.epoch, Some(0));
    }

    #[test]
    fn frame_vectors_decode() {
        let v = vectors("frames.json");
        for case in v["frames"].as_array().expect("frames") {
            let name = case["name"].as_str().expect("name");
            let raw = case["json"].as_str().expect("json");
            let f = RelayFrame::decode(raw.as_bytes()).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(f.v, VERSION, "{name}");
            if f.kind == FrameType::Presence {
                assert!(f.present.is_some(), "{name}");
                assert!(f.epoch.is_some(), "{name}");
            }
            if let Some(token) = &f.host_token {
                assert_eq!(token.len(), 32, "{name}");
            }
        }
    }

    #[test]
    fn error_code_round_trip() {
        let frame = RelayFrame {
            code: "AUTH_FAILED".into(),
            message: "host token mismatch".into(),
            ..RelayFrame::bare(FrameType::Error)
        };
        let back = RelayFrame::decode(&frame.encode().expect("encode")).expect("decode");
        assert_eq!(back.code, "AUTH_FAILED");
    }
}
