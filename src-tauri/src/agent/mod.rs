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
        let mut cfg = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => AgentConfig {
                max_tokens: 8192,
                ..Default::default()
            },
        };
        cfg.normalize();
        cfg
    }

    /// 收敛协议字段的取值契约:只允许 "anthropic" | "openai"。
    ///
    /// 旧配置/手改数据里 provider 可能是空串;Provider 按字面量判
    /// `== "anthropic"`,空串会静默走 OpenAI 分支,请求路径与用户填的
    /// 协议对不上(表现为网关 404,和鉴权/模型错误难区分)。在加载边界
    /// 归一成 UI 默认显示的 anthropic,此后所有读取方都不必再防这个值。
    fn normalize(&mut self) {
        if self.provider != "anthropic" && self.provider != "openai" {
            self.provider = "anthropic".into();
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
}
