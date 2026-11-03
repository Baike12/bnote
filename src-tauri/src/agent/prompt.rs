//! Prompt assembly: an ordered segment pipeline instead of one hard-coded
//! builder per session kind.
//!
//! Segments carry an `order` (stable sort, ties keep insertion order) and a
//! `dynamic` flag. Static segments (identity, tool rules, skill/MCP lists) are
//! assembled once at session start; dynamic segments (environment, user
//! instructions, definition prompt layers) are re-read before every turn so a
//! saved `.bnote/AGENTS.md` edit takes effect on the next message without
//! reopening the session. The segment list doubles as the assembly preview the
//! agent-definitions settings page renders.

use super::defs::AgentDefinition;
use super::skills::SkillInfo;
use super::tools::StudyContent;

/// Assembled context for one session.
pub struct AssembleInput<'a> {
    pub def: &'a AgentDefinition,
    pub vault_name: &'a str,
    pub current_note: Option<&'a str>,
    /// Code project root (coding sessions); extra prompt layers resolve here first.
    pub workdir: Option<&'a str>,
    /// Open vault root; file layers fall back here when the workdir misses.
    pub vault: Option<&'a Path>,
    pub study: Option<&'a StudyContent>,
    pub skills: &'a [SkillInfo],
    pub mcp_names: &'a [String],
    /// Content of the vault's `.bnote/AGENTS.md` (already loaded by the caller).
    pub user_instructions: &'a str,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PromptSegment {
    pub order: i32,
    pub name: String,
    #[serde(skip_serializing)]
    pub content: String,
    /// Re-read before every turn.
    pub dynamic: bool,
    /// For file layers: false when the file could not be read (the segment is
    /// then dropped from the prompt; the preview surfaces the reason).
    pub loaded: bool,
}

impl PromptSegment {
    fn new(order: i32, name: &str, content: impl Into<String>, dynamic: bool) -> Self {
        PromptSegment {
            order,
            name: name.to_string(),
            content: content.into(),
            dynamic,
            loaded: true,
        }
    }
}

/// Assembles the full system prompt (segments joined by blank lines).
pub fn assemble(input: &AssembleInput) -> String {
    let segs = segments(input);
    segs.iter()
        .filter(|s| s.loaded)
        .map(|s| s.content.trim())
        .filter(|c| !c.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Builds the segment list (the assembly preview and the join source).
pub fn segments(input: &AssembleInput) -> Vec<PromptSegment> {
    let mut segs = Vec::new();
    segs.push(PromptSegment::new(
        10,
        "identity",
        input.def.body.clone(),
        false,
    ));

    let tools = input.def.effective_tools();
    if !tools.is_empty() {
        segs.push(PromptSegment::new(
            20,
            "tool-rules",
            tool_rules(&tools),
            false,
        ));
    }
    if tools.iter().any(|t| t == "skill") {
        segs.push(PromptSegment::new(
            30,
            "skills",
            skills_section(input.skills),
            false,
        ));
    }
    if tools.iter().any(|t| t == "mcp") {
        segs.push(PromptSegment::new(
            40,
            "mcp",
            mcp_section(input.mcp_names),
            false,
        ));
    }
    segs.push(PromptSegment::new(
        50,
        "environment",
        environment(input),
        true,
    ));
    let user = input.user_instructions.trim();
    if !user.is_empty() {
        segs.push(PromptSegment::new(
            60,
            "user-instructions",
            format!("## 用户自定义指令(.bnote/AGENTS.md)\n\n{user}\n"),
            true,
        ));
    }
    // Definition file layers resolve against the working directory first, then
    // the vault — AGENTS.md-style guides may live in the code project.
    for layer in &input.def.prompt_layers {
        let read = input
            .workdir
            .and_then(|wd| std::fs::read_to_string(Path::new(wd).join(&layer.file)).ok())
            .or_else(|| {
                input
                    .vault
                    .and_then(|v| std::fs::read_to_string(v.join(&layer.file)).ok())
            });
        match read {
            Some(content) => segs.push(PromptSegment {
                order: layer.order,
                name: format!("layer:{}", layer.file),
                content,
                dynamic: true,
                loaded: true,
            }),
            None => segs.push(PromptSegment {
                order: layer.order,
                name: format!("layer:{}", layer.file),
                content: String::new(),
                dynamic: true,
                loaded: false,
            }),
        }
    }
    segs.sort_by_key(|s| s.order);
    segs
}

use std::path::Path;

fn tool_rules(tools: &[String]) -> String {
    let has = |n: &str| tools.iter().any(|t| t == n);
    let mut r = String::from("## 工具\n\n");
    if has("read_file") {
        r.push_str(
            "- 优先用专用工具,不用 bash 替代:读文件用 read_file,整篇写用 write_file,局部改用 edit_file;bash 留给确实需要 shell 的场景。\n",
        );
        r.push_str("- 动任何文件前先 read_file;多个相互独立的调用放在同一轮并行发出。\n");
    }
    if has("glob") || has("grep") {
        r.push_str(
            "- 定位代码用 glob / grep:glob 按文件名模式列文件,grep 按正则搜内容;不要用 bash 的 find/grep 替代,专用工具更快且尊重 .gitignore。\n",
        );
    }
    if has("bash") {
        r.push_str(
            "- bash 的工作目录跨调用持久(cd 会保留);返回带 exit code,默认 120 秒超时,长任务用 run_in_background。\n",
        );
    }
    if has("todo") {
        r.push_str(
            "- 用 todo 维护多步任务:开工前列计划(每项一步),任何时候只有一项 in_progress,完成即更新;简单单步任务不必建清单。\n",
        );
    }
    if has("task") {
        r.push_str(
            "- task 子代理:大范围探索、独立子问题交给子代理执行,它们有独立上下文,把结论带回来;子代理之间不共享各自的中间过程。\n",
        );
    }
    if has("preview_html") {
        r.push_str(
            "- preview_html 预览 vault 内的 HTML 文件:先 write_file 保存,再 preview_html 指向该文件。预览是交付的一部分,改完必须刷新预览。\n",
        );
    }
    if has("skill") {
        r.push_str(
            "- 用户消息里的两个约定:\n  - `/skill-name`:用户选择了这个技能,先调用 skill 工具加载它,再严格按其指导行动;列出的技能之外不要猜名字。\n  - `@path/to/file`:用户引用了仓库里的文件,用 read_file 读取它。\n",
        );
    }
    if has("mcp") {
        r.push_str(
            "- `mcp__<服务器>__<工具>` 形式的工具来自 MCP 服务器,调用方式与内置工具相同。\n",
        );
    }
    r
}

fn skills_section(skills: &[SkillInfo]) -> String {
    if skills.is_empty() {
        return "## 可用技能\n\n(仓库暂无技能;用户提到 /技能名 时如实告知没有找到。)\n\n".into();
    }
    let mut s = String::from("## 可用技能\n\n用户可以用 /技能名 调用,你也可以按描述主动匹配:\n\n");
    for skill in skills {
        let desc = skill.description.trim();
        s.push_str(&format!(
            "- {}: {}\n",
            skill.name,
            if desc.is_empty() { "(无描述)" } else { desc }
        ));
    }
    s.push('\n');
    s
}

fn mcp_section(names: &[String]) -> String {
    if names.is_empty() {
        return "## MCP\n\n(未连接 MCP 服务器。)\n\n".into();
    }
    let mut s = String::from("## MCP\n\n已连接工具:\n\n");
    for name in names {
        s.push_str(&format!("- {name}\n"));
    }
    s.push('\n');
    s
}

fn environment(input: &AssembleInput) -> String {
    let mut e = String::from("## 环境\n\n");
    if !input.vault_name.is_empty() {
        e.push_str(&format!("- Vault: {}\n", input.vault_name));
    }
    if let Some(note) = input.current_note {
        e.push_str(&format!("- Current note: {note}\n"));
    }
    if let Some(wd) = input.workdir {
        e.push_str(&format!("- Working directory: {wd}\n"));
    }
    e.push_str(&format!("- Today: {}\n", today_string()));
    match input.study {
        Some(StudyContent::Pdf { path, title }) => {
            e.push_str(&format!("- Study content: PDF \"{title}\" at {path}\n"));
        }
        Some(StudyContent::Url { url, title }) => {
            e.push_str(&format!("- Study content: web page \"{title}\" at {url}\n"));
        }
        Some(StudyContent::Code { path, title }) => {
            e.push_str(&format!(
                "- Study content: code project \"{title}\" at {path}\n"
            ));
        }
        None => {}
    }
    e
}

/// Local-date string (YYYY-MM-DD) without a chrono dependency: days since the
/// epoch → civil date (Howard Hinnant's algorithm).
pub fn today_string() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    civil_from_days(days)
}

fn civil_from_days(z: i64) -> String {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::defs::{builtins, AgentDefinition};

    fn input<'a>(
        def: &'a AgentDefinition,
        user: &'a str,
        skills: &'a [SkillInfo],
        mcp: &'a [String],
    ) -> AssembleInput<'a> {
        AssembleInput {
            def,
            vault_name: "vault",
            current_note: None,
            workdir: None,
            vault: None,
            study: None,
            skills,
            mcp_names: mcp,
            user_instructions: user,
        }
    }

    #[test]
    fn fixed_requirements_precede_the_custom_instructions_and_an_empty_section_is_omitted() {
        let defs = builtins();
        let study = defs.iter().find(|d| d.id == "study").unwrap();
        let base = assemble(&input(study, "", &[], &[]));
        assert!(base.contains("结论先行"));
        assert!(!base.contains(".bnote/AGENTS.md"));

        let with_user = assemble(&input(study, "  多用表格回答。 \n", &[], &[]));
        let custom = with_user.find("多用表格回答。").unwrap();
        let fixed = with_user.find("结论先行").unwrap();
        assert!(
            fixed < custom,
            "custom instructions must follow the fixed requirements"
        );
    }

    #[test]
    fn the_qa_only_prompt_contains_no_tool_instructions() {
        // The study assistant registers no tools; the assembled prompt must not
        // invite any (the historical defect this locks out: a prompt steering
        // toward tools that do not exist).
        let defs = builtins();
        let study = defs.iter().find(|d| d.id == "study").unwrap();
        let p = assemble(&input(study, "", &[], &[]));
        assert!(!p.contains("tool"), "{}", p);
        assert!(!p.contains("read_study_content"));
        assert!(!p.contains("skill"));
        assert!(!p.contains("mcp__"));
        assert!(!p.contains("MCP"));
    }

    #[test]
    fn the_creative_prompt_has_the_skill_and_instruction_sections_with_a_fallback() {
        let defs = builtins();
        let creative = defs.iter().find(|d| d.id == "creative").unwrap();
        let p = assemble(&input(creative, "", &[], &[]));
        assert!(p.contains("/skill-name"));
        assert!(p.contains("@path/to/file"));
        assert!(p.contains("preview_html"));
        assert!(
            !p.contains("## 用户自定义指令(.bnote/AGENTS.md)"),
            "absent for empty input"
        );
        assert!(p.contains("仓库暂无技能"));
        assert!(p.contains("未连接 MCP 服务器"));

        let skills = vec![SkillInfo {
            name: "html-blog".into(),
            description: "把 markdown 排版成博客 HTML".into(),
            path: "/x/SKILL.md".into(),
        }];
        let p = assemble(&input(
            creative,
            "多用表格",
            &skills,
            &["mcp__volcano__shell".to_string()],
        ));
        assert!(p.contains("- html-blog: 把 markdown 排版成博客 HTML"));
        assert!(p.contains("- mcp__volcano__shell"));
        let custom = p.find("多用表格").unwrap();
        let tools = p.find("## 工具").unwrap();
        assert!(
            tools < custom,
            "the custom instructions must be appended after the tool rules"
        );
    }

    #[test]
    fn segments_are_ordered_and_dynamic_flags_split_the_reload_boundary() {
        let defs = builtins();
        let coding = defs.iter().find(|d| d.id == "coding").unwrap();
        let inp = input(coding, "自定义", &[], &[]);
        let segs = segments(&inp);
        let orders: Vec<i32> = segs.iter().map(|s| s.order).collect();
        let mut sorted = orders.clone();
        sorted.sort();
        assert_eq!(orders, sorted, "segments must come out in order");
        let env = segs.iter().find(|s| s.name == "environment").unwrap();
        assert!(env.dynamic);
        let identity = segs.iter().find(|s| s.name == "identity").unwrap();
        assert!(!identity.dynamic);
        let user = segs.iter().find(|s| s.name == "user-instructions").unwrap();
        assert!(user.dynamic);
        assert!(segs.iter().any(|s| s.name == "tool-rules" && !s.dynamic));
    }

    #[test]
    fn the_coding_prompt_names_the_new_tools_and_the_workdir() {
        let defs = builtins();
        let coding = defs.iter().find(|d| d.id == "coding").unwrap();
        let mut inp = input(coding, "", &[], &[]);
        inp.workdir = Some("/tmp/proj");
        let p = assemble(&inp);
        assert!(p.contains("- Working directory: /tmp/proj"), "{}", p);
        assert!(p.contains("glob"));
        assert!(p.contains("task 子代理"));
        assert!(p.contains("todo"));
        assert!(p.contains("- Today: "));
    }

    #[test]
    fn file_layers_load_relative_to_the_workdir_and_report_missing() {
        let dir = std::env::temp_dir().join("bnote-prompt-layers");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("AGENTS.md"), "# 项目守则\n\n用 tab 缩进。").unwrap();
        let defs = builtins();
        let mut coding = defs.iter().find(|d| d.id == "coding").unwrap().clone();
        coding.prompt_layers = vec![super::super::defs::PromptLayer {
            file: "AGENTS.md".into(),
            order: 45,
        }];
        let mut inp = input(&coding, "", &[], &[]);
        inp.workdir = Some(dir.to_str().unwrap());
        let segs = segments(&inp);
        let layer = segs.iter().find(|s| s.name == "layer:AGENTS.md").unwrap();
        assert!(layer.loaded && layer.content.contains("tab 缩进"));
        assert_eq!(layer.order, 45);
        assert!(layer.dynamic, "file layers reload every turn");

        // A missing layer is reported as not loaded and contributes no text.
        coding.prompt_layers.push(super::super::defs::PromptLayer {
            file: "nope.md".into(),
            order: 46,
        });
        let inp = input(&coding, "", &[], &[]);
        let segs = segments(&inp);
        let missing = segs.iter().find(|s| s.name == "layer:nope.md").unwrap();
        assert!(!missing.loaded);
        assert!(!assemble(&inp).contains("layer:"));

        // When the workdir misses, the vault is the fallback location.
        std::fs::write(dir.join("vault-guide.md"), "来自仓库的层").unwrap();
        coding.prompt_layers.push(super::super::defs::PromptLayer {
            file: "vault-guide.md".into(),
            order: 47,
        });
        let mut inp = input(&coding, "", &[], &[]);
        inp.vault = Some(dir.as_path());
        let p = assemble(&inp);
        assert!(p.contains("来自仓库的层"), "{}", p);
    }

    #[test]
    fn today_string_formats_an_explicit_epoch_day() {
        // 2026-11-03 is 20760 days after 1970-01-01.
        assert_eq!(civil_from_days(20_760), "2026-11-03");
        assert_eq!(civil_from_days(0), "1970-01-01");
        assert_eq!(civil_from_days(19_723), "2024-01-01");
    }
}
