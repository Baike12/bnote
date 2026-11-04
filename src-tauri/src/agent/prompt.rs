//! Prompt assembly: an ordered segment pipeline instead of one hard-coded
//! builder per session kind.
//!
//! Segments carry an `order` (stable sort, ties keep insertion order) and a
//! `dynamic` flag. Static segments (tool rules, skill/MCP lists) are assembled
//! once at session start; dynamic segments (the agent's prompt files,
//! environment, user instructions) are re-read before every turn so a saved
//! `SYSTEM_PROMPT.md` / `.bnote/AGENTS.md` edit takes effect on the next
//! message without reopening the session.

use super::defs::AgentDefinition;
use super::skills::SkillInfo;
use super::tools::StudyContent;

/// Assembled context for one session.
pub struct AssembleInput<'a> {
    pub def: &'a AgentDefinition,
    pub vault_name: &'a str,
    pub current_note: Option<&'a str>,
    /// Code project root (coding sessions); reported to the model as the
    /// working directory.
    pub workdir: Option<&'a str>,
    pub study: Option<&'a StudyContent>,
    pub skills: &'a [SkillInfo],
    pub mcp_names: &'a [String],
}

#[derive(Debug, Clone)]
pub struct PromptSegment {
    pub order: i32,
    pub name: String,
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

/// Builds the segment list.
pub fn segments(input: &AssembleInput) -> Vec<PromptSegment> {
    let mut segs = Vec::new();
    // The agent's prompt files are the identity layer; their order is chosen
    // in agent.json. A file that vanished between two turns is reported as
    // not loaded instead of taking the session down.
    for prompt in &input.def.prompts {
        let read = input
            .def
            .dir
            .as_ref()
            .and_then(|dir| std::fs::read_to_string(dir.join(&prompt.file)).ok());
        match read {
            Some(content) => segs.push(PromptSegment {
                order: prompt.order,
                name: format!("prompt:{}", prompt.file),
                content,
                dynamic: true,
                loaded: true,
            }),
            None => segs.push(PromptSegment {
                order: prompt.order,
                name: format!("prompt:{}", prompt.file),
                content: String::new(),
                dynamic: true,
                loaded: false,
            }),
        }
    }

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
    // Claude Code appends the git snapshot to the end of the system prompt; the
    // model then knows the branch and the dirty files without a tool call.
    if let Some(status) = input.workdir.and_then(git_status) {
        segs.push(PromptSegment::new(70, "git-status", status, true));
    }
    // Definition prompt files are resolved inside the agent directory and
    // sorted together with the fixed segments above.
    segs.sort_by_key(|s| s.order);
    segs
}

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
    if has("task_create") || has("task_update") {
        r.push_str(
            "- 多步任务(3 步以上)用 task_create 建任务,推进时用 task_update 改状态;task_list / task_get 查看。todo 与任务列表二选一,不要混用。\n",
        );
    }
    if has("send_message") {
        r.push_str(
            "- send_message:用 task 返回的 agentId 继续一个已有的子代理(包括因额度/错误停下的),它的历史会带回来;不要为同一个问题重新开一个新子代理。\n",
        );
    }
    if has("ask_user_question") {
        r.push_str(
            "- ask_user_question:真正需要用户决策时才问(方案取舍、缺失需求、会改变实现的歧义),每问给 2-4 个具体选项。不要一遇到摩擦就提问,也不要把能自己查清的事情丢给用户。\n",
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

/// The git snapshot CC appends to the system prompt (context.ts): branch,
/// short status (capped) and the last five commits. `None` outside a repo, so a
/// non-git project simply gets no segment.
fn git_status(workdir: &str) -> Option<String> {
    let run = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(workdir)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    let branch = run(&["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch.is_empty() {
        return None;
    }
    let mut text = String::from("## Git status\n\n");
    text.push_str(
        "This is the git status at the start of the conversation. It does not update during the conversation; run `git status` yourself when you need the current state.\n\n",
    );
    text.push_str(&format!("Current branch: {}\n", branch));
    if let Some(status) = run(&["status", "--short"]) {
        let capped: String = status.chars().take(2_000).collect();
        if !capped.trim().is_empty() {
            text.push_str(&format!("\nStatus:\n{}\n", capped));
        }
    }
    if let Some(log) = run(&["log", "--oneline", "-5"]) {
        if !log.trim().is_empty() {
            text.push_str(&format!("\nRecent commits:\n{}\n", log));
        }
    }
    Some(text)
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
    use crate::agent::defs as defs_mod;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_vault(tag: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "bnote-prompt-{}-{}-{}",
            tag,
            std::process::id(),
            unique
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        defs_mod::seed_agents(&dir).unwrap();
        dir
    }

    fn loaded(vault: &std::path::Path) -> Vec<AgentDefinition> {
        let (defs, errors) = defs_mod::load_definitions(Some(vault));
        assert!(errors.is_empty(), "{:?}", errors);
        defs
    }

    fn find<'a>(defs: &'a [AgentDefinition], id: &str) -> &'a AgentDefinition {
        defs.iter().find(|d| d.id == id).unwrap()
    }

    fn input<'a>(
        def: &'a AgentDefinition,
        skills: &'a [SkillInfo],
        mcp: &'a [String],
    ) -> AssembleInput<'a> {
        AssembleInput {
            def,
            vault_name: "vault",
            current_note: None,
            workdir: None,
            study: None,
            skills,
            mcp_names: mcp,

        }
    }

    #[test]
    fn the_user_instructions_are_not_a_system_segment() {
        // CC carries CLAUDE.md as a `<system-reminder>` user message in front of
        // the conversation (Session::request_items), so the cached system prefix
        // never changes when the instructions file is edited.
        let vault = temp_vault("fixed");
        let defs = loaded(&vault);
        let study = find(&defs, "study");
        let base = assemble(&input(study, &[], &[]));
        assert!(base.contains("结论先行"));
        assert!(!base.contains("AGENTS.md"));
        assert!(!base.contains("今日"));
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn the_qa_only_prompt_contains_no_tool_instructions() {
        // The study assistant registers no tools; the assembled prompt must not
        // invite any (the historical defect this locks out: a prompt steering
        // toward tools that do not exist).
        let vault = temp_vault("study");
        let defs = loaded(&vault);
        let study = find(&defs, "study");
        let p = assemble(&input(study, &[], &[]));
        assert!(!p.contains("tool"), "{}", p);
        assert!(!p.contains("read_study_content"));
        assert!(!p.contains("skill"));
        assert!(!p.contains("mcp__"));
        assert!(!p.contains("MCP"));
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn the_creative_prompt_has_the_skill_and_instruction_sections_with_a_fallback() {
        let vault = temp_vault("creative");
        let defs = loaded(&vault);
        let creative = find(&defs, "creative");
        let p = assemble(&input(creative, &[], &[]));
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
        let p = assemble(&input(creative, &skills, &["mcp__volcano__shell".to_string()]));
        assert!(p.contains("- html-blog: 把 markdown 排版成博客 HTML"));
        assert!(p.contains("- mcp__volcano__shell"));
        let tools = p.find("## 工具").unwrap();
        let skills_at = p.find("## 可用技能").unwrap();
        assert!(tools < skills_at, "tool rules precede the skill list");
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn segments_are_ordered_and_prompt_files_reload_every_turn() {
        let vault = temp_vault("segments");
        let defs = loaded(&vault);
        let coding = find(&defs, "coding");
        let inp = input(coding, &[], &[]);
        let segs = segments(&inp);
        let orders: Vec<i32> = segs.iter().map(|s| s.order).collect();
        let mut sorted = orders.clone();
        sorted.sort();
        assert_eq!(orders, sorted, "segments must come out in order");
        let env = segs.iter().find(|s| s.name == "environment").unwrap();
        assert!(env.dynamic);
        let identity = segs
            .iter()
            .find(|s| s.name == "prompt:SYSTEM_PROMPT.md")
            .unwrap();
        assert!(identity.dynamic, "a saved prompt applies on the next turn");
        assert!(identity.content.contains("coding agent"));
        assert!(
            !segs.iter().any(|s| s.name == "user-instructions"),
            "the instructions file is a user message, not a segment"
        );
        assert!(segs.iter().any(|s| s.name == "tool-rules" && !s.dynamic));
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn the_coding_prompt_names_the_new_tools_and_the_workdir() {
        let vault = temp_vault("workdir");
        let defs = loaded(&vault);
        let coding = find(&defs, "coding");
        let mut inp = input(coding, &[], &[]);
        inp.workdir = Some("/tmp/proj");
        let p = assemble(&inp);
        assert!(p.contains("- Working directory: /tmp/proj"), "{}", p);
        assert!(p.contains("glob"));
        assert!(p.contains("task 子代理"));
        assert!(p.contains("todo"));
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn prompt_files_are_read_from_the_agent_directory_in_order() {
        let vault = temp_vault("files");
        let coding_dir = vault.join(".bnote/agents/coding");
        std::fs::write(
            coding_dir.join("STYLE.md"),
            "# 项目守则\n\n用 tab 缩进。",
        )
        .unwrap();
        let config_path = coding_dir.join("agent.json");
        let mut config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        config["prompts"] = serde_json::json!([
            { "file": "SYSTEM_PROMPT.md", "order": 10 },
            { "file": "STYLE.md", "order": 70 }
        ]);
        std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).unwrap();
        let (defs, errors) = defs_mod::load_definitions(Some(&vault));
        assert!(errors.is_empty(), "{:?}", errors);
        // A file deleted after session start is reported by the runtime
        // segment (the loader already validated the files at load time).
        let mut coding = find(&defs, "coding").clone();
        coding.prompts.push(defs_mod::PromptFile {
            file: "MISSING.md".into(),
            order: 80,
        });
        let inp = input(&coding, &[], &[]);
        let segs = segments(&inp);
        let style = segs.iter().find(|s| s.name == "prompt:STYLE.md").unwrap();
        assert!(style.loaded && style.content.contains("tab 缩进"));
        assert_eq!(style.order, 70);
        let missing = segs
            .iter()
            .find(|s| s.name == "prompt:MISSING.md")
            .unwrap();
        assert!(!missing.loaded);
        let style_pos = segs.iter().position(|s| s.name == "prompt:STYLE.md").unwrap();
        let identity_pos = segs
            .iter()
            .position(|s| s.name == "prompt:SYSTEM_PROMPT.md")
            .unwrap();
        assert!(identity_pos < style_pos);

        // A prompt file edited on disk is picked up without a reload.
        std::fs::write(coding_dir.join("STYLE.md"), "改过的守则").unwrap();
        let p = assemble(&input(&coding, &[], &[]));
        assert!(p.contains("改过的守则"));
        std::fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn today_string_formats_an_explicit_epoch_day() {
        // 2026-11-03 is 20760 days after 1970-01-01.
        assert_eq!(civil_from_days(20_760), "2026-11-03");
        assert_eq!(civil_from_days(0), "1970-01-01");
        assert_eq!(civil_from_days(19_723), "2024-01-01");
    }
}
