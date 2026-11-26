//! Outbound WSS connection to the relay and the per-phone E2E handshake.
//!
//! The Mac never listens. The relay routes by room; this module authenticates
//! the room as the host, then keeps one encrypted session per phone. All
//! writes happen on the connection task, so per-device `seq` allocation and the
//! socket are single-owner.
//!
//! Presence is relay-owned: the Mac ignores it. Phones re-handshake whenever
//! the relay announces a new epoch (a new host attachment), so a stale key set
//! is never reused after a reconnect.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::crypto::{self, Reassembler, ReplayWindow};
use super::frame::{self, FrameType, RelayFrame};
use super::keys::{self, HandshakeSession};
use super::settings::{self, Identity};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
type Write = futures::stream::SplitSink<Ws, Message>;

#[derive(Debug)]
pub enum Outgoing {
    /// An application JSON message, encrypted for one device (or every
    /// established device when `device` is None).
    App {
        device: Option<String>,
        text: String,
    },
}

#[derive(Debug)]
pub enum Control {
    Stop,
    Send { device_id: String, text: String },
}

/// One currently handshaken phone, surfaced read-only in the settings page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub device_id: String,
    pub name: String,
    pub connected_at: u64,
    pub last_seen_at: u64,
    pub connected: bool,
}

#[derive(Clone)]
pub struct ClientHandle {
    pub out: mpsc::UnboundedSender<Outgoing>,
    pub control: mpsc::UnboundedSender<Control>,
    pub app: tauri::AppHandle,
    subscribed: Arc<Mutex<HashSet<String>>>,
    connections: Arc<Mutex<Vec<Connection>>>,
}

impl ClientHandle {
    pub fn new(
        app: tauri::AppHandle,
    ) -> (
        Self,
        mpsc::UnboundedReceiver<Outgoing>,
        mpsc::UnboundedReceiver<Control>,
    ) {
        let (out, out_rx) = mpsc::unbounded_channel();
        let (control, control_rx) = mpsc::unbounded_channel();
        (
            Self {
                out,
                control,
                app,
                subscribed: Arc::new(Mutex::new(HashSet::new())),
                connections: Arc::new(Mutex::new(Vec::new())),
            },
            out_rx,
            control_rx,
        )
    }

    pub fn send_app(&self, device: Option<String>, value: serde_json::Value) {
        let _ = self.out.send(Outgoing::App {
            device,
            text: value.to_string(),
        });
    }

    /// True the first time a (device, session) pair subscribes.
    pub fn mark_subscribed(&self, key: &str) -> bool {
        self.subscribed
            .lock()
            .map(|mut set| set.insert(key.to_string()))
            .unwrap_or(false)
    }

    pub fn connections(&self) -> Vec<Connection> {
        self.connections
            .lock()
            .map(|list| list.clone())
            .unwrap_or_default()
    }

    fn upsert_connection(&self, device_id: &str, name: &str) {
        let now = now_ms();
        let mut changed = false;
        if let Ok(mut list) = self.connections.lock() {
            match list.iter_mut().find(|c| c.device_id == device_id) {
                Some(entry) => {
                    entry.name = name.to_string();
                    entry.last_seen_at = now;
                    entry.connected = true;
                }
                None => {
                    list.push(Connection {
                        device_id: device_id.to_string(),
                        name: name.to_string(),
                        connected_at: now,
                        last_seen_at: now,
                        connected: true,
                    });
                    changed = true;
                }
            }
        }
        if changed {
            self.app
                .emit_remote_event(serde_json::json!({"type":"status","status":"online"}));
        }
    }

    fn touch_connection(&self, device_id: &str) {
        if let Ok(mut list) = self.connections.lock() {
            if let Some(entry) = list.iter_mut().find(|c| c.device_id == device_id) {
                entry.last_seen_at = now_ms();
            }
        }
    }

    fn emit_status(&self, status: &str) {
        self.app.emit_remote_event(serde_json::json!({
            "type": "status",
            "status": status,
        }));
    }

    fn clear_connections(&self) {
        let had = self
            .connections
            .lock()
            .map(|mut list| {
                let had = !list.is_empty();
                list.clear();
                had
            })
            .unwrap_or(false);
        if had {
            self.app
                .emit_remote_event(serde_json::json!({"type":"status","status":"offline"}));
        }
    }
}

#[derive(Default)]
struct DeviceConn {
    name: String,
    established: bool,
    send_seq: u64,
    recv: ReplayWindow,
    reasm: Reassembler,
    handshake: Option<HandshakeSession>,
    keys: Option<crypto::HandshakeKeys>,
    /// `hs_start` arrival times inside the current 10 s window.
    attempts: Vec<Instant>,
}

/// One connection attempt. The manager owns the channels across attempts, so a
/// reconnect keeps the event subscriptions and pending UI state.
pub async fn connect_loop(
    base_url: &str,
    identity: &Identity,
    data_dir: &std::path::Path,
    handle: &ClientHandle,
    control: &mut mpsc::UnboundedReceiver<Control>,
    outgoing: &mut mpsc::UnboundedReceiver<Outgoing>,
) -> Result<(), String> {
    let relay_url = settings::relay_url(base_url)?;
    // No custom connector: TLS is verified against the system trust store.
    let (ws, _) = tokio_tungstenite::connect_async(&relay_url)
        .await
        .map_err(|e| format!("CONNECT_FAILED: {e}"))?;
    let (mut write, mut read) = ws.split();

    let hello = RelayFrame::hello_host(&identity.room, &identity.device_id, &identity.host_token);
    let text =
        String::from_utf8(hello.encode().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    write
        .send(Message::Text(text))
        .await
        .map_err(|e| format!("CONNECT_FAILED: {e}"))?;

    let ready = read
        .next()
        .await
        .ok_or("CONNECT_FAILED: relay closed before ready")?
        .map_err(|e| format!("CONNECT_FAILED: {e}"))?;
    match ready {
        Message::Text(text) => {
            let f = RelayFrame::decode(text.as_bytes()).map_err(|e| e.to_string())?;
            if f.kind == FrameType::Error {
                return Err(format!("RELAY_ERROR: {} {}", f.code, f.message));
            }
            if f.kind != FrameType::Ready {
                return Err("CONNECT_FAILED: expected ready".into());
            }
        }
        _ => return Err("CONNECT_FAILED: expected text ready".into()),
    }

    let mut conn = Conn {
        room: identity.room.clone(),
        device_id: identity.device_id.clone(),
        identity,
        data_dir: data_dir.to_path_buf(),
        devices: HashMap::new(),
        handle: handle.clone(),
    };
    handle.emit_status("online");

    let result = loop {
        tokio::select! {
            message = read.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if let Err(e) = conn.on_frame(text.as_bytes(), &mut write).await {
                            handle.app.emit_remote_error(&e);
                            break Err(e);
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = write.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break Ok(()),
                    Some(Err(e)) => break Err(format!("SOCKET: {e}")),
                    _ => {}
                }
            }
            Some(control) = control.recv() => {
                match control {
                    Control::Stop => break Ok(()),
                    Control::Send { device_id, text } => {
                        let _ = conn.send_app(&device_id, &text, &mut write).await;
                    }
                }
            }
            Some(Outgoing::App { device, text }) = outgoing.recv() => {
                {
                    match device {
                        Some(id) => { let _ = conn.send_app(&id, &text, &mut write).await; }
                        None => {
                            let ids: Vec<String> = conn
                                .devices
                                .iter()
                                .filter(|(_, d)| d.established)
                                .map(|(id, _)| id.clone())
                                .collect();
                            for id in ids {
                                let _ = conn.send_app(&id, &text, &mut write).await;
                            }
                        }
                    }
                }
            }
        }
    };
    handle.clear_connections();
    result
}

struct Conn<'a> {
    room: String,
    device_id: String,
    identity: &'a Identity,
    data_dir: std::path::PathBuf,
    devices: HashMap<String, DeviceConn>,
    handle: ClientHandle,
}

/// The device map is one entry per phone id; a room member can invent ids, so
/// the count is capped rather than trusted.
const MAX_DEVICES: usize = 64;

fn is_hex32(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Conn<'_> {
    /// One relay frame. Only a relay-level error or a failed socket write is
    /// fatal (it ends the connection and triggers the reconnect backoff); every
    /// frame-level problem is attributed and dropped, so one phone's bad frame
    /// cannot disconnect the others.
    async fn on_frame(&mut self, raw: &[u8], write: &mut Write) -> Result<(), String> {
        let f = match RelayFrame::decode(raw) {
            Ok(frame) => frame,
            Err(e) => {
                self.note_error(&e.to_string());
                return Ok(());
            }
        };
        match f.kind {
            FrameType::Ping => self.send_frame(RelayFrame::pong(), write).await,
            FrameType::Pong => Ok(()),
            FrameType::Error => Err(format!("RELAY_ERROR: {} {}", f.code, f.message)),
            // Presence is relay-owned and tells phones whether a host socket
            // exists; the host is the one being announced, so it ignores it.
            FrameType::Presence => Ok(()),
            FrameType::Data => self.on_data(f, write).await,
            _ => Ok(()),
        }
    }

    async fn on_data(&mut self, f: RelayFrame, write: &mut Write) -> Result<(), String> {
        if f.msg_id.is_empty() || !is_hex32(&f.device) {
            return Ok(());
        }
        // The relay-visible fields (room, chunk arithmetic, payload length) are
        // validated before anything is allocated or decrypted; `Reassembler`
        // relies on that contract.
        if let Err(e) = f.validate_data(&self.room, &f.device) {
            self.note_error(&e.to_string());
            return Ok(());
        }
        let device = f.device.clone();
        if !self.devices.contains_key(&device) && self.devices.len() >= MAX_DEVICES {
            return Ok(());
        }
        let entry = self.devices.entry(device.clone()).or_default();
        let complete = entry
            .reasm
            .push(f.seq, &f.msg_id, f.chunk, f.chunks, f.total, f.payload);
        match complete {
            Some((seq, message)) => self.on_message(&device, seq, &message, write).await,
            None => Ok(()),
        }
    }

    fn note_error(&self, message: &str) {
        self.handle.app.emit_remote_error(message);
    }

    /// Drops one device's E2E session without touching the socket. The phone
    /// re-handshakes on its next `hs_start`.
    fn reset_device(&mut self, device: &str) {
        if let Some(state) = self.devices.get_mut(device) {
            state.established = false;
            state.handshake = None;
            state.keys = None;
            state.recv = ReplayWindow::default();
            state.send_seq = 0;
        }
    }

    async fn on_message(
        &mut self,
        device: &str,
        seq: u64,
        message: &[u8],
        write: &mut Write,
    ) -> Result<(), String> {
        // A plaintext hs_start always starts a fresh handshake, even when the
        // device is established: that is how the phone reacts to a new epoch.
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(message) {
            if value.get("t").and_then(|v| v.as_str()) == Some("hs_start") {
                return self.start_handshake(device, &value, write).await;
            }
        }

        let established = self
            .devices
            .get(device)
            .map(|d| d.established)
            .unwrap_or(false);
        let handshaking = self
            .devices
            .get(device)
            .map(|d| d.handshake.is_some())
            .unwrap_or(false);

        if established {
            if seq < 2 {
                return Ok(());
            }
            let Some(keys) = self.devices.get(device).and_then(|d| d.keys) else {
                return Ok(());
            };
            // Authenticate first: a forged seq must not advance the replay
            // window. Only a frame that opens cleanly is recorded.
            let plaintext = match crypto::open(&keys.t2h, &self.room, "terminal", seq, message) {
                Ok(plain) => plain,
                Err(e) => {
                    // Drop only this device and tell it to re-handshake; the
                    // session it held is unusable, the socket is not.
                    self.reset_device(device);
                    self.note_error(&format!("E2E_FAILED: {e}"));
                    let _ = self
                        .send_plain(
                            device,
                            &keys::hs_error("E2E_FAILED", "re-handshake required"),
                            write,
                        )
                        .await;
                    return Ok(());
                }
            };
            let accepted = self
                .devices
                .get_mut(device)
                .map(|state| state.recv.accept(seq))
                .unwrap_or(false);
            if !accepted {
                return Ok(()); // duplicate or outside the window
            }
            self.handle.touch_connection(device);
            self.dispatch_rpc(device, &plaintext);
            return Ok(());
        }

        if handshaking {
            if seq != 1 {
                self.reject_handshake(device, "BAD_FRAME", "hs_confirm seq must be 1", write)
                    .await;
                return Ok(());
            }
            let Some(session) = self
                .devices
                .get_mut(device)
                .and_then(|state| state.handshake.take())
            else {
                return Ok(());
            };
            let plaintext =
                match crypto::open(&session.keys.t2h, &self.room, "terminal", seq, message) {
                    Ok(plain) => plain,
                    Err(_) => {
                        self.reject_handshake(device, "BAD_FRAME", "hs_confirm", write)
                            .await;
                        return Ok(());
                    }
                };
            if let Err(code) = keys::verify_confirm(&session, &plaintext) {
                let message = if code == "AUTH_FAILED" {
                    "remote key mismatch"
                } else {
                    "invalid hs_confirm"
                };
                self.reject_handshake(device, &code, message, write).await;
                return Ok(());
            }
            self.send_plain(device, &keys::hs_ok(), write).await?;
            let name = display_name(&session.name);
            if let Some(state) = self.devices.get_mut(device) {
                state.established = true;
                state.send_seq = 2;
                state.keys = Some(session.keys);
                state.name = name.clone();
            }
            self.handle.upsert_connection(device, &name);
            super::audit::append(
                &self.data_dir,
                device,
                "connect",
                &format!("{name} connected over the relay"),
            );
            self.emit_status("online");
            return Ok(());
        }

        Ok(())
    }

    async fn start_handshake(
        &mut self,
        device: &str,
        value: &serde_json::Value,
        write: &mut Write,
    ) -> Result<(), String> {
        let now = Instant::now();
        let limited = {
            let state = self.devices.entry(device.to_string()).or_default();
            state.established = false;
            state.handshake = None;
            state.keys = None;
            state.recv = ReplayWindow::default();
            state.send_seq = 0;
            state
                .attempts
                .retain(|at| now.duration_since(*at) < Duration::from_secs(10));
            let limited = state.attempts.len() >= 5;
            if !limited {
                state.attempts.push(now);
            }
            limited
        };
        if limited {
            return self
                .send_plain(
                    device,
                    &keys::hs_error("RATE_LIMITED", "too many handshake attempts"),
                    write,
                )
                .await;
        }

        let (name, eph) = match keys::parse_start(value) {
            Ok(parsed) => parsed,
            Err(e) => {
                self.reject_handshake(device, "BAD_FRAME", &e, write).await;
                return Ok(());
            }
        };
        match keys::start(self.identity, device, &name, &eph) {
            Ok(session) => {
                let reply = keys::reply(&session);
                if let Some(state) = self.devices.get_mut(device) {
                    state.handshake = Some(session);
                }
                self.send_plain(device, &reply, write).await
            }
            Err(e) => {
                self.reject_handshake(device, "BAD_FRAME", &e, write).await;
                Ok(())
            }
        }
    }

    /// Drops the handshake and tells the phone why. The Mac never closes the
    /// relay socket here: it carries every phone.
    async fn reject_handshake(
        &mut self,
        device: &str,
        code: &str,
        message: &str,
        write: &mut Write,
    ) {
        if let Some(state) = self.devices.get_mut(device) {
            state.handshake = None;
            state.established = false;
            state.keys = None;
        }
        let _ = self
            .send_plain(device, &keys::hs_error(code, message), write)
            .await;
    }

    /// A decrypted application message. A malformed body is reported and
    /// dropped: the peer proved it holds the session key, so a bad body is a
    /// client bug, not grounds for tearing down every device.
    fn dispatch_rpc(&self, device: &str, plaintext: &[u8]) {
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(plaintext) else {
            self.note_error("BAD_FRAME: app JSON");
            return;
        };
        if value.get("t").and_then(|v| v.as_str()) != Some("rpc") {
            self.note_error("BAD_FRAME: expected rpc");
            return;
        }
        let id = value
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let method = value
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let params = value
            .get("params")
            .cloned()
            .unwrap_or(serde_json::json!({}));
        let handle = self.handle.clone();
        let device = device.to_string();
        tauri::async_runtime::spawn(async move {
            let response =
                match super::rpc::dispatch(handle.clone(), &device, &method, params).await {
                    Ok(result) => serde_json::json!({"t":"res","id":id,"result":result}),
                    Err(e) => serde_json::json!({
                        "t": "err",
                        "id": id,
                        "code": e.code,
                        "message": e.message,
                    }),
                };
            handle.send_app(Some(device), response);
        });
    }

    async fn send_plain(&self, _device: &str, body: &str, write: &mut Write) -> Result<(), String> {
        let msg_id = crypto::hex_encode(&crypto::random::<16>());
        for f in frame::frames_for(&self.room, &self.device_id, 0, &msg_id, body.as_bytes())
            .map_err(|e| e.to_string())?
        {
            self.send_frame(f, write).await?;
        }
        Ok(())
    }

    async fn send_sealed(
        &self,
        _device: &str,
        key: &[u8; 32],
        seq: u64,
        body: &str,
        write: &mut Write,
    ) -> Result<(), String> {
        let sealed = crypto::seal(key, &self.room, "host", seq, body.as_bytes())
            .map_err(|e| e.to_string())?;
        let msg_id = crypto::hex_encode(&crypto::random::<16>());
        for f in frame::frames_for(&self.room, &self.device_id, seq, &msg_id, &sealed)
            .map_err(|e| e.to_string())?
        {
            self.send_frame(f, write).await?;
        }
        Ok(())
    }

    async fn send_app(
        &mut self,
        device: &str,
        body: &str,
        write: &mut Write,
    ) -> Result<(), String> {
        let (key, seq) = {
            let Some(state) = self.devices.get_mut(device) else {
                return Ok(());
            };
            if !state.established {
                return Ok(());
            }
            let Some(keys) = state.keys else {
                return Ok(());
            };
            state.send_seq += 1;
            (keys.h2t, state.send_seq)
        };
        self.send_sealed(device, &key, seq, body, write).await
    }

    async fn send_frame(&self, f: RelayFrame, write: &mut Write) -> Result<(), String> {
        let raw = f.encode().map_err(|e| e.to_string())?;
        let text = String::from_utf8(raw).map_err(|e| e.to_string())?;
        write
            .send(Message::Text(text))
            .await
            .map_err(|e| format!("SOCKET: {e}"))
    }

    fn emit_status(&self, status: &str) {
        self.handle.app.emit_remote_event(serde_json::json!({
            "type": "status",
            "status": status,
        }));
    }
}

/// The phone name is a self-reported label, never an identity. Trim it for
/// display without touching the bytes that fed the transcript.
fn display_name(raw: &str) -> String {
    let trimmed = raw.trim();
    let clipped: String = trimmed.chars().take(64).collect();
    if clipped.is_empty() {
        "iPhone".into()
    } else {
        clipped
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub trait RemoteEvents {
    fn emit_remote_event(&self, value: serde_json::Value);
    fn emit_remote_error(&self, message: &str);
}

impl RemoteEvents for tauri::AppHandle {
    fn emit_remote_event(&self, value: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.emit("remote-event", value);
    }

    fn emit_remote_error(&self, message: &str) {
        self.emit_remote_event(serde_json::json!({
            "type": "error",
            "message": message,
        }));
    }
}
