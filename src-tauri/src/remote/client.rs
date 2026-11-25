//! Outbound WSS connection to the relay, the pairing/reconnect handshake, and
//! the per-device E2E state.
//!
//! The Mac never listens. The relay routes by room; this module authenticates
//! the room as the host, then keeps one encrypted session per paired phone.
//! All writes happen on the connection task, so per-device `seq` allocation
//! and the socket are single-owner.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::crypto::{self, Reassembler, ReplayWindow};
use super::frame::{self, FrameType, RelayFrame};
use super::pairing::{self, Device, PairingOffer, PairingSession};
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
    Approve { device_id: String, allow: bool },
    Revoke { device_id: String },
    Send { device_id: String, text: String },
}

#[derive(Clone)]
pub struct ClientHandle {
    pub out: mpsc::UnboundedSender<Outgoing>,
    pub control: mpsc::UnboundedSender<Control>,
    pub app: tauri::AppHandle,
    subscribed: Arc<Mutex<HashSet<String>>>,
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
}

#[derive(Default)]
struct DeviceConn {
    t2h: Option<[u8; 32]>,
    h2t: Option<[u8; 32]>,
    established: bool,
    send_seq: u64,
    recv: ReplayWindow,
    reasm: Reassembler,
    pairing: Option<PairingSession>,
    auth: Option<pairing::AuthSession>,
    pending: Option<Device>,
}

/// One connection attempt. The manager owns the channels across attempts, so a
/// reconnect keeps the event subscriptions and pending UI state.
pub async fn connect_loop(
    relay_url: &str,
    identity: &Identity,
    data_dir: &std::path::Path,
    offer: Arc<Mutex<Option<PairingOffer>>>,
    handle: &ClientHandle,
    control: &mut mpsc::UnboundedReceiver<Control>,
    outgoing: &mut mpsc::UnboundedReceiver<Outgoing>,
) -> Result<(), String> {
    let ws = tokio_tungstenite::connect_async_tls_with_config(
        relay_url,
        None,
        false,
        Some(tokio_tungstenite::Connector::Rustls(
            Arc::new(tls_config()?),
        )),
    )
    .await
    .map_err(|e| format!("CONNECT_FAILED: {e}"))?
    .0;
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
        offer,
        devices: HashMap::new(),
        handle: handle.clone(),
    };
    conn.emit_status("online");

    loop {
        tokio::select! {
            message = read.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if let Err(e) = conn.on_frame(text.as_bytes(), &mut write).await {
                            conn.handle.app.emit_remote_error(&e);
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = write.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Err(e)) => return Err(format!("SOCKET: {e}")),
                    _ => {}
                }
            }
            Some(control) = control.recv() => {
                match control {
                    Control::Stop => return Ok(()),
                    Control::Approve { device_id, allow } => {
                        conn.approve(&device_id, allow, &mut write).await;
                    }
                    Control::Revoke { device_id } => {
                        conn.devices.remove(&device_id);
                        conn.emit_status("online");
                    }
                    Control::Send { device_id, text } => {
                        let _ = conn.send_app(&device_id, &text, &mut write).await;
                    }
                }
            }
            Some(out) = outgoing.recv() => {
                if let Outgoing::App { device, text } = out {
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
    }
}

struct Conn<'a> {
    room: String,
    device_id: String,
    identity: &'a Identity,
    data_dir: std::path::PathBuf,
    offer: Arc<Mutex<Option<PairingOffer>>>,
    devices: HashMap<String, DeviceConn>,
    handle: ClientHandle,
}

/// The b-todo credentials the phone should receive after pairing. They live in
/// the desktop config; `http://` is upgraded to `https://` because the phone
/// refuses plaintext and the 443 endpoint serves the same server.
fn todo_config_from_disk(data_dir: &std::path::Path) -> Option<(String, String)> {
    let raw = std::fs::read_to_string(data_dir.join("config.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let sync = value.get("settings")?.get("daily")?.get("sync")?;
    let server = sync.get("server")?.as_str()?.trim();
    let key = sync.get("key")?.as_str()?.trim();
    if server.is_empty() || key.is_empty() {
        return None;
    }
    let server = match server.strip_prefix("http://") {
        Some(rest) => format!("https://{rest}"),
        None => server.to_string(),
    };
    Some((server, key.to_string()))
}

impl Conn<'_> {
    async fn on_frame(&mut self, raw: &[u8], write: &mut Write) -> Result<(), String> {
        let f = RelayFrame::decode(raw).map_err(|e| e.to_string())?;
        match f.kind {
            FrameType::Ping => self.send_frame(RelayFrame::pong(), write).await,
            FrameType::Pong => Ok(()),
            FrameType::Error => Err(format!("RELAY_ERROR: {} {}", f.code, f.message)),
            FrameType::Data => {
                let device = f.device.clone();
                if f.msg_id.is_empty() {
                    return Ok(());
                }
                let entry = self.devices.entry(device.clone()).or_default();
                let complete = entry.reasm.push(
                    f.seq,
                    &f.msg_id,
                    f.chunk,
                    f.chunks,
                    f.total,
                    f.payload.clone(),
                );
                match complete {
                    Some((seq, message)) => self.on_message(&device, seq, &message, write).await,
                    None => Ok(()),
                }
            }
            _ => Ok(()),
        }
    }

    async fn on_message(
        &mut self,
        device: &str,
        seq: u64,
        message: &[u8],
        write: &mut Write,
    ) -> Result<(), String> {
        let has_keys = self
            .devices
            .get(device)
            .map(|d| d.t2h.is_some())
            .unwrap_or(false);

        if !has_keys {
            let value: serde_json::Value = serde_json::from_slice(message)
                .map_err(|_| "BAD_FRAME: handshake is not JSON".to_string())?;
            let kind = value.get("t").and_then(|v| v.as_str()).unwrap_or("");
            return match kind {
                "pair_request" => self.on_pair_request(device, &value, write).await,
                "auth_request" => self.on_auth_request(device, &value, write).await,
                _ => Err(format!("BAD_FRAME: unexpected handshake {kind}")),
            };
        }

        let state = self
            .devices
            .get(device)
            .ok_or("BAD_FRAME: unknown device")?;
        let t2h = state.t2h.ok_or("BAD_FRAME: no key")?;
        let plaintext = crypto::open(&t2h, &self.room, "terminal", seq, message)
            .map_err(|e| format!("E2E_FAILED: {e}"))?;

        if state.pairing.is_some() {
            if seq != 1 {
                return Err("BAD_FRAME: pair_confirm seq must be 1".into());
            }
            return self.finish_pair(device, &plaintext, write).await;
        }
        if state.auth.is_some() {
            if seq != 1 {
                return Err("BAD_FRAME: auth_confirm seq must be 1".into());
            }
            return self.finish_auth(device, &plaintext, write).await;
        }
        if !state.established {
            return Err("BAD_FRAME: encrypted message before handshake".into());
        }

        let state = self
            .devices
            .get_mut(device)
            .ok_or("BAD_FRAME: unknown device")?;
        if !state.recv.accept(seq) {
            return Ok(()); // duplicate or outside the window
        }
        let value: serde_json::Value =
            serde_json::from_slice(&plaintext).map_err(|_| "BAD_FRAME: app JSON".to_string())?;
        if value.get("t").and_then(|v| v.as_str()) != Some("rpc") {
            return Err("BAD_FRAME: expected rpc".into());
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
        Ok(())
    }

    async fn on_pair_request(
        &mut self,
        device: &str,
        value: &serde_json::Value,
        write: &mut Write,
    ) -> Result<(), String> {
        let active = {
            let offer = self.offer.lock().unwrap_or_else(|e| e.into_inner());
            match offer.as_ref() {
                Some(o) if !o.consumed && o.expires_at > now_ms() && o.room == self.room => {
                    Some(o.clone())
                }
                _ => None,
            }
        };
        let Some(_offer) = active else {
            return self
                .send_plain(
                    device,
                    &pairing::hs_error("PAIR_CLOSED", "no active QR"),
                    write,
                )
                .await;
        };
        let eph = value
            .get("eph")
            .and_then(|v| v.as_str())
            .ok_or("BAD_PARAMS: eph")?;
        let eph = crypto::hex32(eph).map_err(|e| e.to_string())?;
        let session = pairing::start_pairing(self.identity, device, &eph)?;
        let response = session.response.clone();
        let state = self.devices.entry(device.to_string()).or_default();
        state.pairing = Some(session);
        state.t2h = state.pairing.as_ref().map(|s| s.t2h);
        state.h2t = state.pairing.as_ref().map(|s| s.h2t);
        self.send_plain(device, &response, write).await
    }

    async fn finish_pair(
        &mut self,
        device: &str,
        plaintext: &[u8],
        write: &mut Write,
    ) -> Result<(), String> {
        let code = {
            let offer = self.offer.lock().unwrap_or_else(|e| e.into_inner());
            offer.as_ref().map(|o| o.code)
        };
        let Some(code) = code else {
            return self
                .send_plain(
                    device,
                    &pairing::hs_error("PAIR_CLOSED", "no active QR"),
                    write,
                )
                .await;
        };
        let state = self
            .devices
            .get_mut(device)
            .ok_or("BAD_FRAME: unknown device")?;
        let session = state.pairing.as_ref().ok_or("BAD_FRAME: no pairing")?;
        let record = match pairing::finish_pairing(session, &code, plaintext) {
            Ok(record) => record,
            Err(e) => {
                let code = if e == "PAIR_CODE_INVALID" {
                    "PAIR_CODE_INVALID"
                } else {
                    "BAD_FRAME"
                };
                return self
                    .send_plain(device, &pairing::hs_error(code, &e), write)
                    .await;
            }
        };
        // The one-time code is spent once a valid confirm arrives, before the
        // desktop prompt: a second phone cannot reuse it while the user thinks.
        if let Ok(mut offer) = self.offer.lock() {
            if let Some(o) = offer.as_mut() {
                o.consumed = true;
            }
        }
        state.pending = Some(record.clone());
        self.handle.app.emit_remote_event(serde_json::json!({
            "type": "pairing_request",
            "deviceId": record.device_id,
            "name": record.name,
        }));
        Ok(())
    }

    async fn on_auth_request(
        &mut self,
        device: &str,
        value: &serde_json::Value,
        write: &mut Write,
    ) -> Result<(), String> {
        let Some(record) = pairing::find_device(&self.data_dir, device) else {
            return self
                .send_plain(
                    device,
                    &pairing::hs_error("DEVICE_UNKNOWN", "pair this phone first"),
                    write,
                )
                .await;
        };
        if record.revoked {
            return self
                .send_plain(
                    device,
                    &pairing::hs_error("DEVICE_REVOKED", "device revoked"),
                    write,
                )
                .await;
        }
        let eph = value
            .get("eph")
            .and_then(|v| v.as_str())
            .ok_or("BAD_PARAMS: eph")?;
        let eph = crypto::hex32(eph).map_err(|e| e.to_string())?;
        let session = pairing::start_auth(self.identity, &record, &eph)?;
        let response = session.response.clone();
        let state = self.devices.entry(device.to_string()).or_default();
        state.auth = Some(session);
        state.t2h = state.auth.as_ref().map(|a| a.t2h);
        state.h2t = state.auth.as_ref().map(|a| a.h2t);
        self.send_plain(device, &response, write).await
    }

    async fn finish_auth(
        &mut self,
        device: &str,
        plaintext: &[u8],
        write: &mut Write,
    ) -> Result<(), String> {
        let value: serde_json::Value =
            serde_json::from_slice(plaintext).map_err(|_| "BAD_FRAME: auth_confirm".to_string())?;
        if value.get("t").and_then(|v| v.as_str()) != Some("auth_confirm") {
            return Err("BAD_FRAME: expected auth_confirm".into());
        }
        let key = self
            .devices
            .get(device)
            .and_then(|state| state.h2t)
            .ok_or("BAD_FRAME: no key")?;
        self.send_sealed(device, &key, 1, "{\"t\":\"auth_ok\"}", write)
            .await?;
        if let Some(state) = self.devices.get_mut(device) {
            state.established = true;
            state.send_seq = 2;
            state.auth = None;
        }
        pairing::touch_device(&self.data_dir, device);
        self.emit_status("online");
        Ok(())
    }

    async fn approve(&mut self, device: &str, allow: bool, write: &mut Write) {
        let (h2t, pending) = {
            let Some(state) = self.devices.get_mut(device) else {
                return;
            };
            let (Some(h2t), Some(_)) = (state.h2t, state.t2h) else {
                return;
            };
            (h2t, state.pending.take())
        };
        if allow {
            if let Some(record) = pending {
                let _ = pairing::upsert_device(&self.data_dir, record);
            }
            let body = pairing::pair_ok(device);
            let _ = self.send_sealed(device, &h2t, 1, &body, write).await;
            if let Some(state) = self.devices.get_mut(device) {
                state.established = true;
                state.send_seq = 2;
                state.pairing = None;
            }
            // The phone configures b-todo without the user retyping the key.
            if let Some((server, key)) = todo_config_from_disk(&self.data_dir) {
                let body = serde_json::json!({
                    "t": "rpc",
                    "id": crypto::hex_encode(&crypto::random::<16>()),
                    "method": "todo.config",
                    "params": { "server": server, "key": key },
                })
                .to_string();
                let _ = self.send_app(device, &body, write).await;
            }
            self.handle.app.emit_remote_event(serde_json::json!({
                "type": "device_paired",
                "deviceId": device,
            }));
        } else {
            let body = serde_json::json!({"t":"pair_denied","reason":"user"}).to_string();
            let _ = self.send_sealed(device, &h2t, 1, &body, write).await;
            self.devices.remove(device);
        }
        self.emit_status("online");
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
            let Some(key) = state.h2t else {
                return Ok(());
            };
            state.send_seq += 1;
            (key, state.send_seq)
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

fn tls_config() -> Result<rustls::ClientConfig, String> {
    let mut roots = rustls::RootCertStore::empty();
    let certs = rustls_pemfile::certs(&mut &settings::ROOT_CERT_PEM[..])
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("TLS_PIN: {e}"))?;
    if certs.is_empty() {
        return Err("TLS_PIN: bundled certificate is empty".into());
    }
    for cert in certs {
        roots.add(cert).map_err(|e| format!("TLS_PIN: {e}"))?;
    }
    let provider = rustls::crypto::aws_lc_rs::default_provider();
    Ok(
        rustls::ClientConfig::builder_with_provider(Arc::new(provider))
            .with_safe_default_protocol_versions()
            .map_err(|e| format!("TLS_PIN: {e}"))?
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
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

#[cfg(test)]
mod tests {
    use super::todo_config_from_disk;

    fn write_config(dir: &std::path::Path, body: &str) {
        std::fs::write(dir.join("config.json"), body).expect("write config");
    }

    #[test]
    fn todo_config_upgrades_http_and_trims() {
        let dir = std::env::temp_dir().join(format!("bnote-todo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        write_config(
            &dir,
            r#"{"settings":{"daily":{"sync":{"server":" http://101.96.243.197/b-todo ","key":" k "}}}}"#,
        );
        let (server, key) = todo_config_from_disk(&dir).expect("config");
        assert_eq!(server, "https://101.96.243.197/b-todo");
        assert_eq!(key, "k");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn todo_config_absent_or_incomplete_is_none() {
        let dir = std::env::temp_dir().join(format!("bnote-todo-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        assert!(todo_config_from_disk(&dir).is_none());
        write_config(
            &dir,
            r#"{"settings":{"daily":{"sync":{"server":"https://x","key":""}}}}"#,
        );
        assert!(todo_config_from_disk(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
