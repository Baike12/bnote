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
    /// MCP servers: name → {command,args,env} or {url,headers}.
    #[serde(default)]
    pub mcp_servers: std::collections::BTreeMap<String, McpServerConfig>,
    /// Extra skill directories to scan (in addition to built-ins).
    #[serde(default)]
    pub skill_dirs: Vec<String>,
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
        match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => AgentConfig {
                max_tokens: 8192,
                ..Default::default()
            },
        }
    }

    pub fn save(&self, data_dir: &PathBuf) -> Result<(), String> {
        let path = data_dir.join("agent.json");
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| format!("WRITE_FAILED: {}", e))
    }
}
