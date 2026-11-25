//! Device pairing and reconnect credentials.
//!
//! The QR carries the room, the Mac's public keys and a one-time code; it never
//! carries the relay host token, the b-todo key or any device private key. The
//! first encrypted message (`pair_confirm`) proves knowledge of the code and
//! carries the phone's static X25519 key; the desktop then confirms the device.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::crypto;
use super::settings::{self, Identity};

pub const CODE_TTL_MS: u64 = 5 * 60 * 1000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
    pub name: String,
    /// Hex of the phone's static X25519 public key.
    pub static_public: String,
    pub created_at: u64,
    pub last_seen_at: Option<u64>,
    pub revoked: bool,
    pub revoked_at: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct DevicesFile {
    devices: Vec<Device>,
}

pub fn load_devices(data_dir: &Path) -> Vec<Device> {
    std::fs::read(settings::devices_file(data_dir))
        .ok()
        .and_then(|raw| serde_json::from_slice::<DevicesFile>(&raw).ok())
        .map(|f| f.devices)
        .unwrap_or_default()
}

fn save_devices(data_dir: &Path, devices: &[Device]) -> Result<(), String> {
    let dir = settings::remote_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("WRITE_FAILED: {e}"))?;
    let raw = serde_json::to_vec_pretty(&DevicesFile {
        devices: devices.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    let path = settings::devices_file(data_dir);
    let tmp = dir.join("devices.json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("WRITE_FAILED: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("WRITE_FAILED: {e}"))
}

pub fn find_device(data_dir: &Path, device_id: &str) -> Option<Device> {
    load_devices(data_dir)
        .into_iter()
        .find(|d| d.device_id == device_id)
}

pub fn upsert_device(data_dir: &Path, device: Device) -> Result<(), String> {
    let mut devices = load_devices(data_dir);
    match devices.iter_mut().find(|d| d.device_id == device.device_id) {
        Some(slot) => *slot = device,
        None => devices.push(device),
    }
    save_devices(data_dir, &devices)
}

pub fn revoke_device(data_dir: &Path, device_id: &str) -> Result<(), String> {
    let mut devices = load_devices(data_dir);
    let Some(slot) = devices.iter_mut().find(|d| d.device_id == device_id) else {
        return Err("NOT_FOUND: device".into());
    };
    if !slot.revoked {
        slot.revoked = true;
        slot.revoked_at = Some(now_ms());
    }
    save_devices(data_dir, &devices)
}

pub fn touch_device(data_dir: &Path, device_id: &str) {
    let mut devices = load_devices(data_dir);
    if let Some(slot) = devices.iter_mut().find(|d| d.device_id == device_id) {
        slot.last_seen_at = Some(now_ms());
        let _ = save_devices(data_dir, &devices);
    }
}

/// The QR the desktop shows. `code` is one-time and expires at `expires_at`.
#[derive(Debug, Clone)]
pub struct PairingOffer {
    pub room: String,
    pub code: [u8; 16],
    pub expires_at: u64,
    pub payload: String,
    /// Set when a `pair_confirm` with a valid proof arrives; the same QR can
    /// never pair a second phone.
    pub consumed: bool,
}

pub fn new_offer(identity: &Identity, relay_url: &str) -> PairingOffer {
    let code = crypto::random::<16>();
    let expires_at = now_ms() + CODE_TTL_MS;
    let payload = qr_payload(
        relay_url,
        &identity.room,
        &identity.mac_ed_public,
        &identity.mac_x_public,
        &code,
        expires_at,
    );
    PairingOffer {
        room: identity.room.clone(),
        code,
        expires_at,
        payload,
        consumed: false,
    }
}

pub fn qr_payload(
    relay_url: &str,
    room: &str,
    mac_ed: &[u8; 32],
    mac_x: &[u8; 32],
    code: &[u8; 16],
    expires_at: u64,
) -> String {
    format!(
        "bnote-mobile://pair?v=1&relay={}&room={}&mac_ed={}&mac_x={}&code={}&exp={}",
        percent_encode(relay_url),
        room,
        crypto::hex_encode(mac_ed),
        crypto::hex_encode(mac_x),
        crypto::hex_encode(code),
        expires_at
    )
}

/// Percent-encodes the characters that would break a query value. The relay
/// URL is ASCII in practice; UTF-8 is still handled byte by byte.
fn percent_encode(value: &str) -> String {
    const KEEP: &[u8] = b"-._~";
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || KEEP.contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The half of the pairing handshake the host computes before `pair_confirm`.
#[derive(Debug)]
pub struct PairingSession {
    pub room: String,
    pub device_id: String,
    pub phone_eph: [u8; 32],
    pub mac_eph_secret: [u8; 32],
    pub mac_eph_public: [u8; 32],
    pub th: [u8; 32],
    pub h2t: [u8; 32],
    pub t2h: [u8; 32],
    pub response: String,
}

pub fn start_pairing(
    identity: &Identity,
    device_id: &str,
    phone_eph: &[u8; 32],
) -> Result<PairingSession, String> {
    if device_id.len() != 32 || !device_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("BAD_PARAMS: deviceId".into());
    }
    let (mac_eph_secret, mac_eph_public) = crypto::new_x25519();
    let th = crypto::transcript_pair(
        &identity.room,
        device_id,
        &identity.mac_ed_public,
        &identity.mac_x_public,
        phone_eph,
        &mac_eph_public,
    );
    let ss = crypto::x25519(&mac_eph_secret, phone_eph).map_err(|e| e.to_string())?;
    let (h2t, t2h) = crypto::derive_keys(&ss, &th).map_err(|e| e.to_string())?;
    let sig = crypto::sign(&identity.mac_ed_seed, &th);
    let response = serde_json::json!({
        "t": "pair_response",
        "macEph": crypto::hex_encode(&mac_eph_public),
        "sig": crypto::hex_encode(&sig),
    })
    .to_string();
    Ok(PairingSession {
        room: identity.room.clone(),
        device_id: device_id.to_string(),
        phone_eph: *phone_eph,
        mac_eph_secret,
        mac_eph_public,
        th,
        h2t,
        t2h,
        response,
    })
}

/// Verifies the encrypted `pair_confirm` payload and returns the device record
/// that the desktop is about to approve.
pub fn finish_pairing(
    session: &PairingSession,
    code: &[u8; 16],
    plaintext: &[u8],
) -> Result<Device, String> {
    let value: serde_json::Value =
        serde_json::from_slice(plaintext).map_err(|_| "BAD_FRAME: pair_confirm".to_string())?;
    if value.get("t").and_then(|v| v.as_str()) != Some("pair_confirm") {
        return Err("BAD_FRAME: expected pair_confirm".into());
    }
    let proof = value
        .get("proof")
        .and_then(|v| v.as_str())
        .ok_or("BAD_PARAMS: proof")?;
    let proof = crypto::hex32(proof).map_err(|e| e.to_string())?;
    if !crypto::verify_proof(code, &session.th, &proof) {
        return Err("PAIR_CODE_INVALID".into());
    }
    let static_public = value
        .get("static")
        .and_then(|v| v.as_str())
        .ok_or("BAD_PARAMS: static")?;
    let static_public = crypto::hex32(static_public).map_err(|e| e.to_string())?;
    if crypto::x25519(&session.mac_eph_secret, &static_public).is_err() {
        return Err("BAD_PARAMS: static key is low order".into());
    }
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("iPhone")
        .trim()
        .chars()
        .take(64)
        .collect::<String>();
    Ok(Device {
        device_id: session.device_id.clone(),
        name: if name.is_empty() {
            "iPhone".into()
        } else {
            name
        },
        static_public: crypto::hex_encode(&static_public),
        created_at: now_ms(),
        last_seen_at: None,
        revoked: false,
        revoked_at: None,
    })
}

/// The host half of a reconnect: derive keys from the device's static key and
/// the fresh ephemerals.
#[derive(Debug)]
pub struct AuthSession {
    pub device_id: String,
    pub mac_eph_public: [u8; 32],
    pub th: [u8; 32],
    pub h2t: [u8; 32],
    pub t2h: [u8; 32],
    pub response: String,
}

pub fn start_auth(
    identity: &Identity,
    device: &Device,
    phone_eph: &[u8; 32],
) -> Result<AuthSession, String> {
    if device.revoked {
        return Err("DEVICE_REVOKED".into());
    }
    let static_public = crypto::hex32(&device.static_public).map_err(|e| e.to_string())?;
    let (mac_eph_secret, mac_eph_public) = crypto::new_x25519();
    let th = crypto::transcript_auth(
        &identity.room,
        &device.device_id,
        &identity.mac_ed_public,
        &identity.mac_x_public,
        &static_public,
        phone_eph,
        &mac_eph_public,
    );
    let ss = [
        crypto::x25519(&identity.mac_x_secret, phone_eph).map_err(|e| e.to_string())?,
        crypto::x25519(&mac_eph_secret, &static_public).map_err(|e| e.to_string())?,
    ]
    .concat();
    let (h2t, t2h) = crypto::derive_keys(&ss, &th).map_err(|e| e.to_string())?;
    let sig = crypto::sign(&identity.mac_ed_seed, &th);
    let response = serde_json::json!({
        "t": "auth_response",
        "macEph": crypto::hex_encode(&mac_eph_public),
        "sig": crypto::hex_encode(&sig),
    })
    .to_string();
    Ok(AuthSession {
        device_id: device.device_id.clone(),
        mac_eph_public,
        th,
        h2t,
        t2h,
        response,
    })
}

/// JSON the host sends once the desktop approved the device.
pub fn pair_ok(device_id: &str) -> String {
    serde_json::json!({"t": "pair_ok", "deviceId": device_id}).to_string()
}

pub fn hs_error(code: &str, message: &str) -> String {
    serde_json::json!({"t": "hs_error", "code": code, "message": message}).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> Identity {
        let (ed_seed, ed_public) = crypto::new_ed25519();
        let (x_secret, x_public) = crypto::new_x25519();
        Identity {
            device_id: "11".repeat(16),
            room: "00".repeat(16),
            host_token: [9u8; 32],
            mac_ed_seed: ed_seed,
            mac_ed_public: ed_public,
            mac_x_secret: x_secret,
            mac_x_public: x_public,
        }
    }

    #[test]
    fn qr_has_no_secrets_and_round_trips_the_room() {
        let id = identity();
        let offer = new_offer(&id, "wss://101.96.243.197/bnote-relay/ws");
        assert!(offer.payload.starts_with("bnote-mobile://pair?v=1&"));
        assert!(offer.payload.contains(&format!("room={}", id.room)));
        assert!(offer
            .payload
            .contains("relay=wss%3A%2F%2F101.96.243.197%2Fbnote-relay%2Fws"));
        assert!(!offer.payload.contains("hostToken"));
        assert!(!offer.payload.to_lowercase().contains("token"));
        assert_eq!(offer.expires_at > now_ms(), true);
    }

    #[test]
    fn pairing_proves_the_code_and_records_the_static_key() {
        let id = identity();
        let offer = new_offer(&id, "wss://example/ws");
        let (phone_eph_secret, phone_eph) = crypto::new_x25519();
        let session = start_pairing(&id, &"ab".repeat(16), &phone_eph).expect("start");

        // The phone derives the same keys and builds the confirm.
        let th = crypto::transcript_pair(
            &id.room,
            &"ab".repeat(16),
            &id.mac_ed_public,
            &id.mac_x_public,
            &phone_eph,
            &session.mac_eph_public,
        );
        assert_eq!(th, session.th);
        let ss = crypto::x25519(&phone_eph_secret, &session.mac_eph_public).expect("ss");
        let (h2t, t2h) = crypto::derive_keys(&ss, &th).expect("keys");
        assert_eq!(h2t, session.h2t);
        assert_eq!(t2h, session.t2h);
        let proof = crypto::pairing_proof(&offer.code, &th);
        let (_, phone_static) = crypto::new_x25519();
        let confirm = serde_json::json!({
            "t": "pair_confirm",
            "proof": crypto::hex_encode(&proof),
            "static": crypto::hex_encode(&phone_static),
            "name": "iPhone 15",
        })
        .to_string();

        let device = finish_pairing(&session, &offer.code, confirm.as_bytes()).expect("finish");
        assert_eq!(device.name, "iPhone 15");
        assert_eq!(device.static_public, crypto::hex_encode(&phone_static));

        // A wrong code must be refused.
        let wrong = [7u8; 16];
        assert_eq!(
            finish_pairing(&session, &wrong, confirm.as_bytes()).unwrap_err(),
            "PAIR_CODE_INVALID"
        );
    }

    #[test]
    fn auth_derives_both_sides_identically_and_refuses_revoked() {
        let id = identity();
        let (phone_static_secret, phone_static) = crypto::new_x25519();
        let device = Device {
            device_id: "ab".repeat(16),
            name: "iPhone".into(),
            static_public: crypto::hex_encode(&phone_static),
            created_at: 0,
            last_seen_at: None,
            revoked: false,
            revoked_at: None,
        };
        let (phone_eph_secret, phone_eph) = crypto::new_x25519();
        let auth = start_auth(&id, &device, &phone_eph).expect("auth");

        let th = crypto::transcript_auth(
            &id.room,
            &device.device_id,
            &id.mac_ed_public,
            &id.mac_x_public,
            &phone_static,
            &phone_eph,
            &auth.mac_eph_public,
        );
        assert_eq!(th, auth.th);
        let ss = [
            crypto::x25519(&phone_eph_secret, &id.mac_x_public).expect("a"),
            crypto::x25519(&phone_static_secret, &auth.mac_eph_public).expect("b"),
        ]
        .concat();
        let (h2t, t2h) = crypto::derive_keys(&ss, &th).expect("keys");
        assert_eq!(h2t, auth.h2t);
        assert_eq!(t2h, auth.t2h);

        let mut revoked = device;
        revoked.revoked = true;
        assert_eq!(
            start_auth(&id, &revoked, &phone_eph).unwrap_err(),
            "DEVICE_REVOKED"
        );
    }
}
