/**
 * The dedicated adaptation of WeRead (weread.qq.com) as web content in study
 * mode.
 *
 * In the content column it is still the same `kind:"url"` path (see the
 * native sub-webview in commands/agent.rs); this file provides two things:
 *
 *  1. **Route tracking**: WeRead is an SPA, so opening a book from the
 *     shelf is just a pushState that the main window cannot see. The runtime
 *     hooks history and, once the `/web/reader/` route is entered, writes
 *     `{url, title}` into `document.title` behind the `bnote-weread:` prefix
 *     — the same title channel as the annotations' `bnote-anno:`, dispatched
 *     by Rust into a `study-weread-route` event, and the main window records
 *     "the books read recently" from it. The title is rendered
 *     asynchronously, so it is first reported with an empty title (the book
 *     enters the history right away) and the correct title is reported once
 *     it is extracted (deduplicated by url, the later correct title wins).
 *  2. **Layout adaptation** (measured rule by rule on the live WeRead site
 *     and verified by its effect, 2026-10):
 *     - Fill the width: the root cause of the margin in the scrolling mode
 *       is the `max-width:1000px` of `.app_content` plus the 100px margin of
 *       the body text; all of it is released and the body text keeps only a
 *       48px breathing margin.
 *     - Eye-care green: the same base color `#dcebd6` as the PDF eye-care
 *       mode (the `--pdf-gutter` in global.css), with dark text. All the
 *       rules hang under `body.wr_page_reader` (the class only the reader
 *       page has), so the shelf and the store are unaffected.
 *     - Body text color: the visible glyphs are a copy-protection layer
 *       drawn on a canvas in the WeRead theme color (it covers the DOM
 *       text), and the CSS text color only reaches the DOM layer; the canvas
 *       uses `brightness(0)` to press the glyphs to black (the alpha is
 *       kept), which is what gives dark text on a green background.
 *     - The catalog and the side toolbar **must stay under WeRead's own
 *       control** (the live DOM/CSS was checked): the closed catalog is an
 *       inline `style="display:none"` and the component switches it back to
 *       `display:flex` when opened (the panel is natively `position:fixed;
 *       flex-direction:column`), its list `ul.readerCatalog_list{flex:auto}`
 *       scrolls through PerfectScrollbar; the `wr_mask` overlay handles
 *       close-on-outside-click; `.readerControls{position:fixed;
 *       width:48px}` holds the catalog / notes / **scroll reading** (single
 *       column) / font size / light theme entries. Taking it over with CSS
 *       breaks three things at once: a forced `display:block` only flips
 *       visibility and bypasses the component's open state (the scrolling
 *       container is never initialized, so the catalog cannot scroll); the
 *       mask and the toolbar are hidden, which leaves no entry to collapse
 *       the catalog; and a `padding-left` on the body (`.readerContent` is
 *       `box-sizing:border-box`, so padding does not change its
 *       clientWidth) makes WeRead paginate at the full width while the
 *       drawing origin shifts right, clipping the second page of the
 *       horizontal (two-page) mode outside the viewport, with the
 *       single/two-column toggle hidden as well, so there is no way out.
 *       All three are one mistake: **taking over with CSS the geometry that
 *       belongs to the site's own state machine**.
 *     - Both the vertical and the horizontal (two-page) mode are adapted
 *       (the container and the text color each differ, see the CSS group
 *       comments). The vertical scrolling mode is still the shape that
 *       integrates best with bnote (annotations work on the scrolling
 *       semantics), and WeRead also picks the vertical mode by itself in a
 *       narrow container; **do not** try to switch the mode for the user
 *       with synthesized events — WeRead's controls filter untrusted events
 *       (verified on the live site, the whole click / PointerEvent set is
 *       ignored).
 *
 * The runtime is installed from the **general init script** (it is
 * reinstalled on every navigation, so it still works after an in-SPA book
 * switch) and self-gates on the hostname at the top: on a page that is not
 * WeRead not a single line runs.
 */

/** The WeRead site and the shelf entry. */
export const WEREAD_HOST = "weread.qq.com";
export const WEREAD_HOME_URL = `https://${WEREAD_HOST}/`;

/** The title channel prefix (Rust's agent.rs dispatches the study-weread-route event by it). */
export const WEREAD_TITLE_PREFIX = "bnote-weread:";

const READER_PATH = "/web/reader/";

export function isWereadUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === WEREAD_HOST || host === `www.${WEREAD_HOST}`;
  } catch {
    return false;
  }
}

/** Only the reader route with a book actually opened is recorded in the history; the shelf / store / detail page do not count. */
export function isWereadReaderUrl(url: string): boolean {
  if (!isWereadUrl(url)) return false;
  try {
    return new URL(url).pathname.startsWith(READER_PATH);
  } catch {
    return false;
  }
}

/** The fallback display when the title has not been extracted yet (the route prefix is dropped and a slice of the book hash is taken). */
export function wereadFallbackTitle(url: string): string {
  try {
    const tail = new URL(url).pathname.slice(READER_PATH.length).trim();
    return tail ? `微信读书 ${tail.slice(0, 12)}` : "微信读书";
  } catch {
    return "微信读书";
  }
}

export interface WereadRoutePayload {
  url: string;
  title: string;
}

/**
 * Validate the payload of the study-weread-route event. Rust only does
 * "prefix match + JSON parse"; the shape of the fields is checked here: bad
 * data always yields null, and junk never reaches the history.
 */
export function normalizeWereadRoute(value: unknown): WereadRoutePayload | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<WereadRoutePayload>;
  if (typeof raw.url !== "string" || !isWereadReaderUrl(raw.url)) return null;
  if (typeof raw.title !== "string") return null;
  return { url: raw.url, title: raw.title };
}

// ---------------------------------------------------------------------------
// The runtime injected into the page
// ---------------------------------------------------------------------------

/**
 * Self-contained: the whole function is serialized into the page with
 * `toString()` (see buildWereadScript), so it must not reference any
 * module-level variable; the constants come in through args. A site other
 * than WeRead returns on the very first line, at zero cost.
 *
 * The selectors and the color values were all measured on the live WeRead
 * site (see the file header); the symptoms of a WeRead redesign are: the
 * margin comes back / the catalog returns to the right / the theme returns
 * to its own colors — checking the class names is enough.
 */
function wereadRuntime(args: {
  marker: string;
  readerPath: string;
  styleId: string;
}): void {
  if (location.hostname !== "weread.qq.com" && location.hostname !== "www.weread.qq.com") {
    return;
  }

  const isReader = () => location.pathname.startsWith(args.readerPath);
  const routeUrl = () => location.origin + location.pathname;

  // ---- Layout adaptation CSS (verified on the live site; the rationale and the grouping are in the file header) ----
  const ensureStyle = () => {
    if (document.getElementById(args.styleId)) return;
    const style = document.createElement("style");
    style.id = args.styleId;
    style.textContent = [
      // 1. Fill the width: the root cause of the margin in the scrolling mode is the max-width:1000px of .app_content,
      //    in the horizontal mode it is the max-width:2096px of the body text; the margin shrinks from 100px to 48px.
      //    A margin (not a padding) counts toward clientWidth — the site's pagination and drawing origin still come from
      //    the same box, so they cannot drift apart.
      "body.wr_page_reader .app_content { max-width: none !important; }",
      "body.wr_page_reader .readerChapterContent { max-width: none !important; }",
      "body.wr_page_reader .readerChapterContent { margin-left: 48px !important; margin-right: 48px !important; }",
      // 2. Eye-care green #dcebd6 = the --pdf-gutter of the PDF eye-care mode, with dark text.
      //    The catalog drawer and the toolbar keep the site's own open/close/scroll state machine; only the colors change.
      "body.wr_page_reader { background: #dcebd6 !important; color: #33413a !important; }",
      "body.wr_page_reader .app_content, body.wr_page_reader .wr_horizontalReader_app_content { background: #dcebd6 !important; }",
      "body.wr_page_reader .readerTopBar { background: #dcebd6 !important; }",
      "body.wr_page_reader .readerTopBar, body.wr_page_reader .readerTopBar button { color: #33413a !important; }",
      "body.wr_page_reader .readerCatalog { background: #dcebd6 !important; }",
      "body.wr_page_reader .readerCatalog, body.wr_page_reader .readerCatalog * { color: #33413a !important; }",
      "body.wr_page_reader .readerChapterContent { color: #2f3a33 !important; }",
      "body.wr_page_reader .readerControls_item { background: #dcebd6 !important; color: #33413a !important; }",
      "body.wr_page_reader .readerFooter { background: #dcebd6 !important; }",
      "body.wr_page_reader .readerFooter_button { background: #cfe3c8 !important; color: #33413a !important; }",
      // 3. The visible body glyphs are drawn on a canvas in the WeRead theme color (copy protection, on top of the DOM
      //    text, z-index:2) — the CSS text color only reaches the DOM layer, so on the green background the text would still be the
      //    theme's light color. The canvas has a transparent background and only draws the glyphs: brightness(0) presses the
      //    opaque pixels to black while keeping the alpha, that is dark text on a green background, same as the PDF eye-care mode.
      "body.wr_page_reader .wr_canvasContainer canvas { filter: brightness(0) !important; }",
      // 4. Horizontal (two-page) mode: the page container (.readerChapterContent/_container) carries a dark background of
      //    its own, so it is painted green as well, otherwise the body area stays black after switching to two pages.
      "body.wr_page_reader .readerChapterContent, body.wr_page_reader .readerChapterContent_container { background: #dcebd6 !important; }",
      // 5. The text color is wildcarded to all descendants: in the horizontal mode WeRead sets a light color directly on the inner page
      //    classes (such as wr_flyleaf_page_*) — an !important on the ancestor does not beat a direct rule; the catalog turns dark
      //    through the same wildcard. svg/canvas are excluded (the illustrations are <img> and ignore color, the svg icons have their own fill).
      "body.wr_page_reader .readerChapterContent, body.wr_page_reader .readerChapterContent *:not(svg):not(canvas) { color: #2f3a33 !important; }",
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  };

  // ---- Route tracking: reader route -> title channel ----
  let reportedUrl = "";
  let reportedTitle = "";
  let titleRetries = 0;
  let titleTimer: ReturnType<typeof setTimeout> | undefined;

  const report = (title: string) => {
    const url = routeUrl();
    if (url === reportedUrl && title === reportedTitle) return;
    reportedUrl = url;
    reportedTitle = title;
    document.title = `${args.marker}${JSON.stringify({ url, title })}`;
  };

  // The title is in the top bar and rendered asynchronously: look at it every 500ms, and once it is there report it once more and stop.
  // The DOM selectors are the underscore-style class names of the live WeRead site; the fallback parses the document.title that WeRead
  // sets itself ("title - author - WeRead"). Do not mistake the marker message we write ourselves for a title.
  const TITLE_SELECTORS = [
    ".readerTopBar_title_link",
    ".readerTopBar_title",
    "[class*='readerTopBar_title']",
  ];
  const readDomTitle = (): string => {
    for (const sel of TITLE_SELECTORS) {
      const el = document.querySelector(sel);
      const text = el && el.textContent ? el.textContent.trim() : "";
      if (text) return text;
    }
    const t = document.title;
    if (t && !t.startsWith(args.marker)) {
      const cleaned = t.replace(/\s*-\s*微信读书\s*$/, "").trim();
      const name = cleaned.split(/\s+-\s+/)[0].trim();
      if (name) return name;
    }
    return "";
  };
  const scheduleTitleRetry = () => {
    if (titleTimer !== undefined) clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      titleTimer = undefined;
      if (!isReader() || reportedTitle) return;
      const title = readDomTitle();
      if (title) {
        report(title);
        return;
      }
      if (titleRetries++ < 20) scheduleTitleRetry();
    }, 500);
  };

  const onRoute = () => {
    ensureStyle();
    if (!isReader()) return;
    reportedTitle = "";
    titleRetries = 0;
    report("");
    scheduleTitleRetry();
  };

  // SPA routing: hook pushState/replaceState, popstate goes through the event.
  const wrapHistory = (key: "pushState" | "replaceState") => {
    const original = history[key].bind(history);
    history[key] = ((
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) => {
      const result = original(data, unused, url);
      queueMicrotask(onRoute);
      return result;
    }) as typeof history.pushState;
  };
  wrapHistory("pushState");
  wrapHistory("replaceState");

  // At document_start the head may not be ready yet (the style is attached to the html element first), so add it once more.
  document.addEventListener("DOMContentLoaded", ensureStyle);
  window.addEventListener("popstate", onRoute);
  ensureStyle();
  onRoute();
}

/** The WeRead runtime injected into the native webview (self-contained, the constants are inlined). */
export function buildWereadScript(): string {
  return `(${wereadRuntime.toString()})(${JSON.stringify({
    marker: WEREAD_TITLE_PREFIX,
    readerPath: READER_PATH,
    styleId: "bnote-weread-style",
  })});`;
}

/** Computed only once: the main window splices it into previewInitScript and hands it to Rust to register as an init script. */
export const WEREAD_SCRIPT = buildWereadScript();
