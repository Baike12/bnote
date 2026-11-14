/**
 * @vitest-environment-options {"url": "https://weread.qq.com/web/reader/ce032b305a"}
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WEREAD_SCRIPT, WEREAD_TITLE_PREFIX } from "./weread";

/**
 * The WeRead runtime is a self-contained IIFE serialized into the native
 * webview (see `buildWereadScript`). `weread.test.ts` proves the serialized
 * text contains the measured selectors and CSS; this test runs the real
 * function and exercises its runtime behavior: the hostname gate, the style
 * injection, the SPA route tracking and the bounded title retry.
 *
 * jsdom's document title and history are the same channels Rust reads in the
 * app, so the assertions are on the exact payload that crosses the boundary.
 */

const nativePushState = history.pushState;
const nativeReplaceState = history.replaceState;
const START_PATH = "/web/reader/ce032b305a";

/** The URL the runtime reports: origin + pathname, no query or hash. */
function routeUrl(): string {
  return location.origin + location.pathname;
}

/**
 * Run the serialized script with a shadowed `location`. The runtime reads
 * `location` on its first line, so a fake object is enough to prove the gate.
 */
function runWithLocation(hostname: string): void {
  const script = new Function("location", WEREAD_SCRIPT) as (loc: { hostname: string }) => void;
  script({ hostname });
}

function startRuntime(): void {
  new Function(WEREAD_SCRIPT)();
}

function titlePayload(): { url: string; title: string } {
  expect(document.title.startsWith(WEREAD_TITLE_PREFIX)).toBe(true);
  return JSON.parse(document.title.slice(WEREAD_TITLE_PREFIX.length)) as {
    url: string;
    title: string;
  };
}

/** Put the fake history and the URL back; the runtime wraps both on every start. */
beforeEach(() => {
  history.pushState = nativePushState;
  history.replaceState = nativeReplaceState;
  nativeReplaceState.call(history, {}, "", START_PATH);
  vi.useFakeTimers();
});

describe("the hostname gate", () => {
  it("a page that is not WeRead installs nothing and does not touch history", () => {
    startRuntime();
    const styleBefore = document.querySelectorAll("#bnote-weread-style").length;
    const titleBefore = document.title;
    const pushBefore = history.pushState;

    runWithLocation("example.com");

    expect(document.querySelectorAll("#bnote-weread-style")).toHaveLength(styleBefore);
    expect(document.title).toBe(titleBefore);
    expect(history.pushState).toBe(pushBefore);
  });
});

describe("the runtime on a WeRead reader page", () => {
  beforeEach(() => {
    startRuntime();
  });

  it("injects the layout stylesheet exactly once, into the document head", () => {
    const styles = document.querySelectorAll("#bnote-weread-style");
    expect(styles).toHaveLength(1);
    const style = styles[0] as HTMLStyleElement;
    expect(document.head.contains(style)).toBe(true);
    expect(style.textContent).toContain("body.wr_page_reader .app_content { max-width: none");
    expect(style.textContent).toContain("#dcebd6");
  });

  it("injects the stylesheet again idempotently when the document head arrives later", () => {
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(document.querySelectorAll("#bnote-weread-style")).toHaveLength(1);
  });

  it("reports the route as soon as it is entered, with an empty title", () => {
    expect(titlePayload()).toEqual({ url: routeUrl(), title: "" });
  });

  it("pushState enters a new reader route and reports it (the SPA shelf -> book step)", async () => {
    history.pushState({}, "", "/web/reader/def456");
    await Promise.resolve();

    expect(titlePayload()).toEqual({ url: routeUrl(), title: "" });
  });

  it("replaceState is tracked through the same hook", async () => {
    history.replaceState({}, "", "/web/reader/pqr678");
    await Promise.resolve();

    expect(titlePayload()).toEqual({ url: routeUrl(), title: "" });
  });

  it("a navigation away from the reader keeps the style but reports nothing new", async () => {
    const before = document.title;
    history.pushState({}, "", "/web/bookDetail/abc");
    await Promise.resolve();

    expect(document.title).toBe(before);
    expect(document.querySelectorAll("#bnote-weread-style")).toHaveLength(1);
  });

  it("fills in the title once the top bar renders, then stops retrying", async () => {
    const link = document.createElement("span");
    link.className = "readerTopBar_title_link";
    link.textContent = "三体";
    document.body.appendChild(link);

    await vi.advanceTimersByTimeAsync(500);

    expect(titlePayload()).toEqual({ url: routeUrl(), title: "三体" });
    // A title was found: the poll stops, no timer is left behind.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(titlePayload()).toMatchObject({ title: "三体" });
  });

  it("prefers the link selector over the plain title selector", async () => {
    const link = document.createElement("span");
    link.className = "readerTopBar_title_link";
    link.textContent = "三体";
    const plain = document.createElement("span");
    plain.className = "readerTopBar_title";
    plain.textContent = "别的书";
    document.body.append(plain, link);

    await vi.advanceTimersByTimeAsync(500);

    expect(titlePayload()).toMatchObject({ title: "三体" });
  });

  it("falls back to WeRead's own document title, dropping the author and the site suffix", async () => {
    // The reader has not drawn its top bar yet, but WeRead has set the tab title.
    document.title = "三体 - 刘慈欣 - 微信读书";

    await vi.advanceTimersByTimeAsync(500);

    expect(titlePayload()).toEqual({ url: routeUrl(), title: "三体" });
  });

  it("never mistakes the marker title it wrote itself for a book title, and gives up after 20 retries", async () => {
    // No selector and no page title: readDomTitle must reject the marker text
    // written by the runtime itself.
    expect(document.title.startsWith(WEREAD_TITLE_PREFIX)).toBe(true);

    await vi.advanceTimersByTimeAsync(500 * 25);

    expect(titlePayload()).toEqual({ url: routeUrl(), title: "" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an identical route and title are not written a second time", async () => {
    await vi.advanceTimersByTimeAsync(500);
    const written = document.title;

    // Entering the same route again resets the reported title to empty, which
    // is a different payload, so the channel does change once; the retry that
    // follows finds nothing new and must not rewrite the marker text.
    history.pushState({}, "", START_PATH);
    await Promise.resolve();
    const afterEnter = document.title;
    await vi.advanceTimersByTimeAsync(500);

    expect(afterEnter).toBe(written);
    expect(document.title).toBe(written);
  });

  it("a popstate is handled by the same route handler", () => {
    nativeReplaceState.call(history, {}, "", "/web/reader/xyz999");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(titlePayload()).toEqual({ url: routeUrl(), title: "" });
  });
});
