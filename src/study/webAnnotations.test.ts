import { describe, expect, it } from "vitest";
import {
  buildWebAnnotationScript,
  locateQuote,
  mergeUrlAnnotations,
  normalizeWebAnnotations,
  parseWebAnnotationFile,
  parseWebAnnotations,
  textPointAt,
  webAnnotationFileName,
  legacyWebAnnotationRelPath,
  webAnnotationMaterialPath,
  type WebAnnotation,
} from "./webAnnotations";
import { normalizePageStep, snapScrollTopToLine } from "./reading";
import { eventKeyName } from "@/commands/keys";

function ann(
  id: string,
  quote: string,
  offset: number,
  extra: Partial<WebAnnotation> = {},
): WebAnnotation {
  return {
    id,
    quote,
    prefix: "",
    suffix: "",
    offset,
    kind: "highlight",
    text: "",
    createdAt: 1,
    ...extra,
  };
}

describe("the web annotation anchor", () => {
  it("a candidate whose prefix and suffix match is preferred over the first occurrence", () => {
    const text = "记忆系统很重要。另起一段,这里说的记忆系统是用户记忆系统。";
    const quote = "记忆系统";
    const offset = text.lastIndexOf("记忆系统");
    const prefix = text.slice(offset - 8, offset);
    const suffix = text.slice(offset + quote.length, offset + quote.length + 6);
    expect(locateQuote(text, quote, 0, prefix, suffix)).toBe(offset);
  });

  it("when the context is the same or missing, the one nearest to the original offset is taken", () => {
    const text = "同一句话 中间隔开 同一句话";
    const second = text.lastIndexOf("同一句话");
    expect(locateQuote(text, "同一句话", second, "", "")).toBe(second);
    expect(locateQuote(text, "同一句话", 0, "", "")).toBe(0);
  });

  it("when the text changed and it is not found it returns -1 (the annotation is not lost, it is just not drawn this round)", () => {
    expect(locateQuote("改革后的新正文", "记忆系统", 0, "", "")).toBe(-1);
    expect(locateQuote("anything", "", 0, "", "")).toBe(-1);
  });
});

describe("web annotations: offset → DOM point", () => {
  const a = { node: "A", start: 0, end: 6 }; // the last text node of the previous run
  const b = { node: "B", start: 6, end: 45 }; // the first text node of the next run (a blank-line block sits in between)
  const entries = [a, b];

  it("at a boundary offset: the start belongs to the beginning of the next run, the end to the end of the previous run", () => {
    // The global offset of the first character of the line is exactly 6: taking the end of A on both sides would make the Range span
    // the blank-line block in between, and WebKit returns a full-width rect for the whole blank line.
    expect(textPointAt(entries, 6, "start")).toEqual({ node: "B", offset: 0 });
    expect(textPointAt(entries, 6, "end")).toEqual({ node: "A", offset: 6 });
  });

  it("an offset inside a run lands as is in the node it belongs to", () => {
    expect(textPointAt(entries, 2, "start")).toEqual({ node: "A", offset: 2 });
    expect(textPointAt(entries, 2, "end")).toEqual({ node: "A", offset: 2 });
    expect(textPointAt(entries, 10, "start")).toEqual({ node: "B", offset: 4 });
    expect(textPointAt(entries, 10, "end")).toEqual({ node: "B", offset: 4 });
  });

  it("at the end of the text: the start falls back to the end of the last run", () => {
    expect(textPointAt(entries, 45, "start")).toEqual({ node: "B", offset: 39 });
    expect(textPointAt(entries, 45, "end")).toEqual({ node: "B", offset: 39 });
    expect(textPointAt([], 0, "start")).toBeNull();
  });
});

describe("web annotation data", () => {
  it("the fields sent by the page are validated, deduplicated by id and over-long quotes are trimmed", () => {
    const out = normalizeWebAnnotations([
      ann("a", "x", 3),
      ann("a", "重复", 4),
      { id: "b", quote: "q".repeat(5000), offset: 1 },
      { id: "c", quote: "", offset: 1 },
      { id: "d", quote: "x", offset: -1 },
      "nope",
    ]);
    expect(out.map((a) => a.id)).toEqual(["a", "b"]);
    expect(out[1].quote.length).toBe(2000);
    // Old data has no kind/text: it is read as a highlight with empty text.
    expect(out[0].kind).toBe("highlight");
    expect(out[0].text).toBe("");
  });

  it("the kind/text of a text annotation is kept as is, over-long text is trimmed", () => {
    const out = normalizeWebAnnotations([
      ann("n", "q", 0, { kind: "note", text: "这是一条批注" }),
      { id: "long", quote: "q", offset: 0, kind: "note", text: "字".repeat(3000) },
      { id: "bad", quote: "q", offset: 0, kind: "weird", text: 42 },
    ]);
    expect(out[0]).toMatchObject({ kind: "note", text: "这是一条批注" });
    expect(out[1].text.length).toBe(2000);
    // An unknown kind falls back to a highlight, a non-string text becomes empty.
    expect(out[2]).toMatchObject({ kind: "highlight", text: "" });
  });

  it("one file per URL: the same URL is stable, different URLs stay apart", () => {
    const a = "https://example.com/a?x=1";
    const b = "https://example.com/b?x=1";
    expect(webAnnotationFileName(a)).toBe(webAnnotationFileName(a));
    expect(webAnnotationFileName(a)).not.toBe(webAnnotationFileName(b));
    expect(webAnnotationFileName(a)).toMatch(/^example\.com-[a-z0-9]+\.json$/);
    expect(legacyWebAnnotationRelPath(a)).toMatch(/^web-annotations\/example\.com-/);
    expect(webAnnotationMaterialPath("/vault", "materials/webpages/x_com_201075")).toBe(
      "/vault/.bnote/materials/webpages/x_com_201075/annotations.json",
    );
    expect(webAnnotationFileName("not a url")).toMatch(/^page-[a-z0-9]+\.json$/);
  });

  it("a bad file falls back to an empty library; the URL and the annotations in the file are validated field by field", () => {
    expect(parseWebAnnotationFile("{oops")).toEqual({
      version: 1,
      url: "",
      annotations: [],
    });
    const file = parseWebAnnotationFile(
      JSON.stringify({
        version: 1,
        url: "https://a",
        annotations: [ann("1", "q", 0), { id: "bad" }],
      }),
    );
    expect(file.url).toBe("https://a");
    expect(file.annotations.map((a) => a.id)).toEqual(["1"]);
    expect(parseWebAnnotations(JSON.stringify({ annotations: [ann("2", "x", 1)] }))).toHaveLength(
      1,
    );
  });

  it("the merge takes the union by id, the ones from the page override the ones from the vault", () => {
    const merged = mergeUrlAnnotations(
      [ann("a", "old", 0), ann("b", "keep", 1)],
      [ann("a", "new", 0), ann("c", "add", 2)],
    );
    expect(merged.map((a) => `${a.id}:${a.quote}`)).toEqual(["a:new", "b:keep", "c:add"]);
  });
});

describe("the injected script", () => {
  it("it compiles and carries every runtime entry point", () => {
    const script = buildWebAnnotationScript();
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("__bnoteAnno");
    expect(script).toContain("bnote-anno:");
    expect(script).toContain("setMode");
    expect(script).toContain("merge");
    // Selection translation: the master switch / the result fill-in / the request channel all have to be in the injected runtime.
    expect(script).toContain("setTranslate");
    expect(script).toContain("showTranslation");
    expect(script).toContain("bnote-translate:");
    expect(script).toContain("doc: TRANSLATE_DOC");
    expect(script).toContain("bnote-web-translate-host");
    // The page-turn entry point and the channels the main window pushes the step and the keys through.
    expect(script).toContain("__bnoteReader");
    expect(script).toContain("setStep");
    expect(script).toContain("setKeys");
    expect(script).toContain("bnote-read-shade-host");
    expect(script).toContain("snapScrollTopToLine");
    // The in-page key matching shares the main window's modifier normalization (⌘⌥A is "å" on macOS).
    expect(script).toContain("eventKeyName");
    // Text annotations (the in-page annotation card) and the reading position.
    expect(script).toContain("bnote:web-position:v1:");
    expect(script).toContain("scheduleRestore");
    // Cursor: a fixed pen shape over the whole page, but the pen is substituted by the native layer (in WKWebView an image cursor is
    // rebuilt and reset on every mouse move, so the pointer flickers). The CSS only keeps a native keyword.
    expect(script).toContain("installCursorSheet");
    expect(script).toContain("cursor: crosshair !important");
    expect(script).toContain("cursor: inherit !important");
    expect(script).not.toContain("cursorPen");
    expect(script).not.toContain("bnote-annotating");
    // The reading split (only a dimming, no dividing line) is always there: it exists as soon as the page is opened, it is not triggered by a page turn.
    // The boundary ends with the shade fading out, and both ends keep the rounded tip added by the radial gradient (without a line that is the only shape).
    expect(script).toContain("paintShade");
    expect(script).not.toContain("shadeVisible");
    expect(script).toContain("radial-gradient(circle at 100% 100%");
    expect(script).not.toContain("borderTopLeftRadius");
    expect(script).not.toContain("230, 155, 60");
    // The pure functions are serialized into the page, so no module-level constant names may remain.
    expect(script).not.toContain("MAX_WEB_QUOTE");
  });

  it("the serialized pure functions run independently in an empty scope", () => {
    const isolatedLocate = new Function(
      `return (${locateQuote.toString()});`,
    )() as typeof locateQuote;
    expect(isolatedLocate("abc记忆系统def", "记忆系统", 0, "", "")).toBe(3);
    const isolatedNormalize = new Function(
      `return (${normalizeWebAnnotations.toString()});`,
    )() as typeof normalizeWebAnnotations;
    expect(isolatedNormalize([{ id: "a", quote: "q", offset: 0 }])).toHaveLength(1);
    const isolatedStep = new Function(
      `return (${normalizePageStep.toString()});`,
    )() as typeof normalizePageStep;
    expect(isolatedStep(undefined)).toBe(0.5);
    const isolatedSnap = new Function(
      `return (${snapScrollTopToLine.toString()});`,
    )() as typeof snapScrollTopToLine;
    expect(isolatedSnap(350, 700, 5000, 350, [{ top: 335, bottom: 357 }], 14)).toBe(357);
    const isolatedKey = new Function(
      `return (${eventKeyName.toString()});`,
    )() as typeof eventKeyName;
    expect(isolatedKey({ key: "å", code: "KeyA", shiftKey: false, altKey: true })).toBe("a");
  });
});
