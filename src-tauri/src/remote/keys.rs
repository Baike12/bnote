//! Host half of the v2 handshake.
//!
//! The phone sends `hs_start` in plaintext; the Mac answers with its ephemeral
//! key and a keyed tag, then verifies the phone's tag on `hs_confirm`. Nothing
//! here persists: a handshake lives for one connection attempt, and every new
//! `hs_start` replaces it.

use serde_json::Value;

use super::crypto::{self, HandshakeKeys};
use super::settings::Identity;

pub struct HandshakeSession {
    pub device_id: String,
    pub name: String,
    pub host_eph_public: [u8; 32],
    pub th: [u8; 32],
    pub keys: HandshakeKeys,
    pub phone_tag: [u8; 32],
}

/// The Mac's reply to `hs_start`: `{"t":"hs_reply","eph":…,"tag":…}`.
pub fn start(
    identity: &Identity,
    device_id: &str,
    name: &str,
    phone_eph: &[u8; 32],
) -> Result<HandshakeSession, String> {
    if !valid_hex(device_id, 32) {
        return Err("BAD_PARAMS: deviceId".into());
    }
    if name.len() > 64 {
        return Err("BAD_PARAMS: name".into());
    }
    let (host_secret, host_eph_public) = crypto::new_x25519();
    let th =
        crypto::handshake_transcript(&identity.room, device_id, name, phone_eph, &host_eph_public)
            .map_err(|e| e.to_string())?;
    let ss = crypto::x25519(&host_secret, phone_eph).map_err(|e| e.to_string())?;
    let keys = crypto::derive_keys(&identity.psk, &ss, &th).map_err(|e| e.to_string())?;
    let phone_tag = crypto::phone_tag(&keys.k_auth, &th);
    Ok(HandshakeSession {
        device_id: device_id.to_string(),
        name: name.to_string(),
        host_eph_public,
        th,
        keys,
        phone_tag,
    })
}

pub fn reply(session: &HandshakeSession) -> String {
    serde_json::json!({
        "t": "hs_reply",
        "eph": crypto::hex_encode(&session.host_eph_public),
        "tag": crypto::hex_encode(&crypto::host_tag(&session.keys.k_auth, &session.th)),
    })
    .to_string()
}

/// Parses an `hs_start` value into `(name, eph)`. A missing or malformed name
/// is refused rather than defaulted: it feeds the transcript.
pub fn parse_start(value: &Value) -> Result<(String, [u8; 32]), String> {
    if value.get("t").and_then(Value::as_str) != Some("hs_start") {
        return Err("BAD_FRAME: expected hs_start".into());
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .ok_or("BAD_PARAMS: name")?;
    if name.len() > 64 {
        return Err("BAD_PARAMS: name".into());
    }
    let eph = value
        .get("eph")
        .and_then(Value::as_str)
        .ok_or("BAD_PARAMS: eph")?;
    let eph = crypto::hex32(eph).map_err(|e| e.to_string())?;
    Ok((name.to_string(), eph))
}

/// Verifies the encrypted `hs_confirm`. A wrong tag means the phone's remote
/// key differs from this Mac's.
pub fn verify_confirm(session: &HandshakeSession, plaintext: &[u8]) -> Result<(), String> {
    let value: Value =
        serde_json::from_slice(plaintext).map_err(|_| "BAD_FRAME: hs_confirm".to_string())?;
    if value.get("t").and_then(Value::as_str) != Some("hs_confirm") {
        return Err("BAD_FRAME: expected hs_confirm".into());
    }
    let tag = value
        .get("tag")
        .and_then(Value::as_str)
        .ok_or("BAD_PARAMS: tag")?;
    let tag = crypto::hex32(tag).map_err(|e| e.to_string())?;
    if !crypto::tag_matches(&session.phone_tag, &tag) {
        return Err("AUTH_FAILED".into());
    }
    Ok(())
}

pub fn hs_ok() -> String {
    "{\"t\":\"hs_ok\"}".to_string()
}

pub fn hs_error(code: &str, message: &str) -> String {
    serde_json::json!({"t": "hs_error", "code": code, "message": message}).to_string()
}

fn valid_hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(remote_key: [u8; 32]) -> Identity {
        Identity {
            device_id: "11".repeat(16),
            room: crypto::hex_encode(&crypto::derive_room(&remote_key)),
            psk: crypto::derive_psk(&remote_key),
            host_token: [9u8; 32],
            remote_key,
        }
    }

    #[test]
    fn both_sides_agree_and_tags_are_bound_to_the_transcript() {
        let id = identity([5u8; 32]);
        let device = "ab".repeat(16);
        let (phone_secret, phone_public) = crypto::new_x25519();
        let session = start(&id, &device, "iPhone", &phone_public).expect("start");

        // The phone repeats the derivation from its own secret.
        let th = crypto::handshake_transcript(
            &id.room,
            &device,
            "iPhone",
            &phone_public,
            &session.host_eph_public,
        )
        .expect("th");
        assert_eq!(th, session.th);
        let ss = crypto::x25519(&phone_secret, &session.host_eph_public).expect("ss");
        let keys = crypto::derive_keys(&id.psk, &ss, &th).expect("keys");
        assert_eq!(keys.h2t, session.keys.h2t);
        assert_eq!(keys.t2h, session.keys.t2h);
        assert_eq!(
            crypto::host_tag(&keys.k_auth, &th),
            crypto::host_tag(&session.keys.k_auth, &session.th)
        );

        let confirm = serde_json::json!({
            "t": "hs_confirm",
            "tag": crypto::hex_encode(&crypto::phone_tag(&keys.k_auth, &th)),
        })
        .to_string();
        verify_confirm(&session, confirm.as_bytes()).expect("confirm");

        let wrong = serde_json::json!({
            "t": "hs_confirm",
            "tag": crypto::hex_encode(&[0u8; 32]),
        })
        .to_string();
        assert_eq!(
            verify_confirm(&session, wrong.as_bytes()).unwrap_err(),
            "AUTH_FAILED"
        );

        // A different name changes TH and therefore both tags.
        let other = start(&id, &device, "iPad", &phone_public).expect("start");
        assert_ne!(other.th, session.th);
        assert_ne!(other.phone_tag, session.phone_tag);
    }
}
