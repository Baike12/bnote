//! SKILL.md discovery: scans skill directories for `SKILL.md` files with
//! YAML frontmatter (name, description). The `skill` tool loads full content.

use std::path::PathBuf;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub path: String,
}

pub struct SkillRegistry {
    pub skills: Vec<SkillInfo>,
}

impl SkillRegistry {
    /// Scans: <app_data>/skills, <vault>/.bnote/skills, ~/.agents/skills,
    /// plus any user-configured dirs. Each direct subdirectory may hold a
    /// SKILL.md (also accepted at the dir root itself).
    pub fn discover(data_dir: &PathBuf, vault: Option<&PathBuf>, extra: &[String]) -> SkillRegistry {
        let mut roots: Vec<PathBuf> = Vec::new();
        roots.push(data_dir.join("skills"));
        if let Some(v) = vault {
            roots.push(v.join(".bnote").join("skills"));
        }
        if let Some(home) = dirs_home() {
            roots.push(home.join(".agents").join("skills"));
        }
        for e in extra {
            roots.push(PathBuf::from(e));
        }
        let mut skills = Vec::new();
        for root in roots {
            let Ok(rd) = std::fs::read_dir(&root) else {
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
                    path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
                });
                skills.push(SkillInfo {
                    name,
                    description: description.unwrap_or_default(),
                    path: skill_md.to_string_lossy().to_string(),
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

    /// System-prompt block listing available skills.
    pub fn prompt_block(&self) -> String {
        if self.skills.is_empty() {
            return String::new();
        }
        let mut out = String::from("\n## Skills\n\nLoad a skill with the `skill` tool before following it.\n");
        for s in &self.skills {
            out.push_str(&format!("- **{}**: {}\n", s.name, s.description));
        }
        out
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

fn dirs_home() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}
