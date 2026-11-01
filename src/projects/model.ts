import { isTodo, parseListLine, todoText } from "@/daily/model";

/**
 * Data model of the project view.
 *
 * A project = one todo list in `<vault>/.bnote/projects/<project name>.md`.
 * Using markdown instead of a custom JSON format is deliberate: a project todo has
 * to be editable with vim, has to be checkable and has to be recognized by the
 * cross-file todo sync (mirror/send) - that chain only understands markdown list
 * lines. The project name is the file name, so the "⇄ project name" source label
 * in the daily note needs no extra mapping.
 */

/** Directory the project files live in (vault relative). */
export const PROJECTS_DIR = ".bnote/projects";

export function projectsDirAbs(vaultRoot: string): string {
  return `${vaultRoot.replace(/\/+$/, "")}/${PROJECTS_DIR}`;
}

/** Absolute path of a project file. */
export function projectPathFor(vaultRoot: string, name: string): string {
  return `${projectsDirAbs(vaultRoot)}/${name}.md`;
}

/** Project file -> project name (directory and .md extension stripped). */
export function projectNameOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}

/** Whether the absolute path points at a project file. */
export function isProjectPath(path: string): boolean {
  return path.startsWith("/") && path.includes(`/${PROJECTS_DIR}/`);
}

/** Characters that may not appear in a file name; runs of whitespace are also collapsed into one, so no weird names show up in the menu. */
const ILLEGAL_NAME = /[/\\:*?"<>|\0]/g;

/** User input -> a usable project file name (without .md); an empty string when everything was filtered out. */
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
  /** 1-based line number. */
  line: number;
  /** Indent width (in characters), used for the hierarchy indent in the card. */
  indent: number;
  /** Identity text (checkbox and done stamp stripped). */
  text: string;
  done: boolean;
  /** The raw line (on a drag this line is carried over as it is, apart from its children). */
  raw: string;
}

/** All todo lines of the document (in the order they appear). */
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
