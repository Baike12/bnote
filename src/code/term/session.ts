import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { termApi, type TermOutputEvent } from "../api";

/**
 * The xterm instances, one per backend PTY session.
 *
 * **The instance owns its DOM element**, not React: switching the study
 * content away unmounts the whole code pane, and rebuilding the emulator would
 * throw away the scrollback and the cursor. The pane therefore only ever
 * re-parents `terminal.element` into its host; `terminal.open()` runs exactly
 * once per session.
 *
 * Keys travel as bytes (`onData` → base64 → `term_write`) and output arrives
 * as batched events, mirrored into the emulator that owns the id.
 */

interface TermHandle {
  terminal: Terminal;
  fit: FitAddon;
  /** Last grid handed to the PTY (a fit that changes nothing sends nothing). */
  cols: number;
  rows: number;
}

const handles = new Map<number, TermHandle>();

/**
 * Output that arrived before its emulator existed.
 *
 * `term_open` returns an id, React renders the drawer, and only then is there a
 * terminal to write to — the shell's first prompt lands squarely in that gap.
 * Chunks for an unknown id are queued here and replayed on mount; the bound
 * keeps a session closed before mounting from growing forever.
 */
const pendingOutput = new Map<number, Uint8Array[]>();
const PENDING_LIMIT = 64;

let listening = false;

/** Read the terminal theme from the live CSS variables (never a literal: the theme gate forbids bare colors). */
export function readTermTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const read = (variable: string): string => style.getPropertyValue(variable).trim();
  return {
    background: read("--term-bg"),
    foreground: read("--term-fg"),
    cursor: read("--term-cursor"),
    cursorAccent: read("--term-cursor-accent"),
    selectionBackground: read("--term-selection"),
    black: read("--term-black"),
    red: read("--term-red"),
    green: read("--term-green"),
    yellow: read("--term-yellow"),
    blue: read("--term-blue"),
    magenta: read("--term-magenta"),
    cyan: read("--term-cyan"),
    white: read("--term-white"),
    brightBlack: read("--term-bright-black"),
    brightRed: read("--term-bright-red"),
    brightGreen: read("--term-bright-green"),
    brightYellow: read("--term-bright-yellow"),
    brightBlue: read("--term-bright-blue"),
    brightMagenta: read("--term-bright-magenta"),
    brightCyan: read("--term-bright-cyan"),
    brightWhite: read("--term-bright-white"),
  };
}

function fontSetting(variable: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback;
}

/**
 * Serve `term-output` once for the whole module. The handler looks the id up
 * on every chunk: a chunk for a closed session is simply dropped.
 *
 * Must complete **before** `term_open`: the shell prints its prompt right after
 * being spawned, and a listener installed afterwards would miss it.
 */
export async function ensureTerminalOutputListener(): Promise<void> {
  if (listening) return;
  listening = true;
  try {
    await listen<TermOutputEvent>("term-output", (event) => {
      // Bytes, not a string: a UTF-8 sequence may be split across two batches.
      const bytes = base64ToBytes(event.payload.data);
      const handle = handles.get(event.payload.termId);
      if (handle) {
        handle.terminal.write(bytes);
        return;
      }
      const queue = pendingOutput.get(event.payload.termId) ?? [];
      queue.push(bytes);
      if (queue.length > PENDING_LIMIT) queue.shift();
      pendingOutput.set(event.payload.termId, queue);
    });
  } catch (e) {
    listening = false;
    console.warn("[term] cannot subscribe to term-output", e);
  }
}

/**
 * Put the session into `host`, creating the emulator on first use.
 *
 * Re-parenting (not `open()` again) is what keeps the scrollback: the pane may
 * have been unmounted by a switch of the study content.
 */
export async function mountTerminal(id: number, host: HTMLElement): Promise<void> {
  await ensureTerminalOutputListener();
  const existing = handles.get(id);
  if (existing) {
    const element = existing.terminal.element;
    if (element && element.parentElement !== host) host.appendChild(element);
    fitTerminal(id);
    return;
  }
  const terminal = new Terminal({
    // The app turns the caret blink off everywhere (theme.test.ts locks the
    // CodeMirror cursor); a blinking block would be the only one left.
    cursorBlink: false,
    cursorStyle: "bar",
    fontFamily: fontSetting("--code-font", "monospace"),
    fontSize: parseFloat(fontSetting("--code-font-size", "12.5px")) || 12.5,
    lineHeight: 1.2,
    scrollback: 5000,
    theme: readTermTheme(),
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);

  const handle: TermHandle = { terminal, fit, cols: 0, rows: 0 };
  handles.set(id, handle);
  // Replay what the shell printed while the drawer was being built (the first
  // prompt is printed immediately).
  const queued = pendingOutput.get(id);
  if (queued) {
    pendingOutput.delete(id);
    for (const bytes of queued) terminal.write(bytes);
  }
  terminal.onData((data) => {
    // Fire-and-forget by design: a keystroke has no error path the user could
    // act on, and the shell's death is reported by `term-exit`.
    void termApi.write(id, bytesToBase64(new TextEncoder().encode(data))).catch(() => {});
  });
  fitTerminal(id);
}

/** Take the session's element out of its host without destroying the emulator. */
export function unmountTerminal(id: number, host: HTMLElement): void {
  const handle = handles.get(id);
  const element = handle?.terminal.element;
  if (element && element.parentElement === host) host.removeChild(element);
}

/**
 * Resize the grid to the host, then tell the kernel. Values are compared first:
 * a `fit()` that lands on the same grid must not send an ioctl per rendered
 * frame (the drawer's ResizeObserver fires on every drag move).
 */
export function fitTerminal(id: number): void {
  const handle = handles.get(id);
  if (!handle || !handle.terminal.element) return;
  try {
    handle.fit.fit();
  } catch {
    // A zero-sized host (drawer closed / display:none) cannot be measured.
    return;
  }
  const { cols, rows } = handle.terminal;
  if (cols < 1 || rows < 1 || (cols === handle.cols && rows === handle.rows)) return;
  handle.cols = cols;
  handle.rows = rows;
  void termApi.resize(id, cols, rows).catch((e) => console.warn("[term] resize failed", e));
}

export function focusTerminal(id: number): void {
  handles.get(id)?.terminal.focus();
}

/** Re-read the theme variables (the app theme changed). */
export function applyTermTheme(): void {
  const theme = readTermTheme();
  for (const handle of handles.values()) handle.terminal.options.theme = theme;
}

/** Drop the emulator for a session the backend no longer has. */
export function disposeTerminal(id: number): void {
  pendingOutput.delete(id);
  const handle = handles.get(id);
  if (!handle) return;
  handles.delete(id);
  handle.terminal.dispose();
}

export function disposeAllTerminals(): void {
  pendingOutput.clear();
  for (const id of [...handles.keys()]) disposeTerminal(id);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: String.fromCharCode(...) blows the argument limit on large pastes.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
