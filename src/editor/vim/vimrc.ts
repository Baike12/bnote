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

/**
 * Modes a mapping command covers, vim-style: the bare `map`/`noremap` forms
 * apply to normal AND visual (vim also covers select and operator-pending,
 * which the engine has no equivalent of), the prefixed forms narrow it.
 * `:map!` (insert + cmdline) is not supported — use `imap`.
 */
function modesOf(cmd: string): VimMode[] {
  if (cmd === "map" || cmd === "noremap") return ["normal", "visual"];
  if (cmd.startsWith("i")) return ["insert"];
  if (cmd.startsWith("v") || cmd.startsWith("x")) return ["visual"];
  return ["normal"];
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

  for (const [index, rawLine] of source.split("\n").entries()) {
    const lineNo = index + 1;
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

    if (cmd === "unmap" || cmd === "nunmap" || cmd === "iunmap" || cmd === "vunmap" || cmd === "xunmap") {
      const lhs = parts.slice(1).join(" ");
      const modes: VimMode[] =
        cmd === "iunmap"
          ? ["insert"]
          : cmd === "vunmap" || cmd === "xunmap"
            ? ["visual"]
            : cmd === "nunmap"
              ? ["normal"]
              : ["normal", "visual"];
      let removed = false;
      for (const mode of modes) {
        const i = mappings.findIndex((m) => m.lhs === lhs && m.mode === mode);
        if (i !== -1) {
          mappings.splice(i, 1);
          removed = true;
        }
      }
      // Bare `map`/`noremap` register one entry per mode, so `unmap` must undo
      // all of them before it counts as an unknown mapping.
      if (!removed) errors.push(`line ${lineNo}: unmap: no mapping for ${lhs}`);
      continue;
    }

    if (MAP_COMMANDS.has(cmd)) {
      const rest = line.slice(cmd.length).trim();
      // lhs ends at the first whitespace that is not inside <>; vimrc lhs/rhs
      // are separated by whitespace, keys like <C-s> contain none.
      const m = /^(\S+)\s+(.+)$/.exec(rest);
      if (!m) {
        errors.push(`line ${lineNo}: cannot parse: ${line}`);
        continue;
      }
      const lhs = m[1];
      let rhs = m[2].trim();
      if (lhs.includes("<leader>")) {
        errors.push(`line ${lineNo}: unsupported <leader> mapping: ${lhs}`);
        continue;
      }
      let commandId: string | undefined;
      if (rhs.startsWith(":")) {
        let name = rhs.slice(1).replace(/<CR>$/i, "").replace(/\r$/, "").trim();
        if (name.endsWith("!") && !EX_ALIASES[name]) name = name.slice(0, -1);
        // `:Bnote <id>` is the documented form (the `:` command line runs the
        // same way); unwrap it so the runner gets a real command id. A bare id
        // is accepted directly.
        const viaBnote = /^Bnote\s+(.+)$/.exec(name);
        if (viaBnote) name = viaBnote[1];
        const mapped = EX_ALIASES[name];
        if (mapped) {
          commandId = mapped;
        } else {
          commandId = name;
        }
      }
      for (const mode of modesOf(cmd)) {
        mappings.push({
          lhs,
          rhs,
          mode,
          noremap: cmd.includes("nore"),
          commandId,
        });
      }
      continue;
    }

    errors.push(`line ${lineNo}: unsupported vimrc command: ${cmd}`);
  }

  return { mappings, errors, clipboardUnnamed };
}
