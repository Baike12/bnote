import { describe, expect, it } from "vitest";
import { parseVimrc } from "./vimrc";

/**
 * The vimrc parser is the only path from a user's `vimrc` text to the engine
 * mappings, and it fails silently in both directions: a mapping it drops
 * changes every key the user configured, and a mapping it invents binds a key
 * the user never asked for. The rules locked here are the ones the module's
 * comments promise:
 *
 *  - `map`/`noremap` register normal AND visual, prefixes narrow that;
 *  - `:w`, `:wq`, `:q!` … resolve through the alias table, while any other
 *    `:name` (including `:Bnote <id>`) becomes a command id verbatim;
 *  - `unmap` removes the pair it names and reports a line when nothing was
 *    bound (a bare `map` registered two entries, so `unmap` must remove both
 *    before it counts as unknown);
 *  - `<leader>` is unsupported and reported instead of silently mis-bound;
 *  - `set clipboard=unnamed` (and `clipboard^=unnamed`) turn the unnamed
 *    register into the system clipboard.
 */
describe("parseVimrc: mapping commands and the modes they cover", () => {
  it("a bare map registers one entry per mode (normal + visual), vim-style", () => {
    const { mappings, errors } = parseVimrc("map <C-s> :w<CR>");
    expect(errors).toEqual([]);
    expect(mappings.map((m) => m.mode)).toEqual(["normal", "visual"]);
    expect(mappings.every((m) => m.commandId === "workspace.save-note")).toBe(true);
  });

  it("only the `nore` forms are marked non-recursive (vim's nmap is recursive)", () => {
    expect(parseVimrc("nnoremap gg :w<CR>").mappings[0].noremap).toBe(true);
    expect(parseVimrc("noremap gg :w<CR>").mappings[0].noremap).toBe(true);
    expect(parseVimrc("nmap gg :w<CR>").mappings[0].noremap).toBe(false);
    expect(parseVimrc("map gg :w<CR>").mappings[0].noremap).toBe(false);
  });

  it("the prefixed forms narrow the mode: imap insert, vmap/xmap visual, nmap normal", () => {
    expect(parseVimrc("imap jj <Esc>").mappings.map((m) => m.mode)).toEqual(["insert"]);
    expect(parseVimrc("vmap jj <Esc>").mappings.map((m) => m.mode)).toEqual(["visual"]);
    expect(parseVimrc("xmap jj <Esc>").mappings.map((m) => m.mode)).toEqual(["visual"]);
    expect(parseVimrc("nmap jj <Esc>").mappings.map((m) => m.mode)).toEqual(["normal"]);
  });

  it("a bare rhs key sequence is kept verbatim (no expansion at parse time)", () => {
    expect(parseVimrc("imap jj <Esc>").mappings[0]).toMatchObject({
      lhs: "jj",
      rhs: "<Esc>",
    });
  });

  it("a mapping without an rhs is an error and produces no entry", () => {
    const { mappings, errors } = parseVimrc("nmap kk");
    expect(mappings).toEqual([]);
    expect(errors).toEqual(["line 1: cannot parse: nmap kk"]);
  });
});

describe("parseVimrc: ex-command aliases resolve to bnote command ids", () => {
  const idOf = (rhs: string) => parseVimrc(`nmap <C-s> ${rhs}`).mappings[0]?.commandId;

  it("the write/quit aliases map to their workspace commands", () => {
    expect(idOf(":w")).toBe("workspace.save-note");
    expect(idOf(":write")).toBe("workspace.save-note");
    expect(idOf(":wq")).toBe("workspace.save-note-and-close");
    expect(idOf(":x")).toBe("workspace.save-note-and-close");
    expect(idOf(":q")).toBe("workspace.close-window");
    expect(idOf(":q!")).toBe("workspace.close-window");
    expect(idOf(":quit")).toBe("workspace.close-window");
  });

  it("the search-highlight aliases map too", () => {
    expect(idOf(":noh")).toBe("editor.clear-search-highlight");
    expect(idOf(":nohlsearch")).toBe("editor.clear-search-highlight");
  });

  it("a trailing <CR> is stripped from the command line", () => {
    expect(idOf(":w<CR>")).toBe("workspace.save-note");
    expect(idOf(":w<cr>")).toBe("workspace.save-note");
  });

  it("a `!` suffix on an unknown name is dropped; on an alias it is part of the alias", () => {
    expect(idOf(":unknown!")).toBe("unknown");
    expect(idOf(":q!")).toBe("workspace.close-window");
  });

  it("`:Bnote <id>` unwraps to the bare command id", () => {
    expect(idOf(":Bnote nav.toggle-sidebar<CR>")).toBe("nav.toggle-sidebar");
    expect(idOf(":Bnote nav.toggle-sidebar")).toBe("nav.toggle-sidebar");
  });

  it("a bare id is accepted directly", () => {
    expect(idOf(":nav.toggle-sidebar")).toBe("nav.toggle-sidebar");
  });
});

describe("parseVimrc: comments and blank lines", () => {
  it("a full-line comment is skipped", () => {
    const { mappings, errors } = parseVimrc('" this is a comment\nimap jj <Esc>');
    expect(errors).toEqual([]);
    expect(mappings.map((m) => m.lhs)).toEqual(["jj"]);
  });

  it("a trailing comment after whitespace is stripped", () => {
    expect(parseVimrc('imap jj <Esc> " back to normal').mappings[0].rhs).toBe("<Esc>");
  });

  it("blank lines and whitespace-only lines are skipped", () => {
    expect(parseVimrc("\n   \n\t\n").errors).toEqual([]);
  });

  it("the line number in an error counts comment lines too", () => {
    const { errors } = parseVimrc('" note\n\nbogus-command');
    expect(errors).toEqual(["line 3: unsupported vimrc command: bogus-command"]);
  });
});

describe("parseVimrc: unmap", () => {
  it("unmap removes both entries a bare map registered", () => {
    const { mappings, errors } = parseVimrc("map <C-s> :w<CR>\nunmap <C-s>");
    expect(errors).toEqual([]);
    expect(mappings).toEqual([]);
  });

  it("nunmap removes only the normal-mode half of a bare map", () => {
    const { mappings } = parseVimrc("map <C-s> :w<CR>\nnunmap <C-s>");
    expect(mappings.map((m) => m.mode)).toEqual(["visual"]);
  });

  it("iunmap only removes an insert mapping; the normal one survives", () => {
    const { mappings } = parseVimrc("imap jj <Esc>\nnmap jj :w<CR>\niunmap jj");
    expect(mappings.map((m) => m.mode)).toEqual(["normal"]);
  });

  it("unmapping something that was never bound is an error naming the line", () => {
    expect(parseVimrc("unmap zz").errors).toEqual(["line 1: unmap: no mapping for zz"]);
  });
});

describe("parseVimrc: unsupported input is reported, not silently dropped", () => {
  it("<leader> mappings are rejected with their own message", () => {
    expect(parseVimrc("<leader>w :w<CR>").errors).toEqual([
      "line 1: unsupported vimrc command: <leader>w",
    ]);
    const result = parseVimrc("nmap <leader>w :w<CR>");
    expect(result.mappings).toEqual([]);
    expect(result.errors).toEqual(["line 1: unsupported <leader> mapping: <leader>w"]);
  });

  it("an unknown command yields one error and keeps the valid lines", () => {
    const result = parseVimrc("nnoremap a :w<CR>\nset number\nfrobnicate x\nimap jj <Esc>");
    expect(result.errors).toEqual(["line 3: unsupported vimrc command: frobnicate"]);
    expect(result.mappings.map((m) => m.lhs)).toEqual(["a", "jj"]);
  });
});

describe("parseVimrc: set clipboard", () => {
  it("clipboard=unnamed turns the clipboard sync on", () => {
    expect(parseVimrc("set clipboard=unnamed").clipboardUnnamed).toBe(true);
  });

  it("unnamed inside a comma list is recognized", () => {
    expect(parseVimrc("set clipboard=unnamedplus,unnamed").clipboardUnnamed).toBe(true);
  });

  it("clipboard^=unnamed (the append form vim accepts) is recognized too", () => {
    expect(parseVimrc("set clipboard^=unnamed").clipboardUnnamed).toBe(true);
  });

  it("a value that merely contains the word does not count", () => {
    expect(parseVimrc("set clipboard=unnamedplus").clipboardUnnamed).toBe(false);
  });

  it("`set number` and other options are accepted silently", () => {
    const result = parseVimrc("set number\nset scrolloff=3");
    expect(result.errors).toEqual([]);
    expect(result.clipboardUnnamed).toBe(false);
  });

  it("`set` with no argument is accepted silently", () => {
    expect(parseVimrc("set").errors).toEqual([]);
  });
});

describe("parseVimrc: the whole file at once", () => {
  it("a realistic vimrc produces mappings in file order, with no errors", () => {
    const source = [
      '" bnote vimrc',
      "set clipboard=unnamed",
      "imap jj <Esc>",
      "nmap <C-s> :w<CR>",
      "vmap <C-c> :Bnote edit.copy<CR>",
      "",
      "nmap gs :Bnote nav.toggle-sidebar<CR>",
    ].join("\n");
    const result = parseVimrc(source);
    expect(result.errors).toEqual([]);
    expect(result.clipboardUnnamed).toBe(true);
    expect(result.mappings.map((m) => [m.lhs, m.mode, m.commandId])).toEqual([
      ["jj", "insert", undefined],
      ["<C-s>", "normal", "workspace.save-note"],
      ["<C-c>", "visual", "edit.copy"],
      ["gs", "normal", "nav.toggle-sidebar"],
    ]);
  });

  it("an empty file yields nothing", () => {
    expect(parseVimrc("")).toEqual({ mappings: [], errors: [], clipboardUnnamed: false });
  });
});
