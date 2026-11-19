//! End-to-end encryption for the daily todo sync, shared byte for byte with
//! the b-todo server and its mobile web page (both pin the same RFC 5869 and
//! AES-GCM golden vectors in their test suites).
//!
//! Threat model: the server sits on the open internet and stores only
//! ciphertext. The user key never crosses the wire; what crosses is
//!
//!   auth = base64(HKDF-SHA256(key, salt "b-todo-sync-v1", info "b-todo-auth-v1"))
//!
//! as a Bearer credential (the server keeps only its SHA-256), while
//!
//!   enc = HKDF-SHA256(key, salt 同上, info "b-todo-enc-v1")
//!
//! seals each document with AES-256-GCM (random 12-byte nonce, AAD binds the
//! date). Derivation lengths and encodings must not drift: `base64` is the
//! standard alphabet WITHOUT padding (Go's RawStdEncoding on the server).

use aes_gcm::aead::{Aead, AeadCore, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine as _;
use hkdf::Hkdf;
use sha2::Sha256;

pub const KDF_SALT: &[u8] = b"b-todo-sync-v1";
pub const AUTH_INFO: &[u8] = b"b-todo-auth-v1";
pub const ENC_INFO: &[u8] = b"b-todo-enc-v1";

/// The Bearer credential derived from the user key. Every request carries it.
pub fn auth_token(key: &str) -> String {
    let hk = Hkdf::<Sha256>::new(Some(KDF_SALT), key.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(AUTH_INFO, &mut okm)
        .expect("32 bytes is a valid HKDF length");
    STANDARD_NO_PAD.encode(okm)
}

/// Hex SHA-256 of the auth token — what the server provisioned with, used by
/// the local test-suite golden only (this client compares nothing).
pub fn auth_token_hash(key: &str) -> String {
    use sha2::Digest;
    let digest = Sha256::digest(auth_token(key).as_bytes());
    hex(&digest)
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Seals one day document. Nonce is random per message (OsRng via the getrandom
/// feature aes-gcm ships by default); the AAD binds the date so a ciphertext
/// cannot be replayed onto another day.
pub fn seal_day(
    enc_key: &[u8; 32],
    date: &str,
    plaintext: &str,
) -> Result<(String, String), String> {
    let cipher = Aes256Gcm::new_from_slice(enc_key).map_err(|e| format!("CRYPTO: {e}"))?;
    let nonce = Aes256Gcm::generate_nonce(&mut aes_gcm::aead::rand_core::OsRng);
    let bound = aad(date);
    let payload = Payload {
        msg: plaintext.as_bytes(),
        aad: bound.as_bytes(),
    };
    let ct = cipher
        .encrypt(&nonce, payload)
        .map_err(|_| "CRYPTO: seal failed".to_string())?;
    Ok((STANDARD_NO_PAD.encode(nonce), STANDARD_NO_PAD.encode(ct)))
}

/// Opens one day document; fails when the key or the date (AAD) mismatches.
pub fn open_day(
    enc_key: &[u8; 32],
    date: &str,
    nonce_b64: &str,
    ct_b64: &str,
) -> Result<String, String> {
    let nonce_raw = STANDARD_NO_PAD
        .decode(nonce_b64)
        .map_err(|e| format!("CRYPTO: nonce 不是合法 base64: {e}"))?;
    let ct = STANDARD_NO_PAD
        .decode(ct_b64)
        .map_err(|e| format!("CRYPTO: 密文不是合法 base64: {e}"))?;
    if nonce_raw.len() != 12 {
        return Err("CRYPTO: nonce 长度不是 12 字节".to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(enc_key).map_err(|e| format!("CRYPTO: {e}"))?;
    let bound = aad(date);
    let payload = Payload {
        msg: &ct,
        aad: bound.as_bytes(),
    };
    let plain = cipher
        .decrypt(aes_gcm::Nonce::from_slice(&nonce_raw), payload)
        .map_err(|_| "CRYPTO: 解密失败(密钥不一致或数据被篡改)".to_string())?;
    String::from_utf8(plain).map_err(|_| "CRYPTO: 解密结果不是 UTF-8".to_string())
}

fn aad(date: &str) -> String {
    format!("b-todo|day|{date}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The golden key the Go server and the web page pin as well; changing
    /// any KDF/AEAD parameter on one side breaks all three suites together.
    const GOLDEN_KEY: &str = "b-todo-golden-key-01";

    #[test]
    fn auth_token_matches_the_cross_language_golden() {
        assert_eq!(
            auth_token(GOLDEN_KEY),
            "G/XSdSTZajIoHaHB04oXsZ7uxL4LnMomCH92alVBmUI"
        );
        assert_eq!(
            auth_token_hash(GOLDEN_KEY),
            "1903382685946b2d5bda1f905789771756ae8c91dade765546b724a38a144a26"
        );
    }

    #[test]
    fn seal_open_roundtrips_and_aad_binds_the_date() {
        let key = [7u8; 32];
        let (nonce, ct) = seal_day(&key, "2026-11-19", "# 2026-11-19\n\n- [ ] 甲\n").expect("seal");
        assert_eq!(nonce.len(), 16); // 12 bytes → 16 base64 chars, no padding
        let plain = open_day(&key, "2026-11-19", &nonce, &ct).expect("open");
        assert_eq!(plain, "# 2026-11-19\n\n- [ ] 甲\n");
        // The AAD is the date: a ciphertext cannot be re-read as another day.
        assert!(open_day(&key, "2026-11-20", &nonce, &ct).is_err());
        // Wrong key: the tag check must fail, not panic.
        assert!(open_day(&[8u8; 32], "2026-11-19", &nonce, &ct).is_err());
    }

    #[test]
    fn decrypts_the_web_page_golden_ciphertext() {
        // Produced by @noble gcm (web/src/crypto.test.ts) with the fixed nonce
        // 070707…07 and AAD "b-todo|day|2026-11-19"; proving the AES-GCM
        // implementations agree byte for byte.
        let mut enc = [0u8; 32];
        Hkdf::<Sha256>::new(Some(KDF_SALT), GOLDEN_KEY.as_bytes())
            .expand(ENC_INFO, &mut enc)
            .expect("expand");
        // The web fixture stores the ciphertext as hex; the wire format is
        // base64 (no padding), so re-encode the same bytes here.
        const CT_HEX: &str = "14f333e4e76188d64f932a069699e5abccf1c0957a5be29160e26f638a034af1d7e87ac53a4bfa6403950dc7b226318d4207df301363076143c59f97251d424e98177cff4026063404f4cb025a7d69da537780732547c6ca5c";
        let mut ct_bytes = Vec::with_capacity(CT_HEX.len() / 2);
        for i in (0..CT_HEX.len()).step_by(2) {
            ct_bytes.push(u8::from_str_radix(&CT_HEX[i..i + 2], 16).expect("hex"));
        }
        let ct = STANDARD_NO_PAD.encode(&ct_bytes);
        // 12 × 0x07 → base64(no-pad): "BwcH" × 4
        let nonce = "BwcHBwcHBwcHBwcH";
        let plain = open_day(&enc, "2026-11-19", nonce, &ct).expect("golden decrypt");
        assert_eq!(
            plain,
            "# 2026-11-19\n\n- [ ] 来自网页的待办\n- [x] 已完成 ✅ 2026-11-19\n"
        );
    }
}
