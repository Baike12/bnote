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
use super::output_style::OutputStyle;
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
    pub mcp_names: &'a [String],
    /// The resolved output style (`settings.outputStyle`); None = the default
    /// shape, which adds no segment.
    pub output_style: Option<&'a OutputStyle>,
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

/// The boundary between the cacheable static prefix and the per-session
/// dynamic tail (Claude Code's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`). Anthropic
/// turns it into two system blocks, the first carrying `cache_control`; a
/// prompt without the marker stays one block.
pub const CACHE_BOUNDARY: &str = "\u{0}bnote:dynamic\u{0}";

/// Assembles the full system prompt (segments joined by blank lines). The
/// marker between the static and dynamic parts is preserved for the provider.
pub fn assemble(input: &AssembleInput) -> String {
    let segs = segments(input);
    let mut out = String::new();
    let mut crossed = false;
    for seg in segs.iter().filter(|s| s.loaded) {
        let content = seg.content.trim();
        if content.is_empty() {
            continue;
        }
        if seg.dynamic && !crossed {
            out.push_str(CACHE_BOUNDARY);
            crossed = true;
        }
        if !out.is_empty() && !out.ends_with(CACHE_BOUNDARY) {
            out.push_str("\n\n");
        }
        out.push_str(content);
    }
    out
}

/// Splits an assembled prompt at [`CACHE_BOUNDARY`]. Prompts without the
/// marker return `(whole, "")`.
pub fn split_cache(system: &str) -> (&str, &str) {
    match system.split_once(CACHE_BOUNDARY) {
        Some((head, tail)) => (head, tail),
        None => (system, ""),
    }
}

/// Builds the segment list.
pub fn segments(input: &AssembleInput) -> Vec<PromptSegment> {
    let mut segs = Vec::new();
    // The agent's prompt layers are compiled in; their order is the definition
    // order. They are static: editing them requires a new build, and the
    // cached prefix must not change between turns.
    //
    // A style with `keep-coding-instructions: false` replaces everything after
    // the identity layer (Claude Code's rule): the style itself carries the
    // working instructions it wants.
    let replace_coding = input
        .output_style
        .map(|style| !style.is_default() && !style.keep_coding_instructions)
        .unwrap_or(false);
    let layers = if replace_coding {
        input.def.prompts.get(..1).unwrap_or(&[])
    } else {
        &input.def.prompts[..]
    };
    for (index, content) in layers.iter().enumerate() {
        segs.push(PromptSegment::new(
            10 + index as i32,
            &format!("prompt:{}", index + 1),
            *content,
            false,
        ));
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
    if tools.iter().any(|t| t == "mcp") {
        segs.push(PromptSegment::new(
            40,
            "mcp",
            mcp_section(input.mcp_names),
            false,
        ));
    }
    if let Some(style) = input.output_style.filter(|s| !s.is_default()) {
        segs.push(PromptSegment::new(
            60,
            "output-style",
            format!("# Output Style: {}\n\n{}", style.name, style.content.trim()),
            // The body of a user style is a file: editing it takes effect on
            // the next turn, like an instruction file.
            true,
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
    if has("EnterPlanMode") {
        r.push_str(
            "- EnterPlanMode / ExitPlanMode:改动会跨多个文件、或方案需要用户拍板时,先进入计划模式只读调研,再用 ExitPlanMode 提交完整计划;批准前不要写任何文件。\n",
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

/// The skill inventory, sent in the conversation's first `<system-reminder>`
/// (Claude Code sends it as an attachment too, never as a system segment).
pub fn skills_section(skills: &[SkillInfo]) -> String {
    if skills.is_empty() {
        return "The following skills are available for use with the Skill tool:\n(none)".into();
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
    // A coding session works in a repository, not in the notebook: the vault
    // name and the current note would only be noise there.
    if input.workdir.is_none() {
        if !input.vault_name.is_empty() {
            e.push_str(&format!("- Vault: {}\n", input.vault_name));
        }
        if let Some(note) = input.current_note {
            e.push_str(&format!("- Current note: {note}\n"));
        }
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

    fn find(id: &str) -> AgentDefinition {
        defs_mod::definition(id).unwrap()
    }

    fn input<'a>(def: &'a AgentDefinition, mcp: &'a [String]) -> AssembleInput<'a> {
        AssembleInput {
            def,
            vault_name: "vault",
            current_note: None,
            workdir: None,
            study: None,
            mcp_names: mcp,
            output_style: None,
        }
    }

    #[test]
    fn the_user_instructions_are_not_a_system_segment() {
        // CC carries CLAUDE.md as a `<system-reminder>` user message in front of
        // the conversation (Session::request_items), so the cached system prefix
        // never changes when the instructions file is edited.
        let study = find("study");
        let base = assemble(&input(&study, &[]));
        assert!(base.contains("结论先行"));
        assert!(!base.contains("AGENTS.md"));
        assert!(!base.contains("今日"));
    }

    #[test]
    fn the_qa_only_prompt_contains_no_tool_instructions() {
        // The study assistant registers no tools; the assembled prompt must not
        // invite any (the historical defect this locks out: a prompt steering
        // toward tools that do not exist).
        let study = find("study");
        let p = assemble(&input(&study, &[]));
        assert!(!p.contains("tool"), "{}", p);
        assert!(!p.contains("read_study_content"));
        assert!(!p.contains("skill"));
        assert!(!p.contains("mcp__"));
        assert!(!p.contains("MCP"));
    }

    #[test]
    fn the_skill_listing_is_not_a_system_segment() {
        // CC sends the inventory as a `skill_listing` attachment in the
        // conversation; the system prompt keeps only the generic instruction.
        let creative = find("creative");
        let p = assemble(&input(&creative, &[]));
        assert!(p.contains("/skill-name"));
        assert!(p.contains("@path/to/file"));
        assert!(p.contains("preview_html"));
        assert!(!p.contains("## 可用技能"), "{}", p);

        let skills = vec![SkillInfo {
            name: "html-blog".into(),
            description: "把 markdown 排版成博客 HTML".into(),
            path: "/x/SKILL.md".into(),
        }];
        let listing = skills_section(&skills);
        assert!(listing.contains("- html-blog: 把 markdown 排版成博客 HTML"));

        let p = assemble(&input(&creative, &["mcp__volcano__shell".to_string()]));
        assert!(p.contains("- mcp__volcano__shell"));
        assert!(p.contains("## 工具"));
    }

    #[test]
    fn segments_are_ordered_and_the_prompt_layers_are_static_code() {
        let coding = find("coding");
        let inp = input(&coding, &[]);
        let segs = segments(&inp);
        let orders: Vec<i32> = segs.iter().map(|s| s.order).collect();
        let mut sorted = orders.clone();
        sorted.sort();
        assert_eq!(orders, sorted, "segments must come out in order");
        let env = segs.iter().find(|s| s.name == "environment").unwrap();
        assert!(env.dynamic);
        let identity = segs.iter().find(|s| s.name == "prompt:1").unwrap();
        assert!(identity.content.contains("coding agent"));
        assert!(!identity.dynamic, "compiled prompts never change at runtime");
        assert_eq!(
            segs.iter().filter(|s| s.name.starts_with("prompt:")).count(),
            8
        );
        assert!(
            !segs.iter().any(|s| s.name == "user-instructions"),
            "the instructions file is a user message, not a segment"
        );
        assert!(segs.iter().any(|s| s.name == "tool-rules" && !s.dynamic));
    }

    #[test]
    fn the_cache_boundary_separates_static_sections_from_the_environment() {
        let coding = find("coding");
        let mut inp = input(&coding, &[]);
        inp.workdir = Some("/tmp/proj");
        let p = assemble(&inp);
        let (static_part, dynamic_part) = split_cache(&p);
        assert!(static_part.contains("# Doing tasks"));
        assert!(!static_part.contains("- Working directory"));
        assert!(dynamic_part.contains("- Working directory: /tmp/proj"));
        assert!(split_cache("plain").1.is_empty());
    }

    #[test]
    fn the_coding_prompt_names_the_tools_and_the_workdir() {
        let coding = find("coding");
        let mut inp = input(&coding, &[]);
        inp.workdir = Some("/tmp/proj");
        let p = assemble(&inp);
        assert!(p.contains("- Working directory: /tmp/proj"), "{}", p);
        assert!(p.contains("glob"));
        assert!(p.contains("task 子代理"));
        assert!(p.contains("todo"));
    }

    #[test]
    fn the_prompt_sections_keep_claude_code_order() {
        let coding = find("coding");
        let p = assemble(&input(&coding, &[]));
        let system = p.find("# System").unwrap();
        let doing = p.find("# Doing tasks").unwrap();
        let care = p.find("# Executing actions with care").unwrap();
        let tools = p.find("# Using your tools").unwrap();
        let tone = p.find("# Tone and style").unwrap();
        let output = p.find("# Output efficiency").unwrap();
        let session = p.find("# Session-specific guidance").unwrap();
        assert!(system < doing && doing < care && care < tools);
        assert!(tools < tone && tone < output && output < session);
    }

    #[test]
    fn today_string_formats_an_explicit_epoch_day() {
        // 2026-11-03 is 20760 days after 1970-01-01.
        assert_eq!(civil_from_days(20_760), "2026-11-03");
        assert_eq!(civil_from_days(0), "1970-01-01");
        assert_eq!(civil_from_days(19_723), "2024-01-01");
    }
}
