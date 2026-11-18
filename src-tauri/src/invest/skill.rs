//! Per-scope skills: SKILL.md (strategy) + MEMORY.md (facts), versioned.
//!
//! A scope address (`stock:600519` / `sector:801010` / `portfolio:<id>`) is
//! the ONLY way to reach a skill: the directory is derived from the parsed
//! scope, never from a user-supplied path, so one scope can never read
//! another's skill and no path traversal exists (the user's isolation
//! requirement). Skills are invisible to the other agent modes because their
//! roots (`<vault>/.bnote/agents/<mode>/`) never point into `.bnote/invest/`.

use std::path::PathBuf;

use rusqlite::Connection;

use crate::invest::model::{parse_scope, SkillBundle, SkillVersion};

const SKILL_FILE: &str = "SKILL.md";
const MEMORY_FILE: &str = "MEMORY.md";
const VERSIONS_DIR: &str = "versions";
const LEARNED_START: &str = "<!-- INVEST:LEARNED START -->";
const LEARNED_END: &str = "<!-- INVEST:LEARNED END -->";

/// `.bnote/invest/skills/<kind>/<code>/` derived strictly from the scope.
pub fn skill_dir(vault_root: &std::path::Path, scope: &str) -> Result<PathBuf, String> {
    let (kind, code) = parse_scope(scope)
        .filter(|(kind, _)| matches!(*kind, "stock" | "sector" | "portfolio"))
        .ok_or_else(|| format!("INVALID_SCOPE: {scope}"))?;
    // The code part must be a safe directory name: digits/dots for
    // stock/sector, a slug for portfolio — never a path segment.
    let safe = code
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !code.is_empty()
        && !code.starts_with('.');
    if !safe {
        return Err(format!("INVALID_SCOPE: {scope}"));
    }
    Ok(crate::invest::root_dir(vault_root)
        .join("skills")
        .join(kind)
        .join(code))
}

/// Reads the bundle, synthesizing an initial SKILL.md when absent (the
/// scaffold follows SkillOpt's shape: frontmatter + rule sections + the
/// protected learned block).
pub fn read(
    conn: &Connection,
    vault_root: &std::path::Path,
    scope: &str,
) -> Result<SkillBundle, String> {
    let dir = skill_dir(vault_root, scope)?;
    let skill_path = dir.join(SKILL_FILE);
    if !skill_path.exists() {
        scaffold(conn, vault_root, scope)?;
    }
    read_bundle(vault_root, scope)
}

/// The file-only bundle read (no scaffold, no doc registration). The agent's
/// `read_skill` tool uses this: it runs without a DB connection and must
/// never create state as a side effect of reading.
pub fn read_bundle(vault_root: &std::path::Path, scope: &str) -> Result<SkillBundle, String> {
    let dir = skill_dir(vault_root, scope)?;
    let skill_path = dir.join(SKILL_FILE);
    if !skill_path.exists() {
        return Err(format!("NOT_FOUND: no skill scaffold for {scope} yet"));
    }
    let skill = std::fs::read_to_string(&skill_path)
        .map_err(|e| format!("READ_FAILED: {} ({})", skill_path.display(), e))?;
    let memory = std::fs::read_to_string(dir.join(MEMORY_FILE)).unwrap_or_default();
    let version = parse_version(&skill);
    let versions = list_versions(&dir)?;
    Ok(SkillBundle {
        scope: scope.to_string(),
        version,
        skill,
        memory,
        versions,
    })
}

fn parse_version(skill: &str) -> i64 {
    // frontmatter `version: N` (default 1).
    for line in skill.lines().take(12) {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("version:") {
            if let Ok(n) = rest.trim().parse() {
                return n;
            }
        }
        // A blank line ends the frontmatter block.
        if line.is_empty() {
            break;
        }
    }
    1
}

fn list_versions(dir: &std::path::Path) -> Result<Vec<SkillVersion>, String> {
    let dir = dir.join(VERSIONS_DIR);
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !name.ends_with(".md") {
            continue;
        }
        let version = name
            .split('-')
            .next()
            .and_then(|p| p.strip_prefix('v'))
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        let created_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(SkillVersion {
            file: name,
            version,
            gate_score: None,
            created_at,
        });
    }
    out.sort_by(|a, b| b.version.cmp(&a.version).then(a.file.cmp(&b.file)));
    Ok(out)
}

/// Saves the strategy text (bumping `version` unless already bumped) into
/// SKILL.md, and the memory text into MEMORY.md. `snapshot` also writes a
/// numbered copy into `versions/`.
pub fn write(
    conn: &Connection,
    vault_root: &std::path::Path,
    scope: &str,
    skill: &str,
    memory: &str,
    snapshot: bool,
) -> Result<i64, String> {
    let dir = skill_dir(vault_root, scope)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("WRITE_FAILED: {} ({})", dir.display(), e))?;
    let current = std::fs::read_to_string(dir.join(SKILL_FILE)).unwrap_or_default();
    let current_version = parse_version(&current);
    let next_version = if snapshot {
        current_version + 1
    } else {
        current_version
    };
    let final_skill = with_version(skill, next_version);
    std::fs::write(dir.join(SKILL_FILE), &final_skill)
        .map_err(|e| format!("WRITE_FAILED: {} ({})", dir.display(), e))?;
    std::fs::write(dir.join(MEMORY_FILE), memory)
        .map_err(|e| format!("WRITE_FAILED: {} ({})", dir.display(), e))?;
    if snapshot {
        let versions_dir = dir.join(VERSIONS_DIR);
        std::fs::create_dir_all(&versions_dir)
            .map_err(|e| format!("WRITE_FAILED: {} ({})", versions_dir.display(), e))?;
        let name = format!("v{:04}-{}.md", next_version, gate_label(&final_skill));
        let path = versions_dir.join(&name);
        std::fs::write(&path, &final_skill)
            .map_err(|e| format!("WRITE_FAILED: {} ({})", path.display(), e))?;
        register_version_doc(conn, scope, next_version, &path)?;
    }
    Ok(next_version)
}

/// The version filename label: the strategy's first heading, slugified.
fn gate_label(skill: &str) -> String {
    let heading = skill
        .lines()
        .find(|l| l.trim_start().starts_with('#'))
        .map(|l| {
            l.trim_start()
                .trim_start_matches('#')
                .trim()
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() {
                        c.to_ascii_lowercase()
                    } else {
                        '-'
                    }
                })
                .collect::<String>()
        })
        .unwrap_or_else(|| "skill".to_string());
    let label: String = heading
        .split('-')
        .filter(|s| !s.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join("-");
    if label.is_empty() {
        "skill".to_string()
    } else {
        label
    }
}

/// Registers a version snapshot as a document so it shows in FTS / doc lists.
fn register_version_doc(
    conn: &Connection,
    scope: &str,
    version: i64,
    path: &PathBuf,
) -> Result<(), String> {
    let rel = path
        .to_str()
        .and_then(|p| p.rsplit(".bnote/invest/").next().map(|s| s.to_string()))
        .ok_or_else(|| "INVALID_PATH: skill version path is not UTF-8".to_string())?;
    let hash = format!("v{version}");
    crate::invest::docs::index_doc(
        conn,
        &rel,
        scope,
        "skill_version",
        &format!("skill v{version}"),
        "",
        0,
        &hash,
    )?;
    Ok(())
}

/// Replaces `version: N` in the frontmatter (inserting one when absent).
fn with_version(skill: &str, version: i64) -> String {
    let mut out = String::with_capacity(skill.len() + 16);
    let mut in_frontmatter = false;
    let mut wrote_version = false;
    let mut started = false;
    for line in skill.lines() {
        if line.trim() == "---" {
            if !started {
                started = true;
                in_frontmatter = true;
                out.push_str(line);
                out.push('\n');
                continue;
            }
            // Closing the frontmatter: inject a version line when missing.
            if !wrote_version {
                out.push_str(&format!("version: {version}\n"));
                wrote_version = true;
            }
            in_frontmatter = false;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if in_frontmatter && line.trim_start().starts_with("version:") {
            out.push_str(&format!("version: {version}\n"));
            wrote_version = true;
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !wrote_version && !started {
        // No frontmatter at all: prepend a minimal one.
        let mut full = format!("---\nversion: {version}\n---\n");
        full.push_str(&out);
        full
    } else {
        out
    }
}

/// Writes a bounded edit into the protected learned block (the gate's accept
/// path). `anchor` + `content` mirror SkillOpt's Edit ops; the block lives at
/// the end of SKILL.md and is never moved.
pub fn apply_learned_edit(
    vault_root: &std::path::Path,
    scope: &str,
    anchor: &str,
    content: &str,
    replace: bool,
) -> Result<(), String> {
    let dir = skill_dir(vault_root, scope)?;
    let path = dir.join(SKILL_FILE);
    let skill = if path.exists() {
        std::fs::read_to_string(&path)
            .map_err(|e| format!("READ_FAILED: {} ({})", path.display(), e))?
    } else {
        scaffold_text(scope)
    };
    let updated = if replace {
        if anchor.trim().is_empty() {
            return Err("INVALID_EDIT: replace needs an anchor".to_string());
        }
        match skill.split_once(anchor) {
            Some((before, after)) => {
                let after = match after.split_once('\n') {
                    Some((_, rest)) => rest,
                    None => "",
                };
                format!("{before}{content}{after}")
            }
            None => return Err(format!("NOT_FOUND: anchor not present in skill: {anchor}")),
        }
    } else {
        append_into_learned(&skill, content)?
    };
    std::fs::write(&path, updated)
        .map_err(|e| format!("WRITE_FAILED: {} ({})", path.display(), e))?;
    Ok(())
}

/// Appends one rule line inside the LEARNED block (creating it when missing).
/// Existing learned rules survive every append — only the gate's replace op
/// rewrites them.
fn append_into_learned(skill: &str, content: &str) -> Result<String, String> {
    if let Some((before, after)) = skill.split_once(LEARNED_START) {
        let (existing, rest) = match after.split_once(LEARNED_END) {
            Some((existing, rest)) => (existing, rest),
            None => return Err("CORRUPT_SKILL: LEARNED block is not closed".to_string()),
        };
        let mut body = before.to_string();
        body.push_str(LEARNED_START);
        body.push('\n');
        let existing = existing.trim_end();
        if !existing.is_empty() {
            body.push_str(existing);
            body.push('\n');
        }
        body.push_str(content.trim_end());
        body.push('\n');
        body.push_str(LEARNED_END);
        body.push_str(rest);
        Ok(body)
    } else {
        let mut skill = skill.trim_end().to_string();
        skill.push_str("\n\n");
        skill.push_str(LEARNED_START);
        skill.push('\n');
        skill.push_str(content.trim_end());
        skill.push('\n');
        skill.push_str(LEARNED_END);
        skill.push('\n');
        Ok(skill)
    }
}

/// The initial SKILL.md scaffold (one per scope, written on first read).
fn scaffold(conn: &Connection, vault_root: &std::path::Path, scope: &str) -> Result<(), String> {
    let dir = skill_dir(vault_root, scope)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("WRITE_FAILED: {} ({})", dir.display(), e))?;
    let path = dir.join(SKILL_FILE);
    if !path.exists() {
        std::fs::write(&path, scaffold_text(scope))
            .map_err(|e| format!("WRITE_FAILED: {} ({})", path.display(), e))?;
    }
    if !dir.join(MEMORY_FILE).exists() {
        std::fs::write(dir.join(MEMORY_FILE), memory_scaffold_text(scope))
            .map_err(|e| format!("WRITE_FAILED: {} ({})", dir.display(), e))?;
    }
    // Register both files in the doc index so they are listed per scope.
    register_skill_docs(conn, vault_root, scope)
}

fn register_skill_docs(
    conn: &Connection,
    vault_root: &std::path::Path,
    scope: &str,
) -> Result<(), String> {
    let dir = skill_dir(vault_root, scope)?;
    for (file, kind, title) in [
        (SKILL_FILE, "skill", "SKILL"),
        (MEMORY_FILE, "skill_memory", "MEMORY"),
    ] {
        let path = dir.join(file);
        let meta = match std::fs::metadata(&path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let rel = format!(
            "skills/{}/{}/{}",
            scope.split(':').next().unwrap_or("x"),
            scope.split(':').next_back().unwrap_or("x"),
            file
        );
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let hash = format!("{}-{}", mtime, content.len());
        crate::invest::docs::index_doc(conn, &rel, scope, kind, title, &content, mtime, &hash)?;
    }
    Ok(())
}

fn scaffold_text(scope: &str) -> String {
    format!(
        r#"---
name: {scope} 走势预测技能
scope: {scope}
version: 1
horizon: 5
---
# 走势预测技能

## 市场状态假设
- （由 Agent 在分析时填写：当前大盘/板块环境）

## 信号 → 方向规则
- 每条规则必须具体可验证（指标 + 阈值 + 方向 + 置信度）。

## 仓位与风控
- （止损与仓位建议）

## 已知失效模式
- （由预测验证循环沉淀：这套规则在什么情况下错得最惨）

## 输出契约
- 必须输出 JSON：{{"direction":"up|down|flat","expected_move":0.03,"confidence":0.6,"rationale":"…"}}

{LEARNED_START}
{LEARNED_END}
"#
    )
}

fn memory_scaffold_text(scope: &str) -> String {
    format!(
        r#"---
scope: {scope}
---
# 标的记忆

## 历史事实
- （已核实的关键事实，时间倒序）

## 事件日历
- （已知将发生的事件：财报、股东会、解禁…）

## 已证伪假设
- （被预测验证循环推翻的假设，避免重蹈）
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::invest::db;
    use std::path::PathBuf;

    fn temp_vault(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bnote-invest-skill-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scope_paths_are_isolated_and_safe() {
        let vault = temp_vault("paths");
        let d = skill_dir(&vault, "stock:600519").unwrap();
        assert!(d.ends_with("skills/stock/600519"));
        assert!(skill_dir(&vault, "sector:801120").is_ok());
        assert!(skill_dir(&vault, "market").is_err(), "market has no skill");
        assert!(skill_dir(&vault, "stock:../etc").is_err(), "no traversal");
        assert!(skill_dir(&vault, "noscope").is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn scaffold_read_write_and_versions() {
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        let vault = temp_vault("rw");
        let bundle = read(&conn, &vault, "stock:600519").unwrap();
        assert_eq!(bundle.version, 1);
        assert!(bundle.skill.contains("## 信号 → 方向规则"));
        assert!(bundle.skill.contains(LEARNED_START));
        assert!(bundle.memory.contains("## 已证伪假设"));

        let v = write(
            &conn,
            &vault,
            "stock:600519",
            &bundle.skill.replace(
                "每条规则必须具体可验证（指标 + 阈值 + 方向 + 置信度）。",
                "当 5 日均线向下且量比>1.2 时看跌，置信度 0.6。",
            ),
            &bundle.memory,
            true,
        )
        .unwrap();
        assert_eq!(v, 2);
        let updated = read(&conn, &vault, "stock:600519").unwrap();
        assert_eq!(updated.version, 2);
        assert!(updated.skill.contains("量比>1.2"));
        assert_eq!(updated.versions.len(), 1, "snapshot wrote one version file");
        assert_eq!(updated.versions[0].version, 2);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn learned_edits_stay_in_the_protected_block() {
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        let vault = temp_vault("learned");
        read(&conn, &vault, "sector:801050").unwrap();

        apply_learned_edit(
            &vault,
            "sector:801050",
            "",
            "- 当 LME 铜价周涨 >3% 时看涨，置信度 0.55。",
            false,
        )
        .unwrap();
        apply_learned_edit(
            &vault,
            "sector:801050",
            "",
            "- OVERRIDE: 放量滞涨时上述规则置信度降至 0.4。",
            false,
        )
        .unwrap();

        let bundle = read(&conn, &vault, "sector:801050").unwrap();
        let learned_start = bundle.skill.find(LEARNED_START).unwrap();
        let learned_end = bundle.skill.find(LEARNED_END).unwrap();
        let block = &bundle.skill[learned_start..learned_end];
        assert!(block.contains("LME 铜价"), "block: {block:?}");
        assert!(block.contains("OVERRIDE"));
        // The strategy sections are untouched by learned appends.
        assert!(bundle.skill.contains("## 输出契约"));

        // Replace requires an existing anchor.
        assert!(apply_learned_edit(&vault, "sector:801050", "不存在的锚点", "x", true).is_err());
        let anchored = "- 当 LME 铜价周涨 >3% 时看涨，置信度 0.55。";
        apply_learned_edit(
            &vault,
            "sector:801050",
            anchored,
            "- 当 LME 铜价周涨 >3% 且板块热度上升时看涨，置信度 0.6。",
            true,
        )
        .unwrap();
        let bundle = read(&conn, &vault, "sector:801050").unwrap();
        assert!(bundle.skill.contains("板块热度上升"));
        assert!(!bundle.skill.contains("置信度 0.55"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn with_version_updates_or_inserts_frontmatter() {
        let skill = "---\nname: x\nscope: stock:600519\nversion: 3\n---\n# body";
        assert!(with_version(skill, 5).contains("version: 5"));
        assert!(!with_version(skill, 5).contains("version: 3"));
        let no_fm = "# just a heading\n";
        let out = with_version(no_fm, 2);
        assert!(out.starts_with("---\nversion: 2\n---\n"));
        assert!(out.contains("# just a heading"));
    }
}
