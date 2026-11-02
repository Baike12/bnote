import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { autoFraction } from "./autofraction";
import { getSession, snippetsExtension, tryAutoExpand } from "./extension";

function frac(doc: string, cursor: number, visualText: string | null = null) {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) });
  return autoFraction(state, cursor, visualText);
}

describe("auto-fraction (a port of the latex-suite semantics)", () => {
  it("break character truncates: silu(x)=1/ → \\frac{1}{}", () => {
    const r = frac("$$silu(x)=1/", 12);
    expect(r).not.toBeNull();
    expect(r!.replacement.text).toBe("\\frac{1}{}");
    expect(r!.start).toBe(10); // After "="
    expect(r!.end).toBe(12); // The freshly typed `/` is replaced too.
  });

  it("a+b/ → a+\\frac{b}{} (+ is a break character)", () => {
    const r = frac("$$a+b/", 6);
    expect(r!.replacement.text).toBe("\\frac{b}{}");
    expect(r!.start).toBe(4);
  });

  it("no break character: ab/ → \\frac{ab}{}", () => {
    expect(frac("$$ab/", 5)!.replacement.text).toBe("\\frac{ab}{}");
  });

  it("}/ skips the group: the whole \\frac{a}{b} becomes the numerator", () => {
    const r = frac("$$\\frac{a}{b}/", 14);
    expect(r!.replacement.text).toBe("\\frac{\\frac{a}{b}}{}");
    expect(r!.start).toBe(2);
  });

  it("(a+b)/ strips the outer parentheses → \\frac{a+b}{}", () => {
    expect(frac("$$(a+b)/", 8)!.replacement.text).toBe("\\frac{a+b}{}");
  });

  it("the space after a greek letter command is not a boundary: \\alpha x/ → \\frac{\\alpha x}{}", () => {
    expect(frac("$$\\alpha x/", 11)!.replacement.text).toBe("\\frac{\\alpha x}{}");
  });

  it("an exponent still expands once closed: e^{xy}/ → \\frac{e^{xy}}{}", () => {
    expect(frac("$$e^{xy}/", 9)!.replacement.text).toBe("\\frac{e^{xy}}{}");
  });

  it("no expansion inside ^{…} (e^{x/} stays literal)", () => {
    expect(frac("$$e^{x/}", 7)).toBeNull();
  });

  it("no expansion inside \\pu{…}", () => {
    expect(frac("$$\\pu{x/}", 8)).toBeNull();
  });

  it("no expansion with an empty numerator ($$x + / stays literal)", () => {
    expect(frac("$$x + /", 7)).toBeNull();
  });

  it("no expansion inside \\text{…}", () => {
    expect(frac("$$\\text{a/b}$$", 10)).toBeNull();
  });

  it("no expansion outside math mode", () => {
    expect(frac("x/", 2)).toBeNull();
  });

  it("inline math expands the same way (closed with $): $a+b/$ → \\frac{b}{}", () => {
    const r = frac("$a+b/$", 5);
    expect(r!.replacement.text).toBe("\\frac{b}{}");
  });

  it("the numerator never crosses a line (a newline is a stop character)", () => {
    expect(frac("$$x\ny/", 6)!.replacement.text).toBe("\\frac{y}{}");
  });

  it("Tab is a break character: x<Tab>/ does not expand", () => {
    expect(frac("$$x\t/", 5)).toBeNull();
  });

  it("the selected text becomes the numerator (visualText path)", () => {
    const r = frac("$$/", 3, "a+b");
    expect(r!.replacement.text).toBe("\\frac{a+b}{}");
    expect(r!.start).toBe(2);
    expect(r!.end).toBe(3);
  });
});

/** tryAutoExpand is where the two input paths (inputHandler / vim listener)
 *  meet: the fake view locks the end-to-end expansion of "/" and the caret
 *  landing point ($0 = the denominator). */
function makeView(doc: string, cursor: number): EditorView {
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) });
  const view = {
    get state() {
      return state;
    },
    dispatch: (spec: Parameters<typeof state.update>[0]) => {
      state = state.update(spec).state;
    },
    focus: () => {},
  };
  return view as unknown as EditorView;
}

describe("tryAutoExpand merges with auto-fraction", () => {
  it("/ expands inside a math block and the caret lands in the denominator", () => {
    const view = makeView("$$silu(x)=1/", 12);
    expect(tryAutoExpand(view, "/", null)).toBe(true);
    expect(view.state.doc.toString()).toBe("$$silu(x)=\\frac{1}{}");
    expect(view.state.selection.main.head).toBe(19); // Between "{" and "}"
  });

  it("a / outside math mode is inserted as is, neither swallowed nor expanded", () => {
    const view = makeView("x/", 2);
    expect(tryAutoExpand(view, "/", null)).toBe(false);
    expect(view.state.doc.toString()).toBe("x/");
  });

  /** A fake view with the full snippet extension: the session field really
   *  exists, so this locks "while a session is active, `/` still expands". */
  function makeSessionView(doc: string, cursor: number): EditorView {
    let state = EditorState.create({
      doc,
      extensions: [snippetsExtension()],
      selection: EditorSelection.cursor(cursor),
    });
    const view = {
      get state() {
        return state;
      },
      dispatch: (spec: Parameters<typeof state.update>[0]) => {
        state = state.update(spec).state;
      },
      focus: () => {},
    };
    return view as unknown as EditorView;
  }

  it("typing / still expands while a bracket snippet session is active (latex-suite keystroke-level semantics)", () => {
    const view = makeSessionView("$$f(", 4);
    // The "(" auto snippet opens a session with the caret inside the bracket.
    expect(tryAutoExpand(view, "(", null)).toBe(true);
    expect(view.state.doc.toString()).toBe("$$f()");
    expect(getSession(view)).not.toBeNull();
    // Keep typing key by key (on the real typing path the session stays alive
    // across the whole line).
    for (const c of ["x", ")", "=", "1"]) {
      const at = view.state.selection.main.head;
      view.dispatch({ changes: { from: at, insert: c }, selection: { anchor: at + 1 } });
    }
    expect(getSession(view)).not.toBeNull();
    // The input path has already inserted the "/"; before the fix the session
    // suppressed it, here it must expand as usual.
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: "/" }, selection: { anchor: at + 1 } });
    expect(tryAutoExpand(view, "/", null)).toBe(true);
    expect(view.state.doc.toString()).toBe("$$f(x)=\\frac{1}{})");
  });

  // A multi-character commit (the IME pushes the whole string ending in "/")
  // and the deferred expansion after composition go through the
  // autoExpandVimListener / polling path, which needs a real EditorView
  // update listener; vitest without DOM cannot fake that — the browser
  // harness protocol covers it (docC/docD scenarios).
});
