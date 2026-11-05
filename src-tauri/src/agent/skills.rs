//! SKILL.md discovery: scans the skill directories of a mode for `SKILL.md`
//! files with YAML frontmatter (name, description). The `skill` tool loads the
//! full content.
//!
//! The roots depend on the mode, and each entry remembers where it came from:
//!
//!   coding    `<mode root>/skills` (vault), `<project>/.agents/skills`
//!             (project), `~/.agents/skills` (home), plus `skillDirs`
//!   creative  `<mode root>/skills` only (a creative agent must not inherit the
//!             coding agent's skills)
//!   study     none (no tools)

use super::home::{self, AgentMode};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub path: String,
    /// `vault` | `project` | `home` | `custom`
    pub source: String,
    /// The scanned root this skill belongs to.
    pub root: String,
}

pub struct SkillRegistry {
    pub skills: Vec<SkillInfo>,
}

/// One scanned root and its `source` label.
#[derive(Debug, Clone)]
pub struct SkillRoot {
    pub path: PathBuf,
    pub source: &'static str,
}

/// The roots a mode scans, in precedence order (the first definition of a name
/// wins). Kept public so the settings page can list a source that is empty.
pub fn roots_for(
    mode: AgentMode,
    root: &Path,
    workdir: Option<&Path>,
    extra: &[String],
) -> Vec<SkillRoot> {
    match mode {
        AgentMode::Coding => {
            let mut roots = vec![SkillRoot {
                path: home::mode_skills_dir(root),
                source: "vault",
            }];
            if let Some(project) = workdir {
                roots.push(SkillRoot {
                    path: project.join(".agents").join("skills"),
                    source: "project",
                });
            }
            roots.push(SkillRoot {
                path: home::shared_agents_skills(),
                source: "home",
            });
            roots.extend(extra.iter().map(|dir| SkillRoot {
                path: PathBuf::from(dir),
                source: "custom",
            }));
            roots
        }
        AgentMode::Creative => vec![SkillRoot {
            path: home::mode_skills_dir(root),
            source: "vault",
        }],
        AgentMode::Study => Vec::new(),
    }
}

impl SkillRegistry {
    /// Scans the mode's roots. Each direct subdirectory may hold a `SKILL.md`.
    /// A duplicated name keeps the first (highest-precedence) definition; a
    /// name listed in `disabled` is skipped.
    pub fn discover(
        mode: AgentMode,
        root: &Path,
        workdir: Option<&Path>,
        extra: &[String],
        disabled: &[String],
    ) -> SkillRegistry {
        let mut skills: Vec<SkillInfo> = Vec::new();
        for root in roots_for(mode, root, workdir, extra) {
            let Ok(rd) = std::fs::read_dir(&root.path) else {
                continue;
            };
            for entry in rd.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let skill_md = path.join("SKILL.md");
                let Ok(content) = std::fs::read_to_string(&skill_md) else {
                    continue;
                };
                let (name, description) = parse_frontmatter(&content);
                let name = name.unwrap_or_else(|| {
                    path.file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default()
                });
                if disabled.iter().any(|d| d == &name) {
                    continue;
                }
                if skills.iter().any(|s| s.name == name) {
                    continue;
                }
                skills.push(SkillInfo {
                    name,
                    description: description.unwrap_or_default(),
                    path: skill_md.to_string_lossy().to_string(),
                    source: root.source.to_string(),
                    root: root.path.to_string_lossy().to_string(),
                });
            }
        }
        skills.sort_by(|a, b| a.name.cmp(&b.name));
        SkillRegistry { skills }
    }

    /// Full skill content (the model reads this via the `skill` tool).
    pub fn load(&self, name: &str) -> Option<String> {
        let info = self.skills.iter().find(|s| s.name == name)?;
        let content = std::fs::read_to_string(&info.path).ok()?;
        let mut out = format!("# Skill: {}\n\n{}", info.name, content);
        // mention sibling files so the model can read_file them
        if let Some(dir) = std::path::Path::new(&info.path).parent() {
            if let Ok(rd) = std::fs::read_dir(dir) {
                let mut files = Vec::new();
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy() != "SKILL.md" {
                        files.push(e.file_name().to_string_lossy().to_string());
                    }
                }
                if !files.is_empty() {
                    out.push_str(&format!(
                        "\nSupporting files in this skill directory: {}\n",
                        files.join(", ")
                    ));
                }
            }
        }
        Some(out)
    }
}

fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut description = None;
    let mut in_fm = false;
    let mut fm_ended = false;
    let mut prev_dash = false;
    for line in content.lines() {
        if !in_fm {
            if line.trim() == "---" {
                if prev_dash || content.starts_with("---") {
                    in_fm = true;
                }
                prev_dash = true;
                continue;
            }
        } else if line.trim() == "---" {
            fm_ended = true;
            break;
        } else if in_fm {
            if let Some(rest) = line.strip_prefix("name:") {
                name = Some(rest.trim().trim_matches('"').trim_matches('\'').to_string());
            } else if let Some(rest) = line.strip_prefix("description:") {
                description = Some(rest.trim().trim_matches('"').trim_matches('\'').to_string());
            }
        }
    }
    let _ = fm_ended;
    (name, description)
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
            "bnote-skills-{}-{}-{}",
            tag,
            std::process::id(),
            unique
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn skill(root: &Path, name: &str, description: &str) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n\nbody\n"),
        )
        .unwrap();
    }

    #[test]
    fn coding_scans_vault_then_project_then_home_with_sources() {
        let vault_root = temp("vault");
        let project = temp("project");
        skill(
            &home::mode_skills_dir(&vault_root),
            "shared",
            "from the vault",
        );
        skill(&project.join(".agents/skills"), "local", "from the project");
        let registry =
            SkillRegistry::discover(AgentMode::Coding, &vault_root, Some(&project), &[], &[]);
        let by_name = |name: &str| {
            registry
                .skills
                .iter()
                .find(|s| s.name == name)
                .unwrap_or_else(|| panic!("missing {name}"))
        };
        assert_eq!(by_name("shared").source, "vault");
        assert_eq!(by_name("local").source, "project");
    }

    #[test]
    fn a_higher_precedence_skill_wins_and_disabled_names_are_hidden() {
        let vault_root = temp("precedence");
        let project = temp("precedence-project");
        skill(&home::mode_skills_dir(&vault_root), "dup", "vault copy");
        skill(&project.join(".agents/skills"), "dup", "project copy");
        skill(&project.join(".agents/skills"), "hidden", "hidden one");
        let registry = SkillRegistry::discover(
            AgentMode::Coding,
            &vault_root,
            Some(&project),
            &[],
            &["hidden".to_string()],
        );
        let dup: Vec<&SkillInfo> = registry.skills.iter().filter(|s| s.name == "dup").collect();
        assert_eq!(dup.len(), 1);
        assert_eq!(dup[0].description, "vault copy");
        assert!(!registry.skills.iter().any(|s| s.name == "hidden"));
    }

    #[test]
    fn creative_only_reads_its_own_root_and_study_reads_nothing() {
        let root = temp("creative");
        skill(&home::mode_skills_dir(&root), "mine", "creative only");
        let project = temp("creative-project");
        skill(&project.join(".agents/skills"), "borrowed", "coding only");
        let creative =
            SkillRegistry::discover(AgentMode::Creative, &root, Some(&project), &[], &[]);
        assert_eq!(creative.skills.len(), 1);
        assert_eq!(creative.skills[0].name, "mine");
        let study = SkillRegistry::discover(AgentMode::Study, &root, Some(&project), &[], &[]);
        assert!(study.skills.is_empty());
    }
}
