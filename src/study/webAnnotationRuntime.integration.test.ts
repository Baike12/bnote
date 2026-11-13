import { beforeEach, describe, expect, it } from "vitest";
import { webAnnotationRuntime } from "./webAnnotationRuntime";
import { locateQuote, normalizeWebAnnotations, textPointAt } from "./webAnnotations";
import { mergeLineRects } from "./pdfAnnotations";
import { normalizePageStep, snapScrollTopToLine } from "./reading";
import { eventKeyName, parseBinding } from "@/commands/keys";
import type { WebAnnotation } from "./webAnnotations";

/**
 * The web annotation runtime is a self-contained function serialized into the
 * native child webview. `webAnnotationScript.test.ts` proves the serialized
 * script is syntactically standalone; this test runs the real function in
 * jsdom and exercises the state it owns: the annotation store, deduplication,
 * the per-URL split, the 800-item cap, the page-step shade and the annotation
 * mode host.
 *
 * Geometry (range rectangles) is not reproducible in jsdom; drawing is
 * verified in the app, not here.
 */

interface AnnoApi {
  setMode: (value: unknown) => void;
  setTranslate: (value: unknown) => void;
  showTranslation: (...args: unknown[]) => void;
  merge: (payload: unknown) => void;
  export: () => { url: string; annotations: WebAnnotation[] };
  refresh: () => void;
  page: (delta: 1 | -1) => void;
  setStep: (value: unknown) => void;
  setKeys: (prev: unknown, next: unknown) => void;
  setHostKeys: (value: unknown) => void;
}

function start(): AnnoApi {
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

function annotation(id: string, quote: string, offset = 0): WebAnnotation {
  return {
    id,
    quote,
    prefix: "",
    suffix: "",
    offset,
    kind: "highlight",
    text: "",
    createdAt: 1,
  };
}

beforeEach(() => {
  delete (window as unknown as { __bnoteAnno?: AnnoApi }).__bnoteAnno;
  delete (window as unknown as { __bnoteReader?: unknown }).__bnoteReader;
  for (const id of ["bnote-web-anno-host", "bnote-read-shade-host"]) {
    document.querySelectorAll(`#${id}`).forEach((el) => el.remove());
  }
  document.body.replaceChildren();
  document.title = "";
});

describe("the in-page annotation store", () => {
  it("merges annotations, persists them and exports the current page", () => {
    const api = start();
    const a = annotation("a", "hello");
    api.merge({ url: location.href, annotations: [a] });

    expect(api.export()).toEqual({ url: location.href, annotations: [a] });
    const raw = localStorage.getItem(`bnote:web-annotations:v1:${location.href}`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual([a]);
  });

  it("deduplicates by id and never overwrites an existing annotation", () => {
    const api = start();
    api.merge({ url: location.href, annotations: [annotation("a", "first")] });
    api.merge({ url: location.href, annotations: [annotation("a", "second")] });
    expect(api.export().annotations.map((a) => a.quote)).toEqual(["first"]);
  });

  it("drops malformed entries instead of trusting the page", () => {
    const api = start();
    api.merge({
      url: location.href,
      annotations: [
        null,
        {},
        { id: "", quote: "x", offset: 0 },
        { id: "ok", quote: "x", offset: 0 },
        { id: "bad-offset", quote: "x", offset: -1 },
      ],
    });
    expect(api.export().annotations.map((a) => a.id)).toEqual(["ok"]);
  });

  it("keeps another URL's annotations in their own storage slot", () => {
    const api = start();
    api.merge({ url: "https://example.com/other", annotations: [annotation("other", "x")] });
    expect(api.export().annotations).toEqual([]);
    const raw = localStorage.getItem("bnote:web-annotations:v1:https://example.com/other");
    expect(JSON.parse(raw as string)).toHaveLength(1);
  });

  it("caps a page at 800 annotations", () => {
    const api = start();
    const many = Array.from({ length: 900 }, (_, i) => annotation(`a${i}`, `q${i}`, i));
    api.merge({ url: location.href, annotations: many });
    expect(api.export().annotations).toHaveLength(800);
  });

  it("ignores an empty merge payload without touching storage", () => {
    const api = start();
    api.merge(null);
    api.merge({ url: location.href, annotations: [] });
    expect(api.export().annotations).toEqual([]);
    expect(localStorage.getItem(`bnote:web-annotations:v1:${location.href}`)).toBeNull();
  });
});

describe("mode and page-step state", () => {
  it("mounts the annotation host on entering annotation mode and keeps it idempotent", () => {
    const api = start();
    api.setMode("highlight");
    const host = document.getElementById("bnote-web-anno-host");
    expect(host).not.toBeNull();
    api.setMode("highlight");
    expect(document.querySelectorAll("#bnote-web-anno-host")).toHaveLength(1);
    api.setMode(null);
    expect((window as unknown as { __bnoteAnno: AnnoApi }).__bnoteAnno).toBe(api);
  });

  it("normalizes the page step and paints the shade split", () => {
    const api = start();
    api.setStep(0.25);
    const host = document.getElementById("bnote-read-shade-host");
    const shade = host?.shadowRoot?.firstElementChild as HTMLElement | null;
    expect(shade?.style.height).toBe("75%");

    api.setStep(9); // clamped to the normalization range (1 = a full page)
    expect(shade?.style.height).toBe("0%");
  });

  it("accepts host/page key bindings without throwing on malformed input", () => {
    const api = start();
    expect(() => {
      api.setKeys(["PageUp"], ["PageDown"]);
      api.setKeys(null, 42);
      api.setHostKeys(["Mod-p", "", null]);
    }).not.toThrow();
  });
});
