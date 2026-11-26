//! Remote-access configuration, the service base URL, and the Mac's keys.
//!
//! `settings.json` is a plain file with mode 0600. The remote key and the relay
//! host token live in the macOS Keychain. Everything network-facing derives
//! from the base URL and the remote key: no certificate, room or relay URL is
//! stored separately.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::crypto;

pub const KEYCHAIN_SERVICE: &str = "com.baike.bnote.remote";
pub const DEFAULT_BASE_URL: &str = "https://realbaike.tech/bnote";
pub const SETTINGS_VERSION: u32 = 2;

const ACCOUNT_KEY: &str = "remote-key";
const ACCOUNT_TOKEN: &str = "relay-host-token";
const LEGACY_ACCOUNT_ED: &str = "mac-ed25519-seed";
const LEGACY_ACCOUNT_X: &str = "mac-x25519-secret";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettings {
    /// 2 is the merged single-service layout. A file without this field is a
    /// v1 (two-service) install and is migrated once.
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub enabled: bool,
    /// `https://host/prefix`; `/todo` and `/relay/ws` are appended by use.
    #[serde(default = "default_base_url")]
    pub base_url: String,
    #[serde(default)]
    pub device_id: String,
    /// Canonical project roots the phone may list and drive. Empty on first
    /// enable; filled from the desktop's recent projects.
    #[serde(default)]
    pub allowed_projects: Vec<String>,
}

fn default_base_url() -> String {
    DEFAULT_BASE_URL.to_string()
}

impl Default for RemoteSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            enabled: false,
            base_url: DEFAULT_BASE_URL.into(),
            device_id: String::new(),
            allowed_projects: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Identity {
    pub device_id: String,
    pub room: String,
    pub psk: [u8; 32],
    pub host_token: [u8; 32],
    /// Present only to reveal/copy/rotate; never sent to the relay.
    pub remote_key: [u8; 32],
}

pub fn remote_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("remote")
}

/// Creates `<data_dir>/remote` with owner-only access. The directory holds the
/// audit log (user prompts) and checkpoint copies of project files, so no other
/// local account may traverse it.
pub fn ensure_remote_dir(data_dir: &Path) -> Result<(), String> {
    let dir = remote_dir(data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("WRITE_FAILED: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

pub fn settings_file(data_dir: &Path) -> PathBuf {
    remote_dir(data_dir).join("settings.json")
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
    ensure_remote_dir(data_dir)?;
    let dir = remote_dir(data_dir);
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

/// One-time migration from the two-service layout (v1: relayUrl + room +
/// Ed25519/X25519 identities + devices.json). The remote key did not exist
/// then, so the user must generate one and pair the phone again. Runs before
/// the window loads; idempotent.
pub fn migrate(data_dir: &Path) -> Result<bool, String> {
    let on_disk = std::fs::read(settings_file(data_dir)).ok();
    // `existed` is false when the bytes are unreadable: the corrupt file keeps
    // its own copy under a sidecar name and the layout is rebuilt, so the
    // user's base URL and allowlist are never silently replaced.
    let (current, existed) = match &on_disk {
        None => (RemoteSettings::default(), false),
        Some(raw) => match serde_json::from_slice::<RemoteSettings>(raw) {
            Ok(settings) => (settings, true),
            Err(e) => {
                let path = settings_file(data_dir);
                let corrupt = path.with_extension("json.corrupt");
                let _ = std::fs::rename(&path, &corrupt);
                eprintln!(
                    "remote settings unreadable ({e}); moved {} to {}",
                    path.display(),
                    corrupt.display()
                );
                (RemoteSettings::default(), false)
            }
        },
    };
    if existed && current.version >= SETTINGS_VERSION {
        return Ok(false);
    }
    let migrated = RemoteSettings {
        version: SETTINGS_VERSION,
        enabled: false,
        base_url: DEFAULT_BASE_URL.into(),
        device_id: crypto::hex_encode(&crypto::random::<16>()),
        allowed_projects: current.allowed_projects,
    };
    save_settings(data_dir, &migrated)?;

    let _ = std::fs::remove_file(remote_dir(data_dir).join("devices.json"));
    for account in [LEGACY_ACCOUNT_ED, LEGACY_ACCOUNT_X, ACCOUNT_TOKEN] {
        keychain_delete(account);
    }
    super::audit::append(
        data_dir,
        "system",
        "key",
        "remote settings migrated to the single-service layout; remote disabled",
    );
    Ok(true)
}

/// Loads the Mac's identity. The room and PSK derive from the remote key; the
/// host token is generated once and never leaves the Keychain.
pub fn ensure_identity(data_dir: &Path) -> Result<Identity, String> {
    let mut settings = load_settings(data_dir);
    let mut changed = false;
    if settings.version != SETTINGS_VERSION {
        settings.version = SETTINGS_VERSION;
        changed = true;
    }
    if settings.device_id.is_empty() {
        settings.device_id = crypto::hex_encode(&crypto::random::<16>());
        changed = true;
    }
    let remote_key = match keychain_get(ACCOUNT_KEY)? {
        Some(bytes) if bytes.len() == 32 => {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            key
        }
        _ => return Err("NO_KEY: 先在设置里生成远程密钥".into()),
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
            token
        }
    };
    if changed {
        save_settings(data_dir, &settings)?;
    }
    Ok(Identity {
        device_id: settings.device_id,
        room: crypto::hex_encode(&crypto::derive_room(&remote_key)),
        psk: crypto::derive_psk(&remote_key),
        host_token,
        remote_key,
    })
}

pub fn has_key() -> bool {
    matches!(keychain_get(ACCOUNT_KEY), Ok(Some(bytes)) if bytes.len() == 32)
}

/// Creates a key when none exists. Returns the hex key so the caller can show
/// it exactly once.
pub fn generate_key() -> Result<[u8; 32], String> {
    if has_key() {
        return Err("KEY_EXISTS: 远程密钥已存在，如需更换请轮换".into());
    }
    let key = crypto::random::<32>();
    keychain_set(ACCOUNT_KEY, &key)?;
    keychain_set(ACCOUNT_TOKEN, &crypto::random::<32>())?;
    Ok(key)
}

/// New key and host token. The room changes with the key, so every phone
/// loses access immediately and must be given the new key.
pub fn rotate_key() -> Result<[u8; 32], String> {
    let key = crypto::random::<32>();
    keychain_set(ACCOUNT_KEY, &key)?;
    keychain_set(ACCOUNT_TOKEN, &crypto::random::<32>())?;
    Ok(key)
}

pub fn reveal_key() -> Result<[u8; 32], String> {
    match keychain_get(ACCOUNT_KEY)? {
        Some(bytes) if bytes.len() == 32 => {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            Ok(key)
        }
        _ => Err("NO_KEY: 还没有远程密钥".into()),
    }
}

pub fn key_suffix() -> Option<String> {
    let key = reveal_key().ok()?;
    let hex = crypto::hex_encode(&key);
    Some(hex[hex.len() - 4..].to_string())
}

/// Normalizes a service base URL. The same rules run on iOS; see
/// `protocol/v2.md` §8.1.
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("BAD_PARAMS: 服务地址不能为空".into());
    }
    if trimmed.contains('?') || trimmed.contains('#') {
        return Err("BAD_PARAMS: 服务地址不能带查询参数或片段".into());
    }
    let (scheme, rest) = if let Some(rest) = trimmed.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        ("http", rest)
    } else {
        return Err("BAD_PARAMS: 服务地址必须以 https:// 开头".into());
    };
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, format!("/{path}")),
        None => (rest, String::new()),
    };
    if authority.is_empty() || authority.contains('@') || authority.contains(char::is_whitespace) {
        return Err("BAD_PARAMS: 服务地址的主机名不合法".into());
    }
    let host = authority.split(':').next().unwrap_or("");
    if scheme == "http" && host != "localhost" && host != "127.0.0.1" {
        return Err("BAD_PARAMS: 只有 localhost 允许使用 http://".into());
    }
    let path = path.trim_end_matches('/').to_string();
    if path.ends_with("/todo") || path.ends_with("/relay") || path.ends_with("/relay/ws") {
        return Err("BAD_PARAMS: 服务地址只填到前缀，不要带 /todo 或 /relay".into());
    }
    Ok(format!("{scheme}://{authority}{path}"))
}

pub fn todo_url(base_url: &str) -> String {
    format!("{base_url}/todo")
}

/// The websocket endpoint mirrors the base URL's scheme: `https` uses `wss`,
/// and the localhost-only `http` development server uses plain `ws`. Building
/// `wss` unconditionally made an `http://localhost` relay impossible to reach
/// even though the todo client talks to the same service over plain http.
pub fn relay_url(base_url: &str) -> Result<String, String> {
    let (scheme, rest) = if let Some(rest) = base_url.strip_prefix("https://") {
        ("wss", rest)
    } else if let Some(rest) = base_url.strip_prefix("http://") {
        ("ws", rest)
    } else {
        return Err("BAD_PARAMS: 服务地址缺少 scheme".into());
    };
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, format!("/{path}")),
        None => (rest, String::new()),
    };
    Ok(format!("{scheme}://{authority}{path}/relay/ws"))
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

fn keychain_delete(account: &str) {
    let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, account);
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
        assert_eq!(defaults.base_url, DEFAULT_BASE_URL);
        assert_eq!(defaults.version, SETTINGS_VERSION);
        assert!(!defaults.enabled);

        let saved = RemoteSettings {
            enabled: true,
            device_id: "11".repeat(16),
            ..defaults
        };
        save_settings(&dir, &saved).expect("save");
        let back = load_settings(&dir);
        assert!(back.enabled);
        assert_eq!(back.device_id, "11".repeat(16));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base_url_normalization() {
        assert_eq!(
            normalize_base_url(" https://realbaike.tech/bnote/ ").unwrap(),
            "https://realbaike.tech/bnote"
        );
        assert_eq!(
            normalize_base_url("https://realbaike.tech").unwrap(),
            "https://realbaike.tech"
        );
        assert_eq!(
            normalize_base_url("http://localhost:8092/bnote").unwrap(),
            "http://localhost:8092/bnote"
        );
        for bad in [
            "",
            "realbaike.tech/bnote",
            "ftp://x",
            "http://realbaike.tech/bnote",
            "https://user@realbaike.tech/bnote",
            "https://realbaike.tech/bnote?x=1",
            "https://realbaike.tech/bnote#x",
            "https://realbaike.tech/bnote/todo",
            "https://realbaike.tech/bnote/relay",
            "https://realbaike.tech/bnote/relay/ws",
        ] {
            assert!(normalize_base_url(bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn derived_endpoints() {
        let base = DEFAULT_BASE_URL;
        assert_eq!(
            todo_url(base),
            "https://realbaike.tech/bnote/todo".to_string()
        );
        assert_eq!(
            relay_url(base).unwrap(),
            "wss://realbaike.tech/bnote/relay/ws"
        );
        assert_eq!(
            relay_url("http://localhost:8092").unwrap(),
            "ws://localhost:8092/relay/ws"
        );
    }

    #[test]
    fn migration_resets_legacy_settings_once() {
        let dir = temp_dir("migrate");
        std::fs::create_dir_all(remote_dir(&dir)).expect("remote dir");
        std::fs::write(
            settings_file(&dir),
            r#"{"enabled":true,"relayUrl":"wss://101.96.243.197/bnote-relay/ws","room":"00","deviceId":"11","allowedProjects":["/tmp/x"]}"#,
        )
        .unwrap();
        assert!(migrate(&dir).expect("migrate"));
        let after = load_settings(&dir);
        assert_eq!(after.version, SETTINGS_VERSION);
        assert!(!after.enabled);
        assert_eq!(after.base_url, DEFAULT_BASE_URL);
        assert_eq!(after.allowed_projects, vec!["/tmp/x".to_string()]);
        assert_ne!(after.device_id, "11");
        // Idempotent.
        assert!(!migrate(&dir).expect("second migrate"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_settings_are_backed_up_not_silently_reset() {
        let dir = temp_dir("corrupt");
        std::fs::create_dir_all(remote_dir(&dir)).expect("remote dir");
        std::fs::write(settings_file(&dir), "{ not json").unwrap();
        assert!(migrate(&dir).expect("migrate over a backup"));
        // The unreadable bytes are preserved under the sidecar name.
        assert!(settings_file(&dir).with_extension("json.corrupt").is_file());
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
}
