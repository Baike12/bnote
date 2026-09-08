/** vimrc parser supporting a practical subset of vim mapping commands. */

export type VimMode = "normal" | "insert" | "visual";

export interface VimMapping {
  lhs: string; // vim key notation, e.g. "jj" or "<C-s>"
  rhs: string; // key sequence or ":ex-command"
  mode: VimMode;
  noremap: boolean;
  /** Set when rhs refers to a bnote command (":w", ":Bnote <command-id>"). */
  commandId?: string;
}

export interface VimrcResult {
  mappings: VimMapping[];
  errors: string[];
  /** `set clipboard=unnamed` (or cb=…) — sync the vim unnamed register with the system clipboard. */
  clipboardUnnamed: boolean;
}

const EX_ALIASES: Record<string, string> = {
  w: "workspace.save-note",
  write: "workspace.save-note",
  wq: "workspace.save-note-and-close",
  x: "workspace.save-note-and-close",
  q: "workspace.close-window",
  "q!": "workspace.close-window",
  quit: "workspace.close-window",
  noh: "editor.clear-search-highlight",
  nohlsearch: "editor.clear-search-highlight",
};

const MAP_COMMANDS = new Set([
  "map",
  "noremap",
  "nmap",
  "nnoremap",
  "imap",
  "inoremap",
  "vmap",
  "vnoremap",
  "xmap",
  "xnoremap",
]);

function modeOf(cmd: string): VimMode {
  if (cmd.startsWith("i")) return "insert";
  if (cmd.startsWith("v") || cmd.startsWith("x")) return "visual";
  return "normal";
}

function stripComment(line: string): string {
  // Full-line comments start with `"`. Trailing comments follow whitespace.
  const trimmed = line.trimStart();
  if (trimmed.startsWith('"')) return "";
  const idx = line.indexOf(' "');
  return idx === -1 ? line : line.slice(0, idx);
}

export function parseVimrc(source: string): VimrcResult {
  const mappings: VimMapping[] = [];
  const errors: string[] = [];
  let clipboardUnnamed = false;

  for (const rawLine of source.split("\n")) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const cmd = parts[0];

    if (cmd === "set") {
      // `set clipboard=unnamed` wires vim yank/put to the system clipboard;
      // other options (number, scrolloff…) are accepted silently.
      const opt = parts[1] ?? "";
      const m = /^clipboard(?:=|\^=)(.+)$/.exec(opt);
      if (m && /(^|,)unnamed(,|$)/.test(m[1])) clipboardUnnamed = true;
      continue;
    }

    if (cmd === "unmap" || cmd === "nunmap" || cmd === "iunmap" || cmd === "vunmap") {
      const lhs = parts.slice(1).join(" ");
      const mode: VimMode = cmd === "iunmap" ? "insert" : cmd === "vunmap" ? "visual" : "normal";
      const i = mappings.findIndex((m) => m.lhs === lhs && m.mode === mode);
      if (i !== -1) mappings.splice(i, 1);
      else errors.push(`unmap: no mapping for ${lhs}`);
      continue;
    }

    if (MAP_COMMANDS.has(cmd)) {
      const rest = line.slice(cmd.length).trim();
      // lhs ends at the first whitespace that is not inside <>; vimrc lhs/rhs
      // are separated by whitespace, keys like <C-s> contain none.
      const m = /^(\S+)\s+(.+)$/.exec(rest);
      if (!m) {
        errors.push(`cannot parse: ${line}`);
        continue;
      }
      const lhs = m[1];
      let rhs = m[2].trim();
      if (lhs.includes("<leader>")) {
        errors.push(`unsupported <leader> mapping: ${lhs}`);
        continue;
      }
      let commandId: string | undefined;
      if (rhs.startsWith(":")) {
        let name = rhs.slice(1).replace(/<CR>$/i, "").replace(/\r$/, "").trim();
        if (name.endsWith("!") && !EX_ALIASES[name]) name = name.slice(0, -1);
        const mapped = EX_ALIASES[name];
        if (mapped) {
          commandId = mapped;
        } else {
          // Allow mapping directly to a bnote command id.
          commandId = name;
        }
      }
      mappings.push({
        lhs,
        rhs,
        mode: modeOf(cmd),
        noremap: cmd.includes("nore"),
        commandId,
      });
      continue;
    }

    errors.push(`unsupported vimrc command: ${cmd}`);
  }

  return { mappings, errors, clipboardUnnamed };
}
