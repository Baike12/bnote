import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The xterm instances behind the terminal drawer.
 *
 * The module owns the emulators (React only re-parents the element), so the
 * promises that keep a shell usable are all about identity and ordering:
 * `open()` runs once per session even when the pane is remounted, output that
 * arrives before the emulator exists is replayed instead of lost, a keystroke
 * reaches the PTY as base64, and a grid that did not change sends no ioctl.
 *
 * xterm probes a canvas while its module loads; jsdom has no canvas package,
 * so the stub has to be installed before the import below.
 */

vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    value: () => null,
    configurable: true,
  });
});

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  write: vi.fn(async () => {}),
  resize: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => {};
  },
}));
vi.mock("../api", () => ({
  termApi: { write: mocks.write, resize: mocks.resize },
}));

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  applyTermTheme,
  disposeAllTerminals,
  disposeTerminal,
  ensureTerminalOutputListener,
  fitTerminal,
  focusTerminal,
  mountTerminal,
  readTermTheme,
  unmountTerminal,
} from "./session";

let openSpy: ReturnType<typeof vi.spyOn>;
let writeSpy: ReturnType<typeof vi.spyOn>;
let focusSpy: ReturnType<typeof vi.spyOn>;
let disposeSpy: ReturnType<typeof vi.spyOn>;

let nextId = 100;

/** Ids are unique per test so a leaked handle can never answer for the next one. */
function id(): number {
  return nextId++;
}

function host(width = 400, height = 200): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(element, "clientHeight", { value: height, configurable: true });
  document.body.appendChild(element);
  return element;
}

function emitOutput(termId: number, text: string): void {
  const handler = mocks.listeners.get("term-output");
  expect(handler).toBeDefined();
  // The real event carries the PTY's bytes as base64; encoding the text as
  // UTF-8 first is what makes a split multi-byte sequence testable.
  handler?.({ payload: { termId, data: bytesToBase64(new TextEncoder().encode(text)) } });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function emitRawOutput(termId: number, bytes: Uint8Array): void {
  const handler = mocks.listeners.get("term-output");
  expect(handler).toBeDefined();
  handler?.({ payload: { termId, data: bytesToBase64(bytes) } });
}

function writtenBytes(): number[][] {
  const calls = writeSpy.mock.calls as unknown as Array<[Uint8Array]>;
  return calls.map((call) => [...call[0]]);
}

function bytesOf(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function firstTerminal(): Terminal {
  return openSpy.mock.instances[0] as Terminal;
}

async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  openSpy = vi.spyOn(Terminal.prototype, "open");
  writeSpy = vi.spyOn(Terminal.prototype, "write");
  focusSpy = vi.spyOn(Terminal.prototype, "focus");
  disposeSpy = vi.spyOn(Terminal.prototype, "dispose");
});

afterEach(() => {
  disposeAllTerminals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("reading the theme", () => {
  it("maps the CSS variables the app defines", () => {
    document.documentElement.style.setProperty("--term-bg", "#101010");
    document.documentElement.style.setProperty("--term-cursor", "#f0f0f0");
    document.documentElement.style.setProperty("--term-red", "#ff0000");
    expect(readTermTheme()).toMatchObject({
      background: "#101010",
      cursor: "#f0f0f0",
      red: "#ff0000",
    });
    document.documentElement.style.removeProperty("--term-bg");
    document.documentElement.style.removeProperty("--term-cursor");
    document.documentElement.style.removeProperty("--term-red");
  });

  it("a missing variable stays an empty string instead of a made-up color", () => {
    document.documentElement.style.removeProperty("--term-green");
    expect(readTermTheme().green).toBe("");
  });

  it("a theme change is re-read into every live emulator", async () => {
    const a = id();
    await mountTerminal(a, host());
    document.documentElement.style.setProperty("--term-bg", "#222222");
    applyTermTheme();
    expect(firstTerminal().options.theme?.background).toBe("#222222");
    document.documentElement.style.removeProperty("--term-bg");
  });
});

describe("subscribing to the PTY output", () => {
  it("subscribes once for the whole module", async () => {
    await ensureTerminalOutputListener();
    await ensureTerminalOutputListener();
    expect([...mocks.listeners.keys()]).toEqual(["term-output"]);
  });

  it("writes a chunk into the emulator that owns the id", async () => {
    const termId = id();
    await mountTerminal(termId, host());
    emitOutput(termId, "hi");
    expect(writtenBytes()).toEqual([[0x68, 0x69]]);
  });

  it("decodes over bytes, so a UTF-8 sequence split across two batches survives", async () => {
    const termId = id();
    await mountTerminal(termId, host());
    // "中" is E4 B8 AD; the PTY may split it between two chunks and xterm has
    // to see the bytes, not one lossy string per chunk.
    emitRawOutput(termId, bytesOf(0xe4, 0xb8));
    emitRawOutput(termId, bytesOf(0xad));
    expect(writtenBytes()).toEqual([[0xe4, 0xb8], [0xad]]);
  });

  it("output for an unknown id is queued and replayed on mount", async () => {
    const termId = id();
    await ensureTerminalOutputListener();
    emitOutput(termId, "first");
    emitOutput(termId, "second");
    await mountTerminal(termId, host());
    expect(writtenBytes()).toEqual([
      [...new TextEncoder().encode("first")],
      [...new TextEncoder().encode("second")],
    ]);
  });

  it("the queue is bounded: only the newest chunks of a session closed before mounting survive", async () => {
    const termId = id();
    await ensureTerminalOutputListener();
    for (let i = 0; i < 70; i++) emitOutput(termId, String(i));
    await mountTerminal(termId, host());
    const chunks = writtenBytes();
    expect(chunks).toHaveLength(64);
    expect(chunks[0]).toEqual([..."6"].map((c) => c.charCodeAt(0)));
    expect(chunks[63]).toEqual([..."69"].map((c) => c.charCodeAt(0)));
  });
});

describe("mounting", () => {
  it("creates the emulator once and opens it in the host", async () => {
    const termId = id();
    const first = host();
    await mountTerminal(termId, first);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(first.querySelector(".xterm")).not.toBeNull();
  });

  it("mounting again re-parents the element instead of rebuilding the emulator", async () => {
    const termId = id();
    const first = host();
    await mountTerminal(termId, first);
    const element = firstTerminal().element;
    const second = host();
    await mountTerminal(termId, second);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(element).toBeDefined();
    expect(second.contains(element ?? null)).toBe(true);
    expect(first.contains(element ?? null)).toBe(false);
  });

  it("a keystroke reaches the PTY base64-encoded", async () => {
    const termId = id();
    await mountTerminal(termId, host());
    firstTerminal().input("ls\r");
    await settled();
    expect(mocks.write).toHaveBeenCalledWith(termId, "bHMN");
  });

  it("a large paste is encoded without blowing the argument limit", async () => {
    const termId = id();
    await mountTerminal(termId, host());
    const pasted = "x".repeat(0x9000);
    firstTerminal().input(pasted);
    await settled();
    const calls = mocks.write.mock.calls as unknown as Array<[number, string]>;
    const data = calls[calls.length - 1][1];
    expect(atob(data)).toBe(pasted);
  });
});

describe("unmounting and disposing", () => {
  it("unmounting detaches the element without destroying the emulator", async () => {
    const termId = id();
    const hostElement = host();
    await mountTerminal(termId, hostElement);
    unmountTerminal(termId, hostElement);
    expect(hostElement.querySelector(".xterm")).toBeNull();
    expect(disposeSpy).not.toHaveBeenCalled();
    // Remounting brings the same emulator (and its scrollback) back.
    await mountTerminal(termId, hostElement);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(hostElement.querySelector(".xterm")).not.toBeNull();
  });

  it("unmounting from a host that does not own the element changes nothing", async () => {
    const termId = id();
    const owner = host();
    await mountTerminal(termId, owner);
    unmountTerminal(termId, host());
    expect(owner.querySelector(".xterm")).not.toBeNull();
  });

  it("disposing drops the emulator and its queued output", async () => {
    const termId = id();
    await mountTerminal(termId, host());
    emitOutput(termId, "late");
    writeSpy.mockClear();
    disposeTerminal(termId);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    // A new session with the same id starts empty: the old queue is gone.
    await mountTerminal(termId, host());
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("disposing an unknown id is harmless", () => {
    expect(() => disposeTerminal(12_345)).not.toThrow();
  });

  it("disposeAll drops every emulator", async () => {
    const a = id();
    const b = id();
    await mountTerminal(a, host());
    await mountTerminal(b, host());
    disposeAllTerminals();
    expect(disposeSpy).toHaveBeenCalledTimes(2);
  });
});

describe("resizing and focusing", () => {
  it("the first fit tells the kernel the grid, a repeated fit sends nothing", async () => {
    const termId = id();
    await mountTerminal(termId, host());
    const sent = mocks.resize.mock.calls.length;
    expect(sent).toBe(1);
    fitTerminal(termId);
    fitTerminal(termId);
    expect(mocks.resize.mock.calls.length).toBe(sent);
  });

  it("a grid that actually changed is sent to the kernel", async () => {
    const termId = id();
    await mountTerminal(termId, host());
    mocks.resize.mockClear();
    // The emulator resized itself (xterm can do that without a layout engine:
    // `resize` is the programmatic grid change). The next fit must forward the
    // new grid, while an unchanged one sends nothing.
    firstTerminal().resize(100, 40);
    fitTerminal(termId);
    expect(mocks.resize).toHaveBeenCalledWith(termId, 100, 40);
    mocks.resize.mockClear();
    fitTerminal(termId);
    expect(mocks.resize).not.toHaveBeenCalled();
  });

  it("fitting an unknown session does nothing", () => {
    expect(() => fitTerminal(12_345)).not.toThrow();
    expect(mocks.resize).not.toHaveBeenCalled();
  });

  it("focusing lands on the session's emulator", async () => {
    const termId = id();
    await mountTerminal(termId, host());
    focusTerminal(termId);
    expect(focusSpy).toHaveBeenCalledTimes(1);
    focusTerminal(12_345);
    expect(focusSpy).toHaveBeenCalledTimes(1);
  });
});

describe("a subscription that could not be installed", () => {
  it("is retried on the next mount instead of leaving the drawer silent forever", async () => {
    // A fresh module: the first `listen` rejects (no event source yet), the
    // second succeeds. The failure must clear the flag it set, otherwise the
    // drawer would keep the shell silent for the whole session.
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("no event source");
        return () => {};
      },
    }));
    const fresh = await import("./session");
    await expect(fresh.ensureTerminalOutputListener()).resolves.toBeUndefined();
    await fresh.ensureTerminalOutputListener();
    expect(attempts).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("term-output"), expect.anything());
    vi.doUnmock("@tauri-apps/api/event");
    vi.resetModules();
  });
});

describe("a host that cannot be measured", () => {
  it("a fit that throws is swallowed, no ioctl is sent", async () => {
    const termId = id();
    await mountTerminal(termId, host());
    mocks.resize.mockClear();
    // A host inside a `display: none` subtree reports no computed style: the
    // addon's own measurement throws and must not take the drawer down.
    const fit = vi.spyOn(FitAddon.prototype, "fit").mockImplementation(() => {
      throw new Error("not measurable");
    });
    expect(() => fitTerminal(termId)).not.toThrow();
    expect(mocks.resize).not.toHaveBeenCalled();
    fit.mockRestore();
  });
});
