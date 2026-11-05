//! Study-mode agent: LLM provider abstraction, tool execution, MCP, skills,
//! agent definitions and the prompt assembly pipeline.

pub mod cancel;
pub mod defs;
pub mod home;
pub mod hooks;
pub mod instructions;
pub mod mcp;
pub mod output_style;
pub mod permissions;
pub mod prompt;
pub mod provider;
pub mod results;
pub mod schema;
pub mod search;
pub mod session;
pub mod settings;
pub mod shell;
pub mod skills;
pub mod tasks;
pub mod todo;
pub mod tools;
pub mod types;

pub use provider::Provider;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Agent configuration persisted at `<agent home>/agent.json` (`~/.bnote`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentConfig {
    pub provider: String, // "anthropic" | "openai"
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub max_tokens: u32,
    /// Model context window (in tokens), used to display the occupancy ratio.
    /// Fill in the window of the user's actual model.
    #[serde(default = "default_context_window")]
    pub context_window: u64,
    /// MCP servers: name → {command,args,env} or {url,headers}. Deprecated:
    /// MCP is per mode now and lives in `<mode root>/settings.json`'s
    /// `mcpServers`. The field survives only so the one-time migration can read
    /// what the user configured before the mode roots existed.
    #[serde(default)]
    pub mcp_servers: std::collections::BTreeMap<String, McpServerConfig>,
    /// Extra skill directories. Deprecated for the same reason (`skillDirs` in
    /// the mode settings file).
    #[serde(default)]
    pub skill_dirs: Vec<String>,
    /// Per-mode configuration roots (mode id → absolute path). Absent = the
    /// vault default `<vault>/.bnote/agents/<mode>`.
    #[serde(default)]
    pub agent_roots: std::collections::BTreeMap<String, String>,
}

fn default_context_window() -> u64 {
    128_000
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpServerConfig {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: std::collections::BTreeMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: std::collections::BTreeMap<String, String>,
    },
}

impl AgentConfig {
    pub fn load() -> AgentConfig {
        let path = home::config_file();
        let mut cfg = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => AgentConfig {
                max_tokens: 8192,
                context_window: default_context_window(),
                ..Default::default()
            },
        };
        cfg.normalize();
        cfg
    }

    /// Copies the pre-home config (`<app_data>/agent.json`) into `~/.bnote`
    /// once. The legacy file is left untouched, so downgrading loses nothing.
    pub fn migrate_from(data_dir: &Path) {
        let target = home::config_file();
        if !target.exists() {
            let legacy = data_dir.join("agent.json");
            if legacy.is_file() {
                if let Some(parent) = target.parent() {
                    if home::ensure_dir(parent).is_ok() {
                        if let Err(e) = std::fs::copy(&legacy, &target) {
                            eprintln!("[bnote] agent config migration failed: {e}");
                        }
                    }
                }
            }
        }
        // Skills used to live under the app data directory; move a copy once so
        // existing users do not lose them.
        let skills_target = home::home_dir().join("skills");
        let skills_legacy = data_dir.join("skills");
        if !skills_target.exists() && skills_legacy.is_dir() {
            if let Err(e) = copy_dir(&skills_legacy, &skills_target) {
                eprintln!("[bnote] skills migration failed: {e}");
            }
        }
    }

    /// Narrows the protocol field to its value contract: only "anthropic" | "openai".
    ///
    /// Legacy configs and hand-edited data may hold an empty provider; `Provider`
    /// compares the literal `== "anthropic"`, so an empty string silently takes the
    /// OpenAI branch and the request path disagrees with the protocol the user
    /// picked (surfacing as a gateway 404, hard to tell apart from auth and model
    /// errors). Normalizing at the load boundary to the anthropic value the UI
    /// shows by default means no reader has to defend against this case again.
    fn normalize(&mut self) {
        if self.provider != "anthropic" && self.provider != "openai" {
            self.provider = "anthropic".into();
        }
        if self.context_window == 0 {
            self.context_window = default_context_window();
        }
    }

    /// The configured root of `mode`, when the user overrode the default.
    /// An empty string is treated as "not set" (the settings input clears the
    /// override by saving an empty value).
    pub fn agent_root(&self, mode: home::AgentMode) -> Option<std::path::PathBuf> {
        let raw = self.agent_roots.get(mode.id())?.trim();
        if raw.is_empty() {
            None
        } else {
            Some(std::path::PathBuf::from(raw))
        }
    }

    /// Sets or clears the root of `mode`; returns whether the value changed.
    pub fn set_agent_root(&mut self, mode: home::AgentMode, path: Option<&str>) -> bool {
        let next = path.map(str::trim).filter(|p| !p.is_empty());
        let current = self.agent_roots.get(mode.id()).map(String::as_str);
        if current == next {
            return false;
        }
        match next {
            Some(path) => {
                self.agent_roots
                    .insert(mode.id().to_string(), path.to_string());
            }
            None => {
                self.agent_roots.remove(mode.id());
            }
        }
        true
    }

    pub fn save(&self) -> Result<(), String> {
        let path = home::config_file();
        if let Some(parent) = path.parent() {
            home::ensure_dir(parent)?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| format!("WRITE_FAILED: {}", e))
    }
}

/// Recursive copy used only by the one-time skills migration.
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_provider_normalizes_to_anthropic_and_valid_values_pass_through() {
        let mut cfg = AgentConfig::default();
        assert_eq!(cfg.provider, "");
        cfg.normalize();
        assert_eq!(cfg.provider, "anthropic");

        cfg.provider = "openai".into();
        cfg.normalize();
        assert_eq!(cfg.provider, "openai");

        cfg.provider = "anthropic".into();
        cfg.normalize();
        assert_eq!(cfg.provider, "anthropic");
    }

    #[test]
    fn old_config_without_context_window_falls_back_to_the_default() {
        let cfg: AgentConfig = serde_json::from_str(
            r#"{"provider":"openai","model":"m","base_url":"","api_key":"","max_tokens":8192}"#,
        )
        .unwrap();
        assert_eq!(cfg.context_window, default_context_window());
    }

    #[test]
    fn an_agent_root_can_be_set_and_cleared() {
        let mut cfg = AgentConfig::default();
        assert!(cfg.agent_root(home::AgentMode::Coding).is_none());
        assert!(cfg.set_agent_root(home::AgentMode::Coding, Some("/custom/coding")));
        assert_eq!(
            cfg.agent_root(home::AgentMode::Coding),
            Some(std::path::PathBuf::from("/custom/coding"))
        );
        assert!(cfg.agent_root(home::AgentMode::Study).is_none());
        assert!(!cfg.set_agent_root(home::AgentMode::Coding, Some("  /custom/coding  ")));
        assert!(cfg.set_agent_root(home::AgentMode::Coding, Some("   ")));
        assert!(cfg.agent_root(home::AgentMode::Coding).is_none());
        assert!(cfg.agent_roots.is_empty());
    }

    #[test]
    fn zero_context_window_normalizes_to_the_default() {
        let mut cfg = AgentConfig::default();
        cfg.normalize();
        assert_eq!(cfg.context_window, default_context_window());
    }
}
