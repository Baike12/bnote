import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webAnnotationRuntime } from "./webAnnotationRuntime";
import { locateQuote, normalizeWebAnnotations, textPointAt } from "./webAnnotations";
import { mergeLineRects } from "./pdfAnnotations";
import { normalizePageStep, snapScrollTopToLine } from "./reading";
import { eventKeyName, parseBinding } from "@/commands/keys";

/**
 * The interaction half of the injected web runtime: page turning, host-key
 * forwarding, selection -> annotation, highlight removal, and the translation
 * card. The store/mode half lives in `webAnnotationRuntime.integration.test.ts`.
 *
 * The runtime adds window listeners once (the page loads it once), so this
 * file records them and removes them after every test: a stale instance from a
 * previous test would otherwise compound a page turn or answer a selection.
 *
 * jsdom has no layout: `Range.getClientRects` is the one seam stubbed here, and
 * it is stubbed with the box a real browser reports for a text node. Nothing
 * else is faked — the selection, the shadow roots, the localStorage copies and
 * the title channel are the real ones.
 */

interface AnnoApi {
  setMode: (value: unknown) => void;
  setTranslate: (value: unknown) => void;
  showTranslation: (...args: unknown[]) => void;
  merge: (payload: unknown) => void;
  export: () => { url: string; annotations: unknown[] };
  refresh: () => void;
  page: (delta: number) => boolean;
  setStep: (value: unknown) => void;
  setKeys: (prev: unknown, next: unknown) => void;
  setHostKeys: (value: unknown) => void;
}

interface ListenerRecord {
  type: string;
  handler: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
}

const listeners: ListenerRecord[] = [];
const nativeAddEventListener = window.addEventListener;

/** Start one runtime instance and remember the listeners it registers. */
function start(): AnnoApi {
  delete (window as unknown as { __bnoteAnno?: AnnoApi }).__bnoteAnno;
  delete (window as unknown as { __bnoteReader?: unknown }).__bnoteReader;
  webAnnotationRuntime({
    locateQuote,
    textPointAt,
    mergeLineRects,
    normalizeWebAnnotations,
    normalizePageStep,
    snapScrollTopToLine,
    parseBinding,
    eventKeyName,
  });
  const api = (window as unknown as { __bnoteAnno?: AnnoApi }).__bnoteAnno;
  if (!api) throw new Error("runtime did not expose __bnoteAnno");
  return api;
}

function disposeListeners(): void {
  for (const record of listeners) {
    window.removeEventListener(record.type, record.handler, record.options);
  }
  listeners.length = 0;
  window.addEventListener = nativeAddEventListener;
}

const originalGetClientRects = Range.prototype.getClientRects;

/**
 * The geometry a browser reports for a text range: one line box per 40
 * characters, starting at the origin. Only non-empty so the runtime keeps the
 * node in its text stream and hit boxes.
 */
function stubRangeGeometry(): void {
  Range.prototype.getClientRects = function stubbed(this: Range): DOMRectList {
    const text = this.toString();
    const rects: DOMRect[] = [];
    const perLine = 40;
    for (let start = 0; start < Math.max(1, text.length); start += perLine) {
      const width = Math.min(perLine, text.length - start) * 7 || 1;
      rects.push({
        left: 0,
        top: 0,
        width,
        height: 16,
        right: width,
        bottom: 16,
        x: 0,
        y: 0,
        toJSON() {},
      } as DOMRect);
    }
    return Object.assign(rects, {
      item: (index: number) => rects[index] ?? null,
    }) as unknown as DOMRectList;
  };
}

/** Make the document scrollable: jsdom reports 0 for both heights by default. */
function makeScrollable(scrollHeight = 3000, clientHeight = 800): void {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
}

function selectText(node: Text, start: number, end: number): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  if (!selection) throw new Error("no selection");
  selection.removeAllRanges();
  selection.addRange(range);
}

/** The payload the app's Rust listener parses out of the title channel. */
function titlePayload(prefix: string): unknown {
  expect(document.title.startsWith(prefix)).toBe(true);
  return JSON.parse(document.title.slice(prefix.length));
}

beforeEach(() => {
  window.addEventListener = function recording(
    this: Window,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    listeners.push({ type, handler, options });
    nativeAddEventListener.call(this, type, handler, options);
  } as typeof window.addEventListener;

  delete (window as unknown as { __bnoteAnno?: AnnoApi }).__bnoteAnno;
  delete (window as unknown as { __bnoteReader?: unknown }).__bnoteReader;
  for (const id of ["bnote-web-anno-host", "bnote-read-shade-host", "bnote-web-translate-host"]) {
    document.querySelectorAll(`#${id}`).forEach((el) => el.remove());
  }
  document.body.replaceChildren();
  document.title = "";
  localStorage.clear();
  stubRangeGeometry();
  makeScrollable();
  document.documentElement.scrollTop = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  Range.prototype.getClientRects = originalGetClientRects;
  disposeListeners();
});

describe("turning pages by step", () => {
  it("a step moves by the visible height times the step, clamped at both ends", () => {
    const api = start();
    // innerHeight 768, step 0.5 -> 384px per turn; content 3000, viewport 800 -> max 2200.
    api.page(1);
    expect(document.documentElement.scrollTop).toBe(384);
    api.page(1);
    expect(document.documentElement.scrollTop).toBe(768);
    api.page(-1);
    expect(document.documentElement.scrollTop).toBe(384);
    api.page(-1);
    api.page(-1);
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it("a turn at the last page stops there instead of running past the content", () => {
    const api = start();
    document.documentElement.scrollTop = 2200;

    api.page(1);

    expect(document.documentElement.scrollTop).toBe(2200);
  });

  it("the pushed-in step controls the distance", () => {
    const api = start();
    api.setStep(0.25);

    api.page(1);

    expect(document.documentElement.scrollTop).toBe(192);
  });

  it("a zero delta is not a page turn", () => {
    const api = start();
    expect(api.page(0)).toBe(false);
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it("without a scrollable document it declines the turn (the page keeps its own scrolling)", () => {
    makeScrollable(0, 800);
    const api = start();

    expect(api.page(1)).toBe(false);
  });

  it("the reader entry point is exposed separately from annotation mode", () => {
    start();
    const reader = (window as unknown as { __bnoteReader?: { page: (d: number) => boolean } })
      .__bnoteReader;
    expect(typeof reader?.page).toBe("function");
    expect(reader?.page(1)).toBe(true);
    expect(document.documentElement.scrollTop).toBe(384);
  });
});

describe("keyboard handling inside the page", () => {
  it("PageDown/PageUp turn the page even when the user unbound them", () => {
    start();

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }),
    );
    expect(document.documentElement.scrollTop).toBe(384);

    document.body.dispatchEvent(
      new KeyboardEvent("keyup", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    expect(document.documentElement.scrollTop).toBe(384); // keyup is not handled
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }),
    );
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it("a key event that is already handled by the page is left alone", () => {
    start();
    const event = new KeyboardEvent("keydown", {
      key: "PageDown",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();

    document.body.dispatchEvent(event);

    expect(document.documentElement.scrollTop).toBe(0);
  });

  it("a modified PageDown is not a plain page turn", () => {
    start();

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "PageDown",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(document.documentElement.scrollTop).toBe(0);
  });

  it("configured keys turn the page, and the page consumes the event", () => {
    const api = start();
    api.setKeys(["k"], ["j"]);

    const down = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
    document.body.dispatchEvent(down);
    expect(document.documentElement.scrollTop).toBe(384);
    expect(down.defaultPrevented).toBe(true);

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true }),
    );
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it("a page-turn key pressed inside a text field belongs to the field", () => {
    const api = start();
    api.setKeys(["k"], ["j"]);
    const input = document.createElement("input");
    document.body.appendChild(input);

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }),
    );

    expect(document.documentElement.scrollTop).toBe(0);
  });

  it("a host shortcut is forwarded to the main window through the title channel", () => {
    const api = start();
    api.setHostKeys(["Mod-p"]);

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true }),
    );

    // jsdom reports a non-Apple platform, so Mod maps to Ctrl here.
    expect(titlePayload("bnote-key:")).toEqual({ key: "Mod-p", n: 1 });

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(titlePayload("bnote-key:")).toEqual({ key: "Mod-p", n: 2 });
  });

  it("host keys are not forwarded out of a text field", () => {
    const api = start();
    api.setHostKeys(["Mod-p"]);
    const input = document.createElement("input");
    document.body.appendChild(input);

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true }),
    );

    expect(document.title).toBe("");
  });
});

describe("creating a highlight from a selection", () => {
  it("turns the selected text into an annotation, stores it and reports it", () => {
    const api = start();
    api.setMode("highlight");
    const paragraph = document.createElement("p");
    const text = document.createTextNode("The quick brown fox jumps over the lazy dog.");
    paragraph.appendChild(text);
    document.body.appendChild(paragraph);

    selectText(text, 4, 9);
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.runAllTimers();

    const exported = api.export();
    expect(exported.annotations).toHaveLength(1);
    expect(exported.annotations[0]).toMatchObject({
      quote: "quick",
      offset: 4,
      kind: "highlight",
      text: "",
    });
    // The page keeps an immediate copy for a reload ...
    const stored = localStorage.getItem(`bnote:web-annotations:v1:${location.href}`);
    expect(JSON.parse(stored ?? "[]")).toHaveLength(1);
    // ... and the title channel hands the same list to the main window.
    const payload = titlePayload("bnote-anno:") as { annotations: { quote: string }[] };
    expect(payload.annotations.map((a) => a.quote)).toEqual(["quick"]);
  });

  it("surrounding context is stored with the quote so a restart can relocate it", () => {
    const api = start();
    api.setMode("highlight");
    const paragraph = document.createElement("p");
    const text = document.createTextNode("0123456789 the quoted sentence 9876543210");
    paragraph.appendChild(text);
    document.body.appendChild(paragraph);

    selectText(text, 11, 30);
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.runAllTimers();

    const annotation = api.export().annotations[0] as {
      quote: string;
      prefix: string;
      suffix: string;
    };
    expect(annotation.quote).toBe("the quoted sentence");
    // 40 characters of context are kept on each side where available.
    expect(annotation.prefix).toBe("0123456789 ");
    expect(annotation.suffix).toBe(" 9876543210");
  });

  it("a repeated mouseup on the same selection does not stack a second annotation", () => {
    const api = start();
    api.setMode("highlight");
    const paragraph = document.createElement("p");
    const text = document.createTextNode("repeat this phrase twice");
    paragraph.appendChild(text);
    document.body.appendChild(paragraph);

    selectText(text, 0, 6);
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.runAllTimers();
    selectText(text, 0, 6);
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.runAllTimers();

    expect(api.export().annotations).toHaveLength(1);
  });

  it("switching an existing highlight to the note tool upgrades it in place", () => {
    const api = start();
    api.setMode("highlight");
    const paragraph = document.createElement("p");
    const text = document.createTextNode("upgrade this highlight");
    paragraph.appendChild(text);
    document.body.appendChild(paragraph);
    selectText(text, 0, 7);
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.runAllTimers();

    api.setMode("note");
    selectText(text, 0, 7);
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.runAllTimers();

    const annotations = api.export().annotations as { kind: string }[];
    expect(annotations).toHaveLength(1);
    expect(annotations[0].kind).toBe("note");
  });

  it("with no annotation mode a selection creates nothing", () => {
    const api = start();
    const paragraph = document.createElement("p");
    const text = document.createTextNode("plain reading");
    paragraph.appendChild(text);
    document.body.appendChild(paragraph);

    selectText(text, 0, 5);
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.runAllTimers();

    expect(api.export().annotations).toEqual([]);
    expect(document.title).toBe("");
  });

  it("a selection of only whitespace is not an annotation", () => {
    const api = start();
    api.setMode("highlight");
    const paragraph = document.createElement("p");
    const text = document.createTextNode("alpha    beta");
    paragraph.appendChild(text);
    document.body.appendChild(paragraph);

    selectText(text, 5, 9);
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.runAllTimers();

    expect(api.export().annotations).toEqual([]);
  });
});

describe("removing a highlight", () => {
  it("the highlight tool removes a highlight it is clicked on, in the page and on disk", () => {
    const api = start();
    api.setMode("highlight");
    const paragraph = document.createElement("p");
    const text = document.createTextNode("click to remove me");
    paragraph.appendChild(text);
    document.body.appendChild(paragraph);
    selectText(text, 0, 5);
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.runAllTimers();
    expect(api.export().annotations).toHaveLength(1);

    // A click without a selection lands on the highlight's hit box.
    window.getSelection()?.removeAllRanges();
    document.body.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    vi.runAllTimers();

    expect(api.export().annotations).toEqual([]);
    expect(localStorage.getItem(`bnote:web-annotations:v1:${location.href}`)).toBeNull();
    const payload = titlePayload("bnote-anno:") as { annotations: unknown[] };
    expect(payload.annotations).toEqual([]);
  });

  it("the highlight tool does not delete a text annotation", () => {
    const api = start();
    api.setMode("note");
    const paragraph = document.createElement("p");
    const text = document.createTextNode("a note stays put");
    paragraph.appendChild(text);
    document.body.appendChild(paragraph);
    selectText(text, 0, 6);
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    vi.runAllTimers();

    api.setMode("highlight");
    window.getSelection()?.removeAllRanges();
    document.body.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    vi.runAllTimers();

    const annotations = api.export().annotations as { kind: string }[];
    expect(annotations).toHaveLength(1);
    expect(annotations[0].kind).toBe("note");
  });
});

describe("selection translation", () => {
  /** Select a phrase and fire the mouseup the runtime listens for. */
  function selectAndRelease(text: Text, start: number, end: number): void {
    selectText(text, start, end);
    document.body.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, clientX: 30, clientY: 40 }),
    );
    vi.runAllTimers();
  }

  function withParagraph(content: string): Text {
    const paragraph = document.createElement("p");
    const text = document.createTextNode(content);
    paragraph.appendChild(text);
    document.body.appendChild(paragraph);
    return text;
  }

  it("sends the selected text and the mouse position, and never an API key", () => {
    const api = start();
    api.setTranslate(true);
    const text = withParagraph("the selected phrase");

    selectAndRelease(text, 4, 19);

    const payload = titlePayload("bnote-translate:") as {
      id: number;
      doc: string;
      text: string;
      x: number;
      y: number;
    };
    expect(payload).toMatchObject({ text: "selected phrase", x: 30, y: 40 });
    expect(payload.id).toBeGreaterThan(0);
    expect(payload.doc).toMatch(/.+/);
  });

  it("with the master switch off nothing is requested", () => {
    const api = start();
    api.setTranslate(false);
    const text = withParagraph("never translated");

    selectAndRelease(text, 0, 5);

    expect(document.title).toBe("");
  });

  it("a word result renders the dictionary card with phonetic and every sense", () => {
    const api = start();
    api.setTranslate(true);
    const text = withParagraph("word");
    selectAndRelease(text, 0, 4);
    const { id, doc } = titlePayload("bnote-translate:") as { id: number; doc: string };

    api.showTranslation(id, doc, {
      kind: "word",
      entry: { word: "word", phonetic: " wɜːd ", translation: "n. 单词\nn. 话语" },
    });

    const host = document.getElementById("bnote-web-translate-host");
    const card = host?.shadowRoot?.firstElementChild as HTMLElement | null;
    expect(card?.textContent).toContain("word");
    expect(card?.textContent).toContain("/wɜːd/");
    expect(card?.textContent).toContain("n. 单词");
    expect(card?.textContent).toContain("n. 话语");
    expect(card?.textContent).toContain("内置词典");
  });

  it("a dictionary miss explains that two or more words call the model", () => {
    const api = start();
    api.setTranslate(true);
    const text = withParagraph("peculiar");
    selectAndRelease(text, 0, 8);
    const { id, doc } = titlePayload("bnote-translate:") as { id: number; doc: string };

    api.showTranslation(id, doc, { kind: "miss", word: "peculiar" });

    const card = document.getElementById("bnote-web-translate-host")?.shadowRoot
      ?.firstElementChild as HTMLElement | null;
    expect(card?.textContent).toContain("内置词典未收录这个词");
    expect(card?.textContent).toContain("选中两个及以上单词可调用模型翻译");
  });

  it("a sentence result renders the model translation", () => {
    const api = start();
    api.setTranslate(true);
    const text = withParagraph("two words");
    selectAndRelease(text, 0, 9);
    const { id, doc } = titlePayload("bnote-translate:") as { id: number; doc: string };

    api.showTranslation(id, doc, { kind: "sentence", translation: "两个词" });

    const card = document.getElementById("bnote-web-translate-host")?.shadowRoot
      ?.firstElementChild as HTMLElement | null;
    expect(card?.textContent).toContain("两个词");
    expect(card?.textContent).toContain("模型翻译");
  });

  it("an error result shows the message the backend sent", () => {
    const api = start();
    api.setTranslate(true);
    const text = withParagraph("three words");
    selectAndRelease(text, 0, 11);
    const { id, doc } = titlePayload("bnote-translate:") as { id: number; doc: string };

    api.showTranslation(id, doc, { kind: "error", message: "网络不可用" });

    const card = document.getElementById("bnote-web-translate-host")?.shadowRoot
      ?.firstElementChild as HTMLElement | null;
    expect(card?.textContent).toContain("翻译失败");
    expect(card?.textContent).toContain("网络不可用");
  });

  it("a stale result, a foreign document and a result after switching off are all dropped", () => {
    const api = start();
    api.setTranslate(true);
    const text = withParagraph("stale result check");
    selectAndRelease(text, 0, 6);
    const { id, doc } = titlePayload("bnote-translate:") as { id: number; doc: string };

    api.showTranslation(id + 1, doc, { kind: "sentence", translation: "过期的结果" });
    api.showTranslation(id, "another-document", { kind: "sentence", translation: "别的页面" });
    api.setTranslate(false);
    api.showTranslation(id, doc, { kind: "sentence", translation: "已经关闭" });

    const card = document.getElementById("bnote-web-translate-host")?.shadowRoot
      ?.firstElementChild as HTMLElement | null;
    expect(card).toBeNull();
  });

  it("switching the master switch off closes a card that is already open", () => {
    const api = start();
    api.setTranslate(true);
    const text = withParagraph("closing card");
    selectAndRelease(text, 0, 7);
    const { id, doc } = titlePayload("bnote-translate:") as { id: number; doc: string };
    api.showTranslation(id, doc, { kind: "sentence", translation: "卡片" });
    expect(
      document.getElementById("bnote-web-translate-host")?.shadowRoot?.firstElementChild,
    ).not.toBeNull();

    api.setTranslate(false);

    expect(
      document.getElementById("bnote-web-translate-host")?.shadowRoot?.firstElementChild,
    ).toBeNull();
  });

  it("an over-long selection is refused locally without sending a request", () => {
    const api = start();
    api.setTranslate(true);
    const text = withParagraph("x".repeat(4001));

    selectAndRelease(text, 0, 4001);

    expect(document.title).not.toContain("bnote-translate:");
    const card = document.getElementById("bnote-web-translate-host")?.shadowRoot
      ?.firstElementChild as HTMLElement | null;
    expect(card?.textContent).toContain("选中内容过长");
    expect(card?.textContent).toContain("4000");
  });

  it("annotation mode wins over translation: a selection in annotation mode never requests a translation", () => {
    const api = start();
    api.setTranslate(true);
    api.setMode("highlight");
    const text = withParagraph("annotation wins here");

    selectAndRelease(text, 0, 10);

    expect(document.title).not.toContain("bnote-translate:");
    expect(api.export().annotations).toHaveLength(1);
  });
});
