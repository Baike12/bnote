//! Project trust for MCP servers.
//!
//! A code project's `.mcp.json` or `.bnote/settings.json` can name any command
//! line, and both the settings page's check and a coding session spawn it. The
//! approval record lives in the vault (`<agent home>/trusted-mcp.json`), keyed
//! by the project path and the server name, and stores a digest of the
//! definition: editing the server asks again, and another checkout at the same
//! path does not inherit a stale approval. Servers from the user scope are the
//! user's own file and need no approval.

use super::home;
use super::settings::{McpScope, McpSource};
use super::McpServerConfig;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "trusted-mcp.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct TrustFile {
    #[serde(default)]
    projects: BTreeMap<String, BTreeMap<String, String>>,
}

fn trust_file(home: &Path) -> PathBuf {
    home.join(FILE_NAME)
}

/// The record on disk; a missing or broken file means nothing is approved.
fn read(home: &Path) -> TrustFile {
    std::fs::read_to_string(trust_file(home))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// The digest of one definition. Any change to the command, args, env, url or
/// headers invalidates an earlier approval.
pub fn digest(cfg: &McpServerConfig) -> String {
    let canonical = serde_json::to_string(cfg).unwrap_or_default();
    format!("{:016x}", home::fnv1a(canonical.as_bytes()))
}

/// The approvals of one project, loaded once per command.
#[derive(Debug)]
pub struct TrustStore {
    home: PathBuf,
    project: Option<String>,
    approved: BTreeMap<String, String>,
}

impl TrustStore {
    pub fn load(project: Option<&Path>) -> TrustStore {
        TrustStore::load_from(&home::home_dir(), project)
    }

    pub fn load_from(home: &Path, project: Option<&Path>) -> TrustStore {
        let project = project.map(|path| path.to_string_lossy().to_string());
        let approved = project
            .as_ref()
            .and_then(|key| read(home).projects.remove(key))
            .unwrap_or_default();
        TrustStore {
            home: home.to_path_buf(),
            project,
            approved,
        }
    }

    /// The file the approvals live in (the settings page shows it).
    pub fn path(&self) -> PathBuf {
        trust_file(&self.home)
    }

    /// A user-scope server is the user's own configuration; a project-scope
    /// server is trusted only while its exact definition was approved.
    pub fn is_trusted(&self, name: &str, cfg: &McpServerConfig, scope: McpScope) -> bool {
        if scope == McpScope::User || self.project.is_none() {
            return true;
        }
        self.approved.get(name) == Some(&digest(cfg))
    }

    /// Records the current definition of `name` as approved. Re-reads the file
    /// first, so an approval made in another window is not overwritten.
    pub fn approve(&self, name: &str, cfg: &McpServerConfig) -> Result<(), String> {
        let Some(project) = self.project.as_deref() else {
            return Err("NO_PROJECT: 没有打开代码项目".to_string());
        };
        let mut file = read(&self.home);
        file.projects
            .entry(project.to_string())
            .or_default()
            .insert(name.to_string(), digest(cfg));
        let path = trust_file(&self.home);
        if let Some(parent) = path.parent() {
            home::ensure_dir(parent)?;
        }
        let json =
            serde_json::to_string_pretty(&file).map_err(|e| format!("WRITE_FAILED: {}", e))?;
        std::fs::write(&path, format!("{json}\n"))
            .map_err(|e| format!("WRITE_FAILED: {} ({})", path.display(), e))
    }

    /// Drops every server whose project definition is not approved, so a
    /// session never starts a server the user has not seen.
    pub fn retain_trusted(
        &self,
        servers: &mut BTreeMap<String, McpServerConfig>,
        sources: &BTreeMap<String, McpSource>,
    ) {
        servers.retain(|name, cfg| {
            let scope = sources
                .get(name)
                .map(|source| source.scope)
                .unwrap_or(McpScope::User);
            self.is_trusted(name, cfg, scope)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bnote-trust-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn stdio(command: &str) -> McpServerConfig {
        McpServerConfig::Stdio {
            command: command.to_string(),
            args: vec!["--flag".to_string()],
            env: Default::default(),
        }
    }

    #[test]
    fn a_project_server_is_untrusted_until_its_exact_definition_is_approved() {
        let home = temp("approve");
        let project = temp("approve-project");
        let store = TrustStore::load_from(&home, Some(&project));
        let cfg = stdio("npx");
        assert!(!store.is_trusted("srv", &cfg, McpScope::Project));
        assert!(
            store.is_trusted("srv", &cfg, McpScope::User),
            "user scope needs no approval"
        );

        store.approve("srv", &cfg).expect("approve");
        let reloaded = TrustStore::load_from(&home, Some(&project));
        assert!(reloaded.is_trusted("srv", &cfg, McpScope::Project));

        // Any change to the definition invalidates the approval.
        assert!(!reloaded.is_trusted("srv", &stdio("node"), McpScope::Project));
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn approvals_are_per_project_and_survive_a_deleted_entry() {
        let home = temp("per-project");
        let one = temp("one");
        let two = temp("two");
        TrustStore::load_from(&home, Some(&one))
            .approve("srv", &stdio("a"))
            .expect("approve");
        assert!(!TrustStore::load_from(&home, Some(&two)).is_trusted(
            "srv",
            &stdio("a"),
            McpScope::Project
        ));
        assert!(TrustStore::load_from(&home, Some(&one)).is_trusted(
            "srv",
            &stdio("a"),
            McpScope::Project
        ));
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&one);
        let _ = std::fs::remove_dir_all(&two);
    }

    #[test]
    fn retain_trusted_keeps_user_scope_and_unapproved_project_servers_go() {
        let home = temp("retain");
        let project = temp("retain-project");
        let store = TrustStore::load_from(&home, Some(&project));
        let mut servers = BTreeMap::new();
        servers.insert("mine".to_string(), stdio("mine"));
        servers.insert("repo".to_string(), stdio("repo"));
        let mut sources = BTreeMap::new();
        sources.insert(
            "mine".to_string(),
            McpSource {
                scope: McpScope::User,
                path: home.join("settings.json"),
            },
        );
        sources.insert(
            "repo".to_string(),
            McpSource {
                scope: McpScope::Project,
                path: project.join(".mcp.json"),
            },
        );
        store.retain_trusted(&mut servers, &sources);
        assert!(servers.contains_key("mine"));
        assert!(!servers.contains_key("repo"));
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&project);
    }
}
