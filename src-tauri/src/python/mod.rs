//! Markdown 内嵌 Python:项目解析、配置、解释器解析。
//!
//! 项目模型:笔记在 vault 根下的第一层文件夹就是一个 python 项目(笔记直接
//! 躺在 vault 根时,vault 根本身即项目)。项目根下的 `.venv`、`pyproject.toml`
//! 与 PATH 上的 `uv` 共同决定运行环境(见 [`runner::resolve_env`])。
//! 每项目配置持久化在 `<vault>/.bnote/python.json`,按一级目录名索引。

pub mod lsp;
pub mod runner;
pub mod uvenv;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 单个项目的 python 设置。缺省字段 = 用自动探测。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectConfig {
    /// 语言服务器:"off"(默认)或 "ty"。
    #[serde(rename = "lsp", skip_serializing_if = "Option::is_none")]
    pub lsp: Option<String>,
    /// 显式解释器覆盖(绝对路径)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python: Option<String>,
    /// 显式 ty 可执行文件覆盖(路径或 PATH 上的命令名)。
    #[serde(rename = "tyPath", skip_serializing_if = "Option::is_none")]
    pub ty_path: Option<String>,
}

/// `<vault>/.bnote/python.json` 的整体结构。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PythonConfig {
    /// key = vault 一级目录名。
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub projects: std::collections::BTreeMap<String, ProjectConfig>,
}

impl PythonConfig {
    pub fn project(&self, name: &str) -> ProjectConfig {
        self.projects.get(name).cloned().unwrap_or_default()
    }
}

/// 项目定位结果。
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectRef {
    pub root: PathBuf,
    /// vault 一级目录名;笔记直接在 vault 根(或隐藏目录)时为空串。
    pub name: String,
}

/// 笔记所在的一级目录即项目根;隐藏目录(.bnote/.trash…)与 vault 根直属的
/// 笔记都归到 vault 根,避免把配置目录当项目。
pub fn resolve_project(vault: &Path, md_path: &Path) -> Result<ProjectRef, String> {
    let vault_c = vault
        .canonicalize()
        .unwrap_or_else(|_| vault.to_path_buf());
    let file = md_path
        .canonicalize()
        .unwrap_or_else(|_| crate::commands::normalize(md_path));
    let rel = file.strip_prefix(&vault_c).map_err(|_| {
        format!(
            "FORBIDDEN: {} is outside the vault {}",
            md_path.display(),
            vault_c.display()
        )
    })?;
    let comps: Vec<_> = rel.components().collect();
    // 笔记直接躺在 vault 根(rel 只有笔记自己一个分量)→ 项目 = vault。
    if comps.len() <= 1 {
        return Ok(ProjectRef { root: vault_c, name: String::new() });
    }
    let first = comps[0].as_os_str().to_string_lossy().to_string();
    if first.starts_with('.') {
        return Ok(ProjectRef { root: vault_c, name: String::new() });
    }
    Ok(ProjectRef { root: vault_c.join(&first), name: first })
}

pub fn config_path(vault: &Path) -> PathBuf {
    vault.join(".bnote").join("python.json")
}

pub fn load_config(vault: &Path) -> PythonConfig {
    match std::fs::read_to_string(config_path(vault)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => PythonConfig::default(),
    }
}

pub fn save_config(vault: &Path, config: &PythonConfig) -> Result<(), String> {
    let path = config_path(vault);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("WRITE_FAILED: {}", e))?;
    }
    let body = serde_json::to_string_pretty(config)
        .map_err(|e| format!("SERIALIZE_FAILED: {}", e))?;
    std::fs::write(&path, body + "\n").map_err(|e| format!("WRITE_FAILED: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bnote-py-test-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn nested_note_uses_first_level_folder_as_project() {
        let vault = tmpdir("proj");
        let note = vault.join("ml-notes").join("sub").join("a.md");
        std::fs::create_dir_all(note.parent().unwrap()).unwrap();
        std::fs::write(&note, "").unwrap();
        let p = resolve_project(&vault, &note).unwrap();
        // resolve_project 返回 canonicalize 后的路径(macOS 上 /tmp 是
        // /private/tmp 的软链),期望值同样 canonicalize。
        let expect_root = vault.canonicalize().unwrap().join("ml-notes");
        assert_eq!(p.root, expect_root);
        assert_eq!(p.name, "ml-notes");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn root_note_and_hidden_dirs_belong_to_vault_root() {
        let vault = tmpdir("root");
        let vault_c = vault.canonicalize().unwrap();
        let note = vault.join("a.md");
        std::fs::write(&note, "").unwrap();
        let p = resolve_project(&vault, &note).unwrap();
        assert_eq!(p.root, vault_c);
        assert_eq!(p.name, "");

        let hidden = vault.join(".bnote").join("keybindings.json");
        std::fs::create_dir_all(hidden.parent().unwrap()).unwrap();
        std::fs::write(&hidden, "").unwrap();
        let p = resolve_project(&vault, &hidden).unwrap();
        assert_eq!(p.root, vault_c);
        assert_eq!(p.name, "");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn outside_vault_is_rejected() {
        let vault = tmpdir("vault-o");
        let other = tmpdir("other-o");
        let note = other.join("a.md");
        std::fs::write(&note, "").unwrap();
        assert!(resolve_project(&vault, &note).is_err());
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn config_roundtrip() {
        let vault = tmpdir("cfg");
        let mut cfg = PythonConfig::default();
        cfg.projects.insert(
            "ml-notes".into(),
            ProjectConfig { lsp: Some("ty".into()), python: None, ty_path: None },
        );
        save_config(&vault, &cfg).unwrap();
        let loaded = load_config(&vault);
        assert_eq!(loaded, cfg);
        assert_eq!(loaded.project("ml-notes").lsp.as_deref(), Some("ty"));
        assert_eq!(loaded.project("missing"), ProjectConfig::default());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn missing_config_file_is_default() {
        let vault = tmpdir("cfg-missing");
        assert_eq!(load_config(&vault), PythonConfig::default());
        let _ = std::fs::remove_dir_all(&vault);
    }
}
