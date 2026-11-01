import { describe, expect, it } from "vitest";
import {
  isWereadReaderUrl,
  isWereadUrl,
  normalizeWereadRoute,
  wereadFallbackTitle,
  WEREAD_SCRIPT,
  WEREAD_TITLE_PREFIX,
} from "./weread";

describe("微信读书 URL 分类", () => {
  it("站点匹配按 hostname 精确判断", () => {
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

  it("只有 /web/reader/ 路由算「在读书」", () => {
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

  it("兜底标题:reader 路由带哈希段,其他都是「微信读书」", () => {
    expect(wereadFallbackTitle("https://weread.qq.com/web/reader/ce032b305a9bc1ce")).toBe(
      "微信读书 ce032b305a9b",
    );
    expect(wereadFallbackTitle("https://weread.qq.com/")).toBe("微信读书");
    expect(wereadFallbackTitle("::::")).toBe("微信读书");
  });
});

describe("normalizeWereadRoute(title 通道负载)", () => {
  it("合法负载原样通过", () => {
    expect(
      normalizeWereadRoute({ url: "https://weread.qq.com/web/reader/abc", title: "三体" }),
    ).toEqual({ url: "https://weread.qq.com/web/reader/abc", title: "三体" });
    // The title may be empty (at the first report the title has not been extracted yet)
    expect(
      normalizeWereadRoute({ url: "https://weread.qq.com/web/reader/abc", title: "" }),
    ).toEqual({ url: "https://weread.qq.com/web/reader/abc", title: "" });
  });

  it("非阅读器路由一律拒绝(书架/商城/外站不进历史)", () => {
    expect(normalizeWereadRoute({ url: "https://weread.qq.com/", title: "微信读书" })).toBeNull();
    expect(normalizeWereadRoute({ url: "https://example.com/x", title: "x" })).toBeNull();
  });

  it("缺字段 / 错型 / 非对象返回 null", () => {
    expect(normalizeWereadRoute(null)).toBeNull();
    expect(normalizeWereadRoute("junk")).toBeNull();
    expect(normalizeWereadRoute({})).toBeNull();
    expect(normalizeWereadRoute({ url: 1, title: "x" })).toBeNull();
    expect(normalizeWereadRoute({ url: "https://weread.qq.com/web/reader/abc" })).toBeNull();
  });
});

describe("注入脚本", () => {
  it("包含路由门控、title 前缀与书名选择器(序列化不丢关键内容)", () => {
    expect(WEREAD_SCRIPT).toContain("weread.qq.com");
    expect(WEREAD_SCRIPT).toContain(WEREAD_TITLE_PREFIX);
    expect(WEREAD_SCRIPT).toContain("/web/reader/");
    // WeRead's real class names are underscore-style (confirmed on the live site in 2026-10); the camel-case
    // readerTopBarTitleLink does not exist, it was the title extraction bug of the first version.
    expect(WEREAD_SCRIPT).toContain(".readerTopBar_title_link");
    expect(WEREAD_SCRIPT).not.toContain(".readerTopBarTitleLink");
  });

  it("排版适配锁住实站测得的三个关键点", () => {
    // Width: the root cause of the margin in the scrolling mode is the max-width:1000px of .app_content
    expect(WEREAD_SCRIPT).toContain(".app_content { max-width: none");
    // Catalog: docked left + permanent + hidden mask; only fixed can also dock at the left edge of the viewport in the horizontal mode
    // (in the horizontal mode its positioning ancestor is the position:relative body container)
    expect(WEREAD_SCRIPT).toContain(".readerCatalog { display: block");
    expect(WEREAD_SCRIPT).toContain(".wr_mask:has(~ .readerCatalog)");
    expect(WEREAD_SCRIPT).toContain(".readerCatalog { position: fixed");
    // Eye-care green = the --pdf-gutter of the PDF eye-care mode
    expect(WEREAD_SCRIPT).toContain("#dcebd6");
    // The visible glyphs are a canvas copy-protection layer: the text color has to be pressed to black with brightness(0)
    expect(WEREAD_SCRIPT).toContain(".wr_canvasContainer canvas { filter: brightness(0)");
    // The page container of the horizontal mode carries a dark background of its own
    expect(WEREAD_SCRIPT).toContain(".readerChapterContent_container { background");
    // The inner page classes set a light color directly, so the text color must be wildcarded to the descendants
    expect(WEREAD_SCRIPT).toContain(".readerChapterContent *:not(svg):not(canvas)");
    // The side switch buttons: the toolbar and the page bar are hidden entirely
    expect(WEREAD_SCRIPT).toContain(".readerControls { display: none");
    expect(WEREAD_SCRIPT).toContain(".renderTarget_pager { display: none");
    // The style injection tag (the new style id)
    expect(WEREAD_SCRIPT).toContain("bnote-weread-style");
  });

  it("是立即执行的单条表达式,常量经参数传入(不引用模块作用域)", () => {
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

  it("脚本能通过 JS 语法编译(拼接缺括号这类错误在这里拦下)", () => {
    expect(() => new Function(WEREAD_SCRIPT)).not.toThrow();
  });
});
