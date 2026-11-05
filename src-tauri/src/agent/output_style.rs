//! Output styles, following Claude Code's `output-styles`.
//!
//! A style is a markdown body that replaces the "how to answer" part of the
//! system prompt while the working rules (tools, permissions) stay. The three
//! built-in styles are compiled into the binary like the agent prompts; a user
//! style is a markdown file in
//!   `~/.bnote/output-styles/*.md`            (user)
//!   `<project>/.bnote/output-styles/*.md`    (project)
//! with an optional frontmatter block:
//!
//! ```text
//! ---
//! name: 教学
//! description: 边写边讲
//! keep-coding-instructions: false
//! ---
//! <body>
//! ```
//!
//! The id is the file stem. `keep-coding-instructions: false` means the style
//! *replaces* the coding prompt layers (everything after the identity layer),
//! which is what Claude Code does for a style that carries its own complete
//! instructions. A project file overrides a user file, a file overrides a
//! built-in style with the same id.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StyleSource {
    Builtin,
    User,
    Project,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OutputStyle {
    /// File stem (built-ins use `default` / `explanatory` / `learning`).
    pub id: String,
    pub name: String,
    pub description: String,
    /// false = the style replaces the coding prompt layers.
    pub keep_coding_instructions: bool,
    pub content: String,
    pub source: StyleSource,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub keep_coding_instructions: bool,
    /// `builtin` | `user` | `project`
    pub source: String,
}

impl OutputStyle {
    fn builtin(
        id: &str,
        name: &str,
        description: &str,
        content: &'static str,
    ) -> OutputStyle {
        OutputStyle {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            keep_coding_instructions: true,
            content: content.into(),
            source: StyleSource::Builtin,
        }
    }

    pub fn is_default(&self) -> bool {
        self.id == "default"
    }

    pub fn info(&self) -> StyleInfo {
        StyleInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            keep_coding_instructions: self.keep_coding_instructions,
            source: match self.source {
                StyleSource::Builtin => "builtin".into(),
                StyleSource::User => "user".into(),
                StyleSource::Project => "project".into(),
            },
        }
    }
}

const EXPLANATORY: &str = include_str!("../../resources/agents/output-styles/explanatory.md");
const LEARNING: &str = include_str!("../../resources/agents/output-styles/learning.md");

pub fn builtin() -> Vec<OutputStyle> {
    vec![
        OutputStyle::builtin(
            "default",
            "Default",
            "默认:直接、紧凑,只讲做了什么。",
            // The default shape is already the coding prompt layers.
            "",
        ),
        OutputStyle::builtin(
            "explanatory",
            "Explanatory",
            "解释型:写代码前后给出与当前代码库相关的教学式洞见。",
            EXPLANATORY,
        ),
        OutputStyle::builtin(
            "learning",
            "Learning",
            "学习型:把关键的一小段留成 TODO(human),让你自己动手写。",
            LEARNING,
        ),
    ]
}

/// The style directories, in override order (later wins).
fn style_dirs(project: Option<&Path>) -> Vec<(PathBuf, StyleSource)> {
    let mut dirs = vec![(
        crate::agent::home::home_dir().join("output-styles"),
        StyleSource::User,
    )];
    if let Some(project) = project {
        dirs.push((
            project.join(".bnote").join("output-styles"),
            StyleSource::Project,
        ));
    }
    dirs
}

/// Every available style, built-ins first, then user, then project files
/// (a later style with the same id replaces the earlier one).
pub fn discover(project: Option<&Path>) -> Vec<OutputStyle> {
    let mut styles = builtin();
    for (dir, source) in style_dirs(project) {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
            .collect();
        files.sort();
        for path in files {
            let Some(style) = load_file(&path, source) else {
                continue;
            };
            match styles.iter_mut().find(|s| s.id == style.id) {
                Some(existing) => *existing = style,
                None => styles.push(style),
            }
        }
    }
    styles
}

/// Resolves a style by id (case-insensitive), falling back to the default.
pub fn resolve(project: Option<&Path>, name: Option<&str>) -> OutputStyle {
    let styles = discover(project);
    let wanted = name.map(|n| n.trim().to_lowercase()).unwrap_or_default();
    if wanted.is_empty() {
        return styles
            .into_iter()
            .find(|s| s.is_default())
            .unwrap_or_else(|| builtin_default());
    }
    styles
        .into_iter()
        .find(|s| s.id.to_lowercase() == wanted)
        .unwrap_or_else(|| builtin_default())
}

pub fn builtin_default() -> OutputStyle {
    builtin()
        .into_iter()
        .next()
        .unwrap_or_else(|| OutputStyle::builtin("default", "Default", "", ""))
}

fn load_file(path: &Path, source: StyleSource) -> Option<OutputStyle> {
    let raw = std::fs::read_to_string(path).ok()?;
    let (meta, body) = split_frontmatter(&raw);
    let id = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if id.is_empty() || body.trim().is_empty() {
        return None;
    }
    let name = meta
        .iter()
        .find(|(key, _)| key == "name")
        .map(|(_, value)| value.clone())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| id.clone());
    let description = meta
        .iter()
        .find(|(key, _)| key == "description")
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    let keep = meta
        .iter()
        .find(|(key, _)| key == "keep-coding-instructions")
        .map(|(_, value)| value.trim() != "false")
        .unwrap_or(true);
    Some(OutputStyle {
        id,
        name,
        description,
        keep_coding_instructions: keep,
        content: body.trim().to_string(),
        source,
    })
}

/// Parses the `---` frontmatter block. A file without one is all body.
fn split_frontmatter(raw: &str) -> (Vec<(String, String)>, &str) {
    let trimmed = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let Some(rest) = trimmed.strip_prefix("---") else {
        return (Vec::new(), trimmed);
    };
    // The opening fence must be alone on its line.
    let Some(rest) = rest.strip_prefix('\n').or_else(|| rest.strip_prefix("\r\n")) else {
        return (Vec::new(), trimmed);
    };
    let Some(end) = find_fence(rest) else {
        return (Vec::new(), trimmed);
    };
    let (block, after) = rest.split_at(end);
    let body = after
        .strip_prefix("---")
        .unwrap_or(after)
        .trim_start_matches(['\r', '\n']);
    let mut meta = Vec::new();
    for line in block.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        if key.is_empty() {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        meta.push((key, value.to_string()));
    }
    (meta, body)
}

/// Byte offset of the closing `---` line inside `text`.
fn find_fence(text: &str) -> Option<usize> {
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        if bare.trim() == "---" {
            return Some(offset);
        }
        offset += line.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp(tag: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "bnote-style-{}-{}-{}",
            tag,
            std::process::id(),
            unique
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".bnote/output-styles")).unwrap();
        dir
    }

    #[test]
    fn the_builtins_are_default_explanatory_and_learning() {
        let ids: Vec<String> = builtin().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["default", "explanatory", "learning"]);
    }

    #[test]
    fn an_unknown_style_falls_back_to_default() {
        let style = resolve(None, Some("does-not-exist"));
        assert_eq!(style.id, "default");
        assert!(style.content.is_empty());
    }

    #[test]
    fn a_project_file_overrides_a_builtin_with_the_same_id() {
        let project = temp("override");
        std::fs::write(
            project.join(".bnote/output-styles/learning.md"),
            "---\nname: 我的学习\ndescription: d\nkeep-coding-instructions: false\n---\nbody here\n",
        )
        .unwrap();
        let style = resolve(Some(&project), Some("Learning"));
        assert_eq!(style.name, "我的学习");
        assert!(!style.keep_coding_instructions);
        assert_eq!(style.content, "body here");
        assert_eq!(style.source, StyleSource::Project);
        std::fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn a_file_without_frontmatter_uses_its_stem_as_the_name() {
        let project = temp("plain");
        std::fs::write(project.join(".bnote/output-styles/terse.md"), "Short answers.\n").unwrap();
        let style = resolve(Some(&project), Some("terse"));
        assert_eq!(style.name, "terse");
        assert!(style.keep_coding_instructions);
        assert_eq!(style.content, "Short answers.");
        std::fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn an_empty_body_is_not_a_style() {
        let project = temp("empty");
        std::fs::write(project.join(".bnote/output-styles/empty.md"), "---\nname: x\n---\n").unwrap();
        assert!(!discover(Some(&project)).iter().any(|s| s.id == "empty"));
        std::fs::remove_dir_all(&project).unwrap();
    }
}
