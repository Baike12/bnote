import { describe, expect, it } from "vitest";
import {
  isWereadReaderUrl,
  isWereadUrl,
  normalizeWereadRoute,
  wereadFallbackTitle,
  WEREAD_SCRIPT,
  WEREAD_TITLE_PREFIX,
} from "./weread";

describe("WeRead URL classification", () => {
  it("the site match judges the hostname exactly", () => {
    expect(isWereadUrl("https://weread.qq.com/")).toBe(true);
    expect(isWereadUrl("https://weread.qq.com/web/reader/abc#wechat_redirect")).toBe(true);
    expect(isWereadUrl("https://www.weread.qq.com/")).toBe(true);
    // A look-alike domain is not WeRead
    expect(isWereadUrl("https://weread.qq.com.evil.com/")).toBe(false);
    expect(isWereadUrl("https://weread.qq.com.cn/")).toBe(false);
    expect(isWereadUrl("https://example.com/")).toBe(false);
    expect(isWereadUrl("")).toBe(false);
    expect(isWereadUrl("not a url")).toBe(false);
  });

  it("only the /web/reader/ route counts as reading", () => {
    expect(isWereadReaderUrl("https://weread.qq.com/web/reader/ce032b305a9bc1ce0b0dd29")).toBe(
      true,
    );
    // The query does not affect the route decision
    expect(isWereadReaderUrl("https://weread.qq.com/web/reader/abc?kw=三体")).toBe(true);
    // The shelf / the store / the detail page do not count
    expect(isWereadReaderUrl("https://weread.qq.com/")).toBe(false);
    expect(isWereadReaderUrl("https://weread.qq.com/#shelf")).toBe(false);
    expect(isWereadReaderUrl("https://weread.qq.com/web/bookDetail/abc")).toBe(false);
    // The same path on another site does not count either
    expect(isWereadReaderUrl("https://example.com/web/reader/abc")).toBe(false);
  });

  it("fallback title: the reader route carries the hash segment, everything else is 「微信读书」", () => {
    expect(wereadFallbackTitle("https://weread.qq.com/web/reader/ce032b305a9bc1ce")).toBe(
      "微信读书 ce032b305a9b",
    );
    expect(wereadFallbackTitle("https://weread.qq.com/")).toBe("微信读书");
    expect(wereadFallbackTitle("::::")).toBe("微信读书");
  });
});

describe("normalizeWereadRoute(title channel payload)", () => {
  it("a valid payload passes through unchanged", () => {
    expect(
      normalizeWereadRoute({ url: "https://weread.qq.com/web/reader/abc", title: "三体" }),
    ).toEqual({ url: "https://weread.qq.com/web/reader/abc", title: "三体" });
    // The title may be empty (at the first report the title has not been extracted yet)
    expect(
      normalizeWereadRoute({ url: "https://weread.qq.com/web/reader/abc", title: "" }),
    ).toEqual({ url: "https://weread.qq.com/web/reader/abc", title: "" });
  });

  it("every non-reader route is rejected (the shelf / the store / other sites do not enter the history)", () => {
    expect(normalizeWereadRoute({ url: "https://weread.qq.com/", title: "微信读书" })).toBeNull();
    expect(normalizeWereadRoute({ url: "https://example.com/x", title: "x" })).toBeNull();
  });

  it("a missing field / a wrong type / a non-object returns null", () => {
    expect(normalizeWereadRoute(null)).toBeNull();
    expect(normalizeWereadRoute("junk")).toBeNull();
    expect(normalizeWereadRoute({})).toBeNull();
    expect(normalizeWereadRoute({ url: 1, title: "x" })).toBeNull();
    expect(normalizeWereadRoute({ url: "https://weread.qq.com/web/reader/abc" })).toBeNull();
  });
});

describe("the injected script", () => {
  it("it contains the route gate, the title prefix and the book title selector (serialization loses no key content)", () => {
    expect(WEREAD_SCRIPT).toContain("weread.qq.com");
    expect(WEREAD_SCRIPT).toContain(WEREAD_TITLE_PREFIX);
    expect(WEREAD_SCRIPT).toContain("/web/reader/");
    // WeRead's real class names are underscore-style (confirmed on the live site in 2026-10); the camel-case
    // readerTopBarTitleLink does not exist, it was the title extraction bug of the first version.
    expect(WEREAD_SCRIPT).toContain(".readerTopBar_title_link");
    expect(WEREAD_SCRIPT).not.toContain(".readerTopBarTitleLink");
  });

  it("the layout adaptation only touches colors and locks the key points measured on the live site", () => {
    // Width: the root cause of the margin in the scrolling mode is the max-width:1000px of .app_content
    expect(WEREAD_SCRIPT).toContain(".app_content { max-width: none");
    // Eye-care green = the --pdf-gutter of the PDF eye-care mode
    expect(WEREAD_SCRIPT).toContain("#dcebd6");
    // The visible glyphs are a canvas copy-protection layer: the text color has to be pressed to black with brightness(0)
    expect(WEREAD_SCRIPT).toContain(".wr_canvasContainer canvas { filter: brightness(0)");
    // The page container of the horizontal mode carries a dark background of its own
    expect(WEREAD_SCRIPT).toContain(".readerChapterContent_container { background");
    // The inner page classes set a light color directly, so the text color must be wildcarded to the descendants
    expect(WEREAD_SCRIPT).toContain(".readerChapterContent *:not(svg):not(canvas)");
    // The style injection tag (the new style id)
    expect(WEREAD_SCRIPT).toContain("bnote-weread-style");
  });

  it("the catalog and the toolbar stay under the site's control: their geometry and open state must not be taken over", () => {
    // The closed catalog is an inline display:none and the component switches it back to display:flex when opened (natively
    // position:fixed + a flex column, the list .readerCatalog_list{flex:auto} scrolls through PerfectScrollbar). A forced
    // display:block only flips visibility and bypasses the open state → the scrolling container is never initialized, so the
    // catalog cannot scroll; the mask (close on an outside click) is hidden and the toolbar is hidden too → there is not even
    // an entry to collapse it.
    expect(WEREAD_SCRIPT).not.toContain(".readerCatalog { display: block");
    expect(WEREAD_SCRIPT).not.toContain(".wr_mask:has(~ .readerCatalog)");
    // .readerContent is box-sizing:border-box: padding does not change its clientWidth, so the site paginates at the full width
    // while the drawing origin shifts right → the second page of the horizontal (two-page) mode is clipped outside the viewport.
    expect(WEREAD_SCRIPT).not.toContain("padding-left: 320px");
    // The toolbar holds the catalog / scroll reading (single column) / font size / light theme entries, and the page bar turns
    // pages in the horizontal mode — both must stay, otherwise the user has no way out.
    expect(WEREAD_SCRIPT).not.toContain(".readerControls { display: none");
    expect(WEREAD_SCRIPT).not.toContain(".renderTarget_pager { display: none");
  });

  it("it is a single immediately executed expression, the constants are passed in as arguments (no module scope is referenced)", () => {
    expect(WEREAD_SCRIPT.startsWith("(")).toBe(true);
    expect(WEREAD_SCRIPT.trimEnd().endsWith(");")).toBe(true);
    expect(
      WEREAD_SCRIPT.endsWith(
        `${JSON.stringify({
          marker: WEREAD_TITLE_PREFIX,
          readerPath: "/web/reader/",
          styleId: "bnote-weread-style",
        })});`,
      ),
    ).toBe(true);
  });

  it("the script passes JS syntax compilation (errors like a missing parenthesis in the concatenation are caught here)", () => {
    expect(() => new Function(WEREAD_SCRIPT)).not.toThrow();
  });
});
