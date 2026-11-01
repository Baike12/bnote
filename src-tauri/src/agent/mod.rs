//! Study-mode agent: LLM provider abstraction, tool execution, MCP, skills.

pub mod mcp;
pub mod provider;
pub mod session;
pub mod skills;
pub mod tools;
pub mod types;

pub use provider::Provider;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Agent configuration persisted at `<app_data>/agent.json`.
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
    /// MCP servers: name → {command,args,env} or {url,headers}.
    #[serde(default)]
    pub mcp_servers: std::collections::BTreeMap<String, McpServerConfig>,
    /// Extra skill directories to scan (in addition to built-ins).
    #[serde(default)]
    pub skill_dirs: Vec<String>,
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
    pub fn load(data_dir: &PathBuf) -> AgentConfig {
        let path = data_dir.join("agent.json");
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

    pub fn save(&self, data_dir: &PathBuf) -> Result<(), String> {
        let path = data_dir.join("agent.json");
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| format!("WRITE_FAILED: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空协议归一为_anthropic_合法值原样保留() {
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
    fn 旧配置没有上下文窗口时回落默认值() {
        let cfg: AgentConfig = serde_json::from_str(
            r#"{"provider":"openai","model":"m","base_url":"","api_key":"","max_tokens":8192}"#,
        )
        .unwrap();
        assert_eq!(cfg.context_window, default_context_window());
    }

    #[test]
    fn 上下文窗口为零时归一为默认值() {
        let mut cfg = AgentConfig::default();
        cfg.normalize();
        assert_eq!(cfg.context_window, default_context_window());
    }
}
