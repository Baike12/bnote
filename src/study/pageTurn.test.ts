import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canTurnPage,
  pageTurnTarget,
  setAgentPageTurn,
  setPdfPageTurn,
  setWebPageTurn,
  turnPage,
} from "./pageTurn";
import { useAppStore, type AppMode } from "@/state/appStore";

/**
 * The page-turn command scrolls the middle column of the three-column layout.
 * The layout's `mainColumn` is the single writer of "which column is in the
 * middle"; the reader slots only say "I can turn", so the visible column and
 * the key target cannot disagree.
 */
function mode(next: AppMode, mainColumn: "agent" | "content"): void {
  useAppStore.setState({ mode: next, mainColumn });
}

function recorder(name: string, calls: string[], allowed = () => true) {
  return {
    canFlip: allowed,
    prev: () => calls.push(`${name}-prev`),
    next: () => calls.push(`${name}-next`),
  };
}

describe("pageTurnTarget", () => {
  afterEach(() => mode("notes", "content"));

  it("study mode: the assistant column wins once it takes the middle, the content column otherwise", () => {
    mode("study", "content");
    expect(pageTurnTarget()).toBe("content");
    mode("study", "agent");
    expect(pageTurnTarget()).toBe("agent");
  });

  it("code mode: the assistant is a target when it is in the middle, the code editor never is", () => {
    mode("code", "agent");
    expect(pageTurnTarget()).toBe("agent");
    mode("code", "content");
    expect(pageTurnTarget()).toBeNull();
  });

  it("invest mode: the assistant is a target when it is in the middle, the chart never is", () => {
    mode("invest", "agent");
    expect(pageTurnTarget()).toBe("agent");
    mode("invest", "content");
    expect(pageTurnTarget()).toBeNull();
  });

  it("no three-column layout on screen: no target, whatever mainColumn remembers", () => {
    for (const next of ["notes", "projects"] as const) {
      mode(next, "agent");
      expect(pageTurnTarget()).toBeNull();
      mode(next, "content");
      expect(pageTurnTarget()).toBeNull();
    }
  });
});

describe("turning the middle column's page", () => {
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    mode("study", "content");
    useAppStore.getState().setModal(null);
    setPdfPageTurn(null);
    setWebPageTurn(null);
    setAgentPageTurn(null);
  });

  afterEach(() => mode("notes", "content"));

  it("with no reader the page cannot turn and the call has no side effect", () => {
    expect(canTurnPage()).toBe(false);
    expect(turnPage(1)).toBe(false);
    expect(turnPage(-1)).toBe(false);
  });

  it("the reader's canFlip decides whether the page turns", () => {
    let allowed = true;
    setPdfPageTurn(recorder("pdf", calls, () => allowed));

    expect(canTurnPage()).toBe(true);
    expect(turnPage(1)).toBe(true);
    expect(turnPage(-1)).toBe(true);
    expect(calls).toEqual(["pdf-next", "pdf-prev"]);

    // A selection in progress or an open dialog makes the reader refuse.
    allowed = false;
    expect(canTurnPage()).toBe(false);
    expect(turnPage(1)).toBe(false);
    expect(calls).toEqual(["pdf-next", "pdf-prev"]);
  });

  it("with no PDF the web page takes the same two commands", () => {
    setWebPageTurn(recorder("web", calls));
    expect(canTurnPage()).toBe(true);
    expect(turnPage(1)).toBe(true);
    expect(turnPage(-1)).toBe(true);
    expect(calls).toEqual(["web-next", "web-prev"]);
  });

  it("the two content slots are independent: the web cleanup does not clobber the just-mounted PDF", () => {
    setWebPageTurn(recorder("web", calls));
    setPdfPageTurn(recorder("pdf", calls));
    setWebPageTurn(null);
    expect(turnPage(1)).toBe(true);
    expect(calls).toEqual(["pdf-next"]);
  });

  it("the assistant wins once it takes the middle, and hands the key back when it leaves", () => {
    setPdfPageTurn(recorder("pdf", calls));
    setAgentPageTurn(recorder("agent", calls));

    mode("study", "agent");
    expect(turnPage(1)).toBe(true);
    expect(calls).toEqual(["agent-next"]);

    // Back to the content column: the reader is the middle column again.
    mode("study", "content");
    expect(turnPage(-1)).toBe(true);
    expect(calls).toEqual(["agent-next", "pdf-prev"]);
  });

  it("code mode scrolls the assistant in the middle and leaves the code editor's keys alone", () => {
    setAgentPageTurn(recorder("agent", calls));
    setPdfPageTurn(recorder("pdf", calls));

    mode("code", "agent");
    expect(canTurnPage()).toBe(true);
    expect(turnPage(1)).toBe(true);

    mode("code", "content");
    expect(canTurnPage()).toBe(false);
    expect(turnPage(1)).toBe(false);
    expect(calls).toEqual(["agent-next"]);
  });

  it("a parked reader does not claim the key: the layout is mounted, the reader is not on screen", () => {
    setPdfPageTurn(recorder("pdf", calls));
    mode("notes", "content");
    expect(canTurnPage()).toBe(false);
    expect(turnPage(1)).toBe(false);
    expect(calls).toEqual([]);

    mode("study", "content");
    expect(turnPage(1)).toBe(true);
    expect(calls).toEqual(["pdf-next"]);
  });

  it("unloading a reader hands its slot back", () => {
    setPdfPageTurn(recorder("pdf", calls));
    setPdfPageTurn(null);
    expect(canTurnPage()).toBe(false);
  });

  it("an open overlay stops the turn: the columns are behind it", () => {
    setPdfPageTurn(recorder("pdf", calls));
    useAppStore.getState().setModal("settings");
    expect(canTurnPage()).toBe(false);
    expect(turnPage(1)).toBe(false);
    expect(calls).toEqual([]);

    useAppStore.getState().setModal(null);
    expect(turnPage(1)).toBe(true);
    expect(calls).toEqual(["pdf-next"]);
  });
});
