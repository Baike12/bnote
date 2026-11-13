/**
 * One-line summaries for the tool cards (ZCode's renderer family, reduced to
 * the shapes bnote emits). Pure input→label so the cards stay cheap during
 * streaming and the logic is unit-testable outside the component tree.
 *
 * The canonical vocabulary is Claude Code's (`Read`/`Edit`/`Bash`/…); legacy
 * snake_case names from restored transcripts resolve to the same labels.
 */

export interface ToolSummary {
  /** The category word of the title row ("正在读取" while running, "读取" after). */
  kind: string;
  /** The primary text: what the call touched (a path, a pattern, a command). */
  primary: string;
  /** For Edit: the +N/−N line counts ZCode shows next to the file name. */
  diff: { added: number; removed: number } | null;
}

const LEGACY_NAMES: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  list_files: "LS",
  glob: "Glob",
  grep: "Grep",
  bash: "Bash",
  bash_output: "TaskOutput",
  bash_kill: "TaskStop",
  todo: "TodoWrite",
  task: "Agent",
  task_create: "TaskCreate",
  task_update: "TaskUpdate",
  task_list: "TaskList",
  task_get: "TaskGet",
  send_message: "SendMessage",
  ask_user_question: "AskUserQuestion",
  read_url: "WebFetch",
  skill: "Skill",
};

function inputOf(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The first path-ish field of the input (CC's `file_path` then `path`). */
function pathOf(input: Record<string, unknown>): string {
  return str(input.file_path) || str(input.path) || str(input.notebook_path);
}

/** The +N/−N of an Edit: the replaced lines removed and the replacement added. */
function diffOfEdit(input: Record<string, unknown>): ToolSummary["diff"] {
  const count = (text: string) => (text === "" ? 0 : text.split("\n").length);
  const removed = count(str(input.old_string));
  const added = count(str(input.new_string));
  if (removed === 0 && added === 0) return null;
  return { added, removed };
}

/** The tool's canonical name (Claude Code's vocabulary); legacy names resolve to it. */
export function canonicalToolName(name: string): string {
  return LEGACY_NAMES[name] ?? name;
}

/**
 * An Agent tool's result is addressed to the *model*: it carries the agent id
 * so a later SendMessage can continue that agent. The card is read by the
 * user, who needs the report and nothing else, so the id line is dropped
 * before display (the raw output on disk keeps it verbatim).
 */
export function stripAgentTrailer(output: string): string {
  return output
    .split("\n")
    .filter((line) => !line.startsWith("agentId: "))
    .join("\n")
    .trimEnd();
}

/** The summary of one tool call; unknown tools fall back to their own name. */
export function toolSummary(name: string, input: unknown, running: boolean): ToolSummary {
  const canonical = canonicalToolName(name);
  const inp = inputOf(input);
  const kind = (live: string, done: string) => (running ? live : done);
  switch (canonical) {
    case "Read":
      return { kind: kind("正在读取", "读取"), primary: pathOf(inp), diff: null };
    case "Write":
      return { kind: kind("正在写入", "写入"), primary: pathOf(inp), diff: null };
    case "Edit":
      return {
        kind: kind("正在编辑", "编辑"),
        primary: pathOf(inp),
        diff: diffOfEdit(inp),
      };
    case "Bash": {
      const command = str(inp.command).replace(/\s+/g, " ").trim();
      return {
        kind: kind("正在执行", "执行"),
        primary: command,
        diff: null,
      };
    }
    case "Glob":
      return { kind: kind("正在搜索", "搜索"), primary: str(inp.pattern), diff: null };
    case "Grep":
      return { kind: kind("正在搜索", "搜索"), primary: str(inp.pattern), diff: null };
    case "LS":
      return { kind: kind("正在列出", "列出"), primary: "项目文件", diff: null };
    case "WebFetch":
      return { kind: kind("正在获取", "获取"), primary: str(inp.url), diff: null };
    case "TodoWrite": {
      const todos = Array.isArray(inp.todos) ? inp.todos.length : 0;
      return { kind: kind("更新任务清单", "任务清单"), primary: `${todos} 项`, diff: null };
    }
    case "Agent":
      return {
        kind: kind("派发子代理", "子代理"),
        primary: str(inp.description) || str(inp.subagent_type) || "通用",
        diff: null,
      };
    case "SendMessage":
      return { kind: kind("正在发消息", "发消息"), primary: str(inp.to), diff: null };
    case "TaskCreate":
      return { kind: "任务", primary: str(inp.subject), diff: null };
    case "TaskUpdate":
      return { kind: "任务", primary: str(inp.taskId) || str(inp.task_id), diff: null };
    case "TaskList":
      return { kind: "任务", primary: "全部任务", diff: null };
    case "TaskGet":
      return { kind: "任务", primary: str(inp.taskId) || str(inp.task_id), diff: null };
    case "TaskOutput":
      return {
        kind: kind("正在读取输出", "后台输出"),
        primary: str(inp.task_id ?? inp.id) ? `#${str(inp.task_id ?? inp.id)}` : "",
        diff: null,
      };
    case "TaskStop":
      return {
        kind: "停止任务",
        primary: str(inp.task_id ?? inp.id) ? `#${str(inp.task_id ?? inp.id)}` : "",
        diff: null,
      };
    case "Skill":
      return {
        kind: kind("正在加载技能", "技能"),
        primary: str(inp.skill) || str(inp.name),
        diff: null,
      };
    case "AskUserQuestion":
      return { kind: "提问", primary: "等待你的选择", diff: null };
    case "EnterPlanMode":
      return { kind: kind("进入计划模式", "计划模式"), primary: "", diff: null };
    case "ExitPlanMode":
      return { kind: kind("提交计划", "计划"), primary: "", diff: null };
    case "preview_html":
      return { kind: kind("正在预览", "预览"), primary: pathOf(inp), diff: null };
    case "read_study_content":
      return { kind: kind("正在读取", "读取"), primary: "当前材料", diff: null };
    default:
      return { kind: kind("正在调用", canonical), primary: "", diff: null };
  }
}

/** Duration label in ZCode's two-unit style ("1 分 30 秒", "12 秒"). */
export function workDurationLabel(ms: number | null): string {
  if (ms == null || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 时 ${minutes % 60} 分`;
}
