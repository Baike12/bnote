import { isTodo, parseListLine, todoText } from "@/daily/model";

/**
 * 项目视图的数据模型。
 *
 * 一个项目 = `<vault>/.bnote/projects/<项目名>.md` 里的一份待办列表。
 * 用 markdown 而不是自定义 JSON 是刻意的:项目待办要能用 vim 编辑、能勾选、
 * 能被跨文件待办同步(mirror/send)识别——那条链路只认 markdown 的列表行。
 * 项目名就是文件名,所以日记里「⇄ 项目名」的来源标签不需要额外映射。
 */

/** 项目文件所在目录(vault 相对)。 */
export const PROJECTS_DIR = ".bnote/projects";

export function projectsDirAbs(vaultRoot: string): string {
  return `${vaultRoot.replace(/\/+$/, "")}/${PROJECTS_DIR}`;
}

/** 某项目文件的绝对路径。 */
export function projectPathFor(vaultRoot: string, name: string): string {
  return `${projectsDirAbs(vaultRoot)}/${name}.md`;
}

/** 项目文件 → 项目名(去掉目录与 .md 扩展名)。 */
export function projectNameOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}

/** 绝对路径是否指向项目文件。 */
export function isProjectPath(path: string): boolean {
  return path.startsWith("/") && path.includes(`/${PROJECTS_DIR}/`);
}

/** 文件名里不能出现的字符;同时把连续空白压成一个,避免菜单里出现怪名字。 */
const ILLEGAL_NAME = /[/\\:*?"<>|\0]/g;

/** 用户输入 → 可用的项目文件名(不含 .md);全被过滤掉时返回空串。 */
export function sanitizeProjectName(raw: string): string {
  return raw
    .replace(ILLEGAL_NAME, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 60)
    .trim();
}

export interface ProjectTodo {
  /** 1 基行号。 */
  line: number;
  /** 缩进宽度(字符数),用于卡片里的层级缩进。 */
  indent: number;
  /** 身份文本(剥掉 checkbox 与 ✅ 戳)。 */
  text: string;
  done: boolean;
  /** 整行原文(拖拽时原样带上子项外的这一行)。 */
  raw: string;
}

/** 文档里的全部待办行(保持出现顺序)。 */
export function projectTodos(text: string): ProjectTodo[] {
  const out: ProjectTodo[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseListLine(lines[i]);
    if (!isTodo(parsed)) continue;
    out.push({
      line: i + 1,
      indent: parsed.indent.length,
      text: todoText(parsed),
      done: parsed.box !== " ",
      raw: lines[i],
    });
  }
  return out;
}

export interface ProjectCounts {
  total: number;
  done: number;
}

export function projectCounts(todos: ProjectTodo[]): ProjectCounts {
  let done = 0;
  for (const t of todos) if (t.done) done++;
  return { total: todos.length, done };
}
