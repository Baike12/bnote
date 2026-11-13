//! Study-mode agent: LLM provider abstraction, tool execution, MCP, skills,
//! agent definitions and the prompt assembly pipeline.

pub mod cancel;
pub mod concurrency;
pub mod defs;
pub mod home;
pub mod hooks;
pub mod instructions;
pub mod mcp;
pub mod models;
pub mod output_style;
pub mod permissions;
pub mod prompt;
pub mod provider;
pub mod request_log;
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

/// Agent configuration persisted at `<agent home>/agent.json` (the open vault's
/// `.bnote`, else `~/.bnote`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentConfig {
    /// The catalog: several suppliers, each with several models
    /// (see [`models`]). This is the source of truth; the single-model fields
    /// below are the pre-catalog shape, read once by [`AgentConfig::normalize`]
    /// to build the first provider and then kept in sync with the resolved
    /// default selection so an older build still finds a working config.
    #[serde(default)]
    pub providers: Vec<models::ProviderEntry>,
    /// What a new session picks when the caller gave no selection.
    #[serde(default)]
    pub default_selection: Option<models::ModelSelection>,
    /// Which models subagents run on (absent = inherit the parent session).
    #[serde(default)]
    pub subagent_models: models::SubagentModels,
    /// How many subagents may run at the same time (settings → 子代理并发).
    /// Calls beyond the ceiling queue in the session's gate instead of
    /// starting, so one message that dispatches six agents still respects the
    /// user's number.
    #[serde(default = "default_subagent_concurrency")]
    pub subagent_concurrency: usize,
    pub provider: String, // "anthropic" | "openai" — legacy, mirrors the default selection
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    /// Ceiling on one reply's output tokens (what the request's `max_tokens`
    /// carries). The loop raises it to its escalation ceiling once per turn
    /// when a reply is cut off, then asks the model to resume.
    #[serde(default = "default_max_tokens")]
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
    /// Debug switch (settings page「请求记录」): write every model request and
    /// response of a conversation to `<agent home>/logs/requests/<会话>.jsonl`.
    /// Off by default — the record contains the full prompt, tools and notes.
    /// Shared by the three modes; a settings save also pushes it into open
    /// sessions.
    #[serde(default)]
    pub log_requests: bool,
}

fn default_context_window() -> u64 {
    128_000
}

fn default_subagent_concurrency() -> usize {
    concurrency::DEFAULT_LIMIT
}

/// One reply's output ceiling for a config that never carried one (an old
/// file, or a fresh install). The provider clamps to 1024, so a zero here
/// would silently cut every reply short.
fn default_max_tokens() -> u32 {
    8_192
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
        /// Per-request timeout (`timeoutsMs` in the settings file). Without it
        /// every call is cut at the default 60s.
        #[serde(default, rename = "timeoutsMs", alias = "timeouts_ms")]
        timeouts_ms: Option<u64>,
    },
}

impl AgentConfig {
    pub fn load() -> AgentConfig {
        let path = home::config_file();
        let mut cfg = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => AgentConfig {
                max_tokens: default_max_tokens(),
                context_window: default_context_window(),
                ..Default::default()
            },
        };
        cfg.normalize();
        cfg
    }

    /// Copies the pre-home config (`<app_data>/agent.json`) into the agent home
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
    pub(crate) fn normalize(&mut self) {
        if self.provider != "anthropic" && self.provider != "openai" {
            self.provider = "anthropic".into();
        }
        if self.context_window == 0 {
            self.context_window = default_context_window();
        }
        if self.max_tokens == 0 {
            self.max_tokens = default_max_tokens();
        }
        if self.subagent_concurrency == 0 {
            // `Default` gives 0 (the serde default only applies to files that
            // omit the field), and a gate with zero slot would deadlock every
            // subagent. Clamp once here, at the only load boundary.
            self.subagent_concurrency = default_subagent_concurrency();
        }
        // A pre-catalog file describes one model; fold it into the first
        // provider so the catalog is the only thing the app reads afterwards.
        // The generated levels are the mapping the provider used to guess, so
        // an existing user sends exactly the same requests.
        if self.providers.is_empty() && !self.model.trim().is_empty() {
            let model = self.model.trim().to_string();
            let levels =
                models::default_levels(&self.provider, &model, &self.base_url, self.max_tokens);
            self.providers.push(models::ProviderEntry {
                id: "default".into(),
                name: if self.provider == "anthropic" {
                    "Anthropic".into()
                } else {
                    "OpenAI 兼容".into()
                },
                protocol: self.provider.clone(),
                base_url: self.base_url.clone(),
                api_key: self.api_key.clone(),
                models: vec![models::ModelEntry {
                    id: model.clone(),
                    name: model,
                    context_window: self.context_window,
                    max_tokens: self.max_tokens,
                    vision: false,
                    thinking: levels,
                    default_thinking: String::new(),
                }],
            });
        }
        models::normalize(&mut self.providers, &mut self.default_selection);
        // Mirror the resolved default into the legacy fields: an older build
        // (or a script) that only knows one model still finds a working one.
        if let Some(selection) = self.default_selection.clone() {
            if let Ok(resolved) = models::resolve(&self.providers, &selection) {
                self.provider = resolved.protocol;
                self.model = resolved.model;
                self.base_url = resolved.base_url;
                self.api_key = resolved.api_key;
                self.max_tokens = resolved.max_tokens;
                self.context_window = resolved.context_window;
            }
        }
    }

    /// The model a session runs on: the given selection, else the configured
    /// default. The error names what is missing so the UI can say it.
    pub fn resolve(
        &self,
        selection: Option<&models::ModelSelection>,
    ) -> Result<models::ResolvedModel, String> {
        let selection = match selection {
            Some(selection) => selection.clone(),
            None => self
                .default_selection
                .clone()
                .ok_or_else(|| "NO_MODEL: 先在设置的 Agent 部分配置供应商与模型".to_string())?,
        };
        models::resolve(&self.providers, &selection)
    }

    /// The model a session starts or restores on.
    ///
    /// Order: an explicit selection (a restore of a current record, or the
    /// default) → the record's own snapshot (a record written before the
    /// catalog existed; it must keep running on the model it recorded even if
    /// the settings moved on) → the configured default. The API key always
    /// comes from the catalog, never from the snapshot.
    pub fn resolve_session(
        &self,
        selection: Option<&models::ModelSelection>,
        snapshot: Option<&models::SessionModelConfig>,
    ) -> Result<models::ResolvedModel, String> {
        if let Some(selection) = selection {
            if let Ok(resolved) = self.resolve(Some(selection)) {
                return Ok(resolved);
            }
        }
        if let Some(snapshot) = snapshot.filter(|s| !s.model.trim().is_empty()) {
            let model_id = snapshot.model.trim().to_string();
            // The model is still configured: use its entry (the user's
            // patches, key and endpoint may have been edited since).
            if let Some(selection) = models::selection_for_model(
                &self.providers,
                &snapshot.provider_id,
                &model_id,
                &snapshot.thinking,
            ) {
                if let Ok(resolved) = self.resolve(Some(&selection)) {
                    return Ok(resolved);
                }
            }
            // The model left the catalog: continue the session on what the
            // record says, with freshly generated level patches. The record
            // names the provider it ran on — when that provider still exists,
            // keep its endpoint AND its key: taking the endpoint from the
            // record and the key from the legacy mirror (which holds the
            // *default* provider's key) sends one provider's credential to
            // another provider's base URL.
            let provider = self
                .providers
                .iter()
                .find(|p| !snapshot.provider_id.trim().is_empty() && p.id == snapshot.provider_id);
            let protocol = match provider {
                Some(p) => p.protocol.clone(),
                None if snapshot.provider.is_empty() => self.provider.clone(),
                None => snapshot.provider.clone(),
            };
            let base_url = provider
                .map(|p| p.base_url.clone())
                .filter(|url| !url.trim().is_empty())
                .unwrap_or_else(|| snapshot.base_url.clone());
            let max_tokens = if snapshot.max_tokens == 0 {
                self.max_tokens
            } else {
                snapshot.max_tokens
            };
            let context_window = if snapshot.context_window == 0 {
                self.context_window
            } else {
                snapshot.context_window
            };
            let levels = models::default_levels(&protocol, &model_id, &base_url, max_tokens);
            let (level, patch) = levels
                .iter()
                .find(|l| l.id == snapshot.thinking.trim())
                .or_else(|| levels.last())
                .map(|l| (l.id.clone(), l.patch.clone()))
                .unwrap_or_else(|| (String::new(), serde_json::json!({})));
            let off_patch = levels
                .iter()
                .find(|l| l.id == models::LEVEL_OFF)
                .map(|l| l.patch.clone())
                .unwrap_or_else(|| serde_json::json!({}));
            let api_key = provider
                .map(|p| p.api_key.clone())
                .filter(|key| !key.trim().is_empty())
                .unwrap_or_else(|| self.api_key.clone());
            return Ok(models::ResolvedModel {
                provider_id: snapshot.provider_id.clone(),
                provider_name: provider
                    .map(|p| p.name.clone())
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| protocol.clone()),
                model_id: model_id.clone(),
                model_name: model_id.clone(),
                protocol,
                base_url,
                api_key,
                model: model_id,
                max_tokens,
                context_window,
                vision: false,
                thinking_level: level,
                patch,
                off_patch,
            });
        }
        self.resolve(None)
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

    /// Writes the file normalized, so what is on disk always reads back as the
    /// same config (an empty output ceiling or context window would otherwise
    /// land in the file and only be repaired in memory on the next load).
    pub fn save(&self) -> Result<(), String> {
        let path = home::config_file();
        if let Some(parent) = path.parent() {
            home::ensure_dir(parent)?;
        }
        let mut normalized = self.clone();
        normalized.normalize();
        let json = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
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

    /// A pre-catalog file describes one model; loading it must fold it into
    /// the catalog, seed the thinking levels the provider used to guess, point
    /// the default selection at it, and keep the legacy fields readable.
    #[test]
    fn a_single_model_config_migrates_into_the_catalog() {
        let mut cfg: AgentConfig = serde_json::from_str(
            r#"{"provider":"openai","model":"deepseek-chat","base_url":"https://api.deepseek.com","api_key":"sk","max_tokens":4096,"context_window":64000}"#,
        )
        .unwrap();
        cfg.normalize();
        assert_eq!(cfg.providers.len(), 1);
        let provider = &cfg.providers[0];
        assert_eq!(provider.id, "default");
        assert_eq!(provider.protocol, "openai");
        assert_eq!(provider.api_key, "sk");
        let model = &provider.models[0];
        assert_eq!(model.id, "deepseek-chat");
        assert_eq!(model.context_window, 64_000);
        assert_eq!(model.max_tokens, 4_096);
        // The DeepSeek mapping the provider used to guess.
        let high = model
            .thinking
            .iter()
            .find(|l| l.id == "high")
            .and_then(|l| l.patch.pointer("/thinking/type"))
            .and_then(|v| v.as_str());
        assert_eq!(high, Some("enabled"));
        let default = cfg.default_selection.as_ref().expect("default selection");
        assert_eq!(default.provider_id, "default");
        assert_eq!(default.model_id, "deepseek-chat");
        // The legacy fields mirror the resolved default (an older build still
        // finds a working model).
        assert_eq!(cfg.model, "deepseek-chat");
        assert_eq!(cfg.api_key, "sk");

        // Saving writes the migrated shape back: loading it again is stable.
        let again: AgentConfig =
            serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(again.providers, cfg.providers);
        assert_eq!(again.default_selection, cfg.default_selection);
    }

    #[test]
    fn a_config_without_any_model_reports_what_is_missing() {
        let cfg = AgentConfig::default();
        let err = cfg.resolve(None).unwrap_err();
        assert!(err.starts_with("NO_MODEL"), "{err}");
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

    #[test]
    fn a_config_without_max_tokens_keeps_a_usable_output_ceiling() {
        // An old file has no max_tokens key at all: deserializing must not fail
        // and normalize must not leave the provider's 1024 clamp as the answer.
        let mut cfg: AgentConfig = serde_json::from_str(
            r#"{"provider":"anthropic","model":"m","base_url":"","api_key":""}"#,
        )
        .unwrap();
        assert_eq!(cfg.max_tokens, default_max_tokens());
        cfg.max_tokens = 0;
        cfg.normalize();
        assert_eq!(cfg.max_tokens, default_max_tokens());
    }
}
