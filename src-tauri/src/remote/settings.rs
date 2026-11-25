//! Remote-access configuration and the Mac's long-term identity.
//!
//! `settings.json` and `devices.json` are plain files with mode 0600; the
//! private keys and the relay host token live in the macOS Keychain. The
//! certificate used for TLS pinning is compiled in, so a fresh install has the
//! only root it will ever accept.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::crypto;

pub const KEYCHAIN_SERVICE: &str = "com.baike.bnote.remote";
pub const DEFAULT_RELAY: &str = "wss://101.96.243.197/bnote-relay/ws";

/// Private CA that signs the relay's IP certificate (CN=101.96.243.197,
/// CA:FALSE, valid to 2036-11-21). The Mac trusts only this CA; the iPhone
/// pins the leaf SPKI, which stays stable because the leaf reuses its key.
pub const ROOT_CERT_PEM: &[u8] = include_bytes!("../../resources/bnote-ca.crt");

const ACCOUNT_ED: &str = "mac-ed25519-seed";
const ACCOUNT_X: &str = "mac-x25519-secret";
const ACCOUNT_TOKEN: &str = "relay-host-token";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RemoteSettings {
    pub enabled: bool,
    pub relay_url: String,
    pub room: String,
    pub device_id: String,
    /// Canonical project roots the phone may list and drive. Empty on first
    /// enable; filled from the desktop's recent projects.
    pub allowed_projects: Vec<String>,
}

impl Default for RemoteSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            relay_url: DEFAULT_RELAY.into(),
            room: String::new(),
            device_id: String::new(),
            allowed_projects: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Identity {
    pub device_id: String,
    pub room: String,
    pub host_token: [u8; 32],
    pub mac_ed_seed: [u8; 32],
    pub mac_ed_public: [u8; 32],
    pub mac_x_secret: [u8; 32],
    pub mac_x_public: [u8; 32],
}

pub fn remote_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("remote")
}

pub fn settings_file(data_dir: &Path) -> PathBuf {
    remote_dir(data_dir).join("settings.json")
}

pub fn devices_file(data_dir: &Path) -> PathBuf {
    remote_dir(data_dir).join("devices.json")
}

pub fn audit_file(data_dir: &Path) -> PathBuf {
    remote_dir(data_dir).join("audit.jsonl")
}

pub fn checkpoints_dir(data_dir: &Path) -> PathBuf {
    remote_dir(data_dir).join("checkpoints")
}

pub fn load_settings(data_dir: &Path) -> RemoteSettings {
    std::fs::read(settings_file(data_dir))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

pub fn save_settings(data_dir: &Path, settings: &RemoteSettings) -> Result<(), String> {
    let dir = remote_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("WRITE_FAILED: {e}"))?;
    let path = settings_file(data_dir);
    let tmp = dir.join("settings.json.tmp");
    let raw = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, raw).map_err(|e| format!("WRITE_FAILED: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("WRITE_FAILED: {e}"))?;
    Ok(())
}

/// Loads or creates the Mac's identity. The room and host token are created
/// once; rotating the room is an explicit operation (`rotate_room`).
pub fn ensure_identity(data_dir: &Path) -> Result<Identity, String> {
    let mut settings = load_settings(data_dir);
    let mut changed = false;

    if settings.room.is_empty() {
        settings.room = crypto::hex_encode(&crypto::random::<16>());
        changed = true;
    }
    if settings.device_id.is_empty() {
        settings.device_id = crypto::hex_encode(&crypto::random::<16>());
        changed = true;
    }

    let mac_ed_seed = match keychain_get(ACCOUNT_ED)? {
        Some(bytes) if bytes.len() == 32 => {
            let mut seed = [0u8; 32];
            seed.copy_from_slice(&bytes);
            seed
        }
        _ => {
            let (seed, _) = crypto::new_ed25519();
            keychain_set(ACCOUNT_ED, &seed)?;
            changed = true;
            seed
        }
    };
    let mac_x_secret = match keychain_get(ACCOUNT_X)? {
        Some(bytes) if bytes.len() == 32 => {
            let mut secret = [0u8; 32];
            secret.copy_from_slice(&bytes);
            secret
        }
        _ => {
            let (secret, _) = crypto::new_x25519();
            keychain_set(ACCOUNT_X, &secret)?;
            changed = true;
            secret
        }
    };
    let host_token = match keychain_get(ACCOUNT_TOKEN)? {
        Some(bytes) if bytes.len() == 32 => {
            let mut token = [0u8; 32];
            token.copy_from_slice(&bytes);
            token
        }
        _ => {
            let token = crypto::random::<32>();
            keychain_set(ACCOUNT_TOKEN, &token)?;
            changed = true;
            token
        }
    };

    if changed {
        save_settings(data_dir, &settings)?;
    }

    let mac_ed_public = {
        use ed25519_dalek::SigningKey;
        SigningKey::from_bytes(&mac_ed_seed)
            .verifying_key()
            .to_bytes()
    };
    Ok(Identity {
        device_id: settings.device_id,
        room: settings.room,
        host_token,
        mac_ed_seed,
        mac_ed_public,
        mac_x_secret,
        mac_x_public: crypto::x25519_public(&mac_x_secret),
    })
}

/// New room id + host token. Pairing records keep working; a paired phone
/// reconnects with its stored room, so the caller must re-pair every device.
pub fn rotate_room(data_dir: &Path) -> Result<(String, [u8; 32]), String> {
    let mut settings = load_settings(data_dir);
    settings.room = crypto::hex_encode(&crypto::random::<16>());
    save_settings(data_dir, &settings)?;
    let token = crypto::random::<32>();
    keychain_set(ACCOUNT_TOKEN, &token)?;
    Ok((settings.room, token))
}

pub fn save_allowed_projects(
    data_dir: &Path,
    projects: Vec<String>,
) -> Result<RemoteSettings, String> {
    let mut settings = load_settings(data_dir);
    let mut canonical = Vec::new();
    for raw in projects {
        let path = PathBuf::from(raw.trim());
        if path.as_os_str().is_empty() {
            continue;
        }
        let Ok(path) = path.canonicalize() else {
            continue;
        };
        let value = path.to_string_lossy().to_string();
        if !canonical.contains(&value) {
            canonical.push(value);
        }
    }
    settings.allowed_projects = canonical;
    save_settings(data_dir, &settings)?;
    Ok(settings)
}

/// Resolves a project id to a canonical path, but only when it is on the
/// allowlist. The phone never sends a path.
pub fn allowed_project(data_dir: &Path, project_id: &str) -> Option<PathBuf> {
    let settings = load_settings(data_dir);
    settings
        .allowed_projects
        .iter()
        .map(PathBuf::from)
        .find(|path| project_id_for(path) == project_id)
        .and_then(|path| path.canonicalize().ok())
}

/// The opaque id the phone passes: the first 16 hex characters of SHA-256 of
/// the canonical path.
pub fn project_id_for(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    crypto::hex_encode(&digest[..8])
}

fn keychain_set(account: &str, value: &[u8]) -> Result<(), String> {
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, account, value)
        .map_err(|e| format!("KEYCHAIN_FAILED: {e}"))
}

fn keychain_get(account: &str) -> Result<Option<Vec<u8>>, String> {
    match security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, account) {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.code() == -25300 => Ok(None), // errSecItemNotFound
        Err(e) => Err(format!("KEYCHAIN_FAILED: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bnote-remote-settings-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn settings_round_trip_and_defaults() {
        let dir = temp_dir("roundtrip");
        let defaults = load_settings(&dir);
        assert_eq!(defaults.relay_url, DEFAULT_RELAY);
        assert!(!defaults.enabled);

        let saved = RemoteSettings {
            enabled: true,
            room: "00".repeat(16),
            device_id: "11".repeat(16),
            ..defaults
        };
        save_settings(&dir, &saved).expect("save");
        let back = load_settings(&dir);
        assert!(back.enabled);
        assert_eq!(back.room, "00".repeat(16));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_id_is_stable_and_allowlist_is_canonical() {
        let dir = temp_dir("projects");
        let project = dir.join("proj");
        std::fs::create_dir_all(&project).expect("proj");
        // macOS resolves /var to /private/var; the allowlist stores canonical
        // paths, so the id has to be computed from one too.
        let project = project.canonicalize().expect("canonical");
        let id = project_id_for(&project);
        assert_eq!(id.len(), 16);

        save_allowed_projects(&dir, vec![project.to_string_lossy().to_string()]).expect("save");
        assert!(allowed_project(&dir, &id).is_some());
        assert!(allowed_project(&dir, "0000000000000000").is_none());

        // A path, not an id, is never accepted.
        assert!(allowed_project(&dir, &project.to_string_lossy()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn certificate_is_present() {
        assert!(ROOT_CERT_PEM.starts_with(b"-----BEGIN CERTIFICATE-----"));
    }
}
