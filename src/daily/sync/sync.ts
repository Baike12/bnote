import { api, syncApi, type SyncPulledDay } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { findEditorFor } from "@/editor/api";
import { dailyDayOf, dailyPathFor } from "@/daily/model";
import { SYNC_USER_EVENT } from "@/daily/engine";
import { mergeDocs } from "./merge";

/**
 * The b-todo sync orchestrator: one module-level singleton per vault, the
 * same ownership pattern as `links.ts`.
 *
 * Ordering contract (the whole feature hangs on these):
 *   - The Rust side owns the wire (SSE + crypto); this module owns what the
 *     documents mean: when to push, what a remote copy replaces.
 *   - Every local edit is pushed with the revision it was built on; a 409 is
 *     resolved by a three-way merge against the base snapshot and re-pushed.
 *   - A remote event is applied through the engine write discipline (patch
 *     the open editor, else write the file) and merged the same way, so the
 *     user's unsaved typing never loses to the network.
 *   - Echoes are cut off twice: own-device events only move the revision, and
 *     a push whose content hash equals the last pushed hash is a no-op.
 *   - Diverged days without a base snapshot stay "unresolved" until the user
 *     runs an explicit force sync — the initial states of several devices are
 *     only aligned by hand, per the feature contract.
 */

// ---------------------------------------------------------------- state

const SYNC_STATE_PATH = ".bnote/b-todo/sync-state.json";
const PUSH_DEBOUNCE_MS = 600;
const APPLY_REMOTE_FLAG_GRACE_MS = 1500;

interface PersistedState {
  version: 1;
  deviceId: string;
  /** Server revision per synced day. The base snapshots live in memory only. */
  days: Record<string, { rev: number }>;
}

interface DayState {
  rev: number;
  /** The document as of `rev` (server side); null = unknown yet. */
  base: string | null;
  /** Hash of the content our last accepted push carried (echo guard). */
  lastPushHash: string | null;
  /** Diverged without a base snapshot; only force sync resolves this. */
  unresolved: boolean;
}

interface SyncConfig {
  server: string;
  key: string;
}

interface SyncRuntime {
  connected: boolean;
  detail: string;
  lastSyncAt: number | null;
  unresolvedCount: number;
}

let cache: { vault: string; state: PersistedState; days: Map<string, DayState> } | null = null;
let config: SyncConfig | null = null;
let runtime: SyncRuntime = { connected: false, detail: "", lastSyncAt: null, unresolvedCount: 0 };
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let configuring = false;
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const applyingRemote = new Set<string>();

const listeners = new Set<() => void>();

/** Clears every module-level value; the sync.test.ts harness starts each case from a blank slate with it. */
export function __resetSyncForTests(): void {
  if (persistTimer) clearTimeout(persistTimer);
  for (const timer of pushTimers.values()) clearTimeout(timer);
  pushTimers.clear();
  applyingRemote.clear();
  listeners.clear();
  cache = null;
  config = null;
  runtime = { connected: false, detail: "", lastSyncAt: null, unresolvedCount: 0 };
  persistTimer = null;
  configuring = false;
}

/** Subscribe to sync state changes (settings status line re-renders on them). */
export function onSyncChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function broadcast(): void {
  for (const fn of [...listeners]) fn();
}

/** Synchronous snapshot for the settings UI. */
export function syncRuntime(): SyncRuntime {
  return runtime;
}

function countUnresolved(): number {
  if (!cache) return 0;
  let n = 0;
  for (const day of cache.days.values()) if (day.unresolved) n++;
  return n;
}

// ------------------------------------------------------------- persistence

function syncFilePath(vault: string): string {
  return `${vault.replace(/\/+$/, "")}/${SYNC_STATE_PATH}`;
}

function emptyState(): PersistedState {
  // crypto.randomUUID needs a secure context; the app webview has one, but a
  // plain fallback keeps the browser-mode dev loop working everywhere.
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { version: 1, deviceId: uuid, days: {} };
}

async function ensureSyncState(vault: string): Promise<void> {
  if (cache && cache.vault === vault) return;
  // A pending push timer carries the OLD vault's day; after the swap it would
  // push the new vault's file under the old vault's revision. Drop them.
  if (cache) {
    for (const timer of pushTimers.values()) clearTimeout(timer);
    pushTimers.clear();
    applyingRemote.clear();
  }
  let raw: string | null = null;
  try {
    raw = await api.readFile(syncFilePath(vault));
  } catch {
    raw = null; // first sync in this vault
  }
  let state = emptyState();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (parsed.version === 1 && typeof parsed.deviceId === "string") {
        state = { version: 1, deviceId: parsed.deviceId, days: parsed.days ?? {} };
      }
    } catch {
      // Corrupted metadata rebuilds from scratch; documents are unaffected.
    }
  }
  const days = new Map<string, DayState>();
  for (const [date, entry] of Object.entries(state.days)) {
    days.set(date, { rev: entry.rev, base: null, lastPushHash: null, unresolved: false });
  }
  cache = { vault, state, days };
}

function persistState(): void {
  if (!cache) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeNow();
  }, 300);
}

function writeNow(): void {
  if (!cache) return;
  const payload: PersistedState = {
    version: 1,
    deviceId: cache.state.deviceId,
    days: Object.fromEntries([...cache.days.entries()].map(([date, d]) => [date, { rev: d.rev }])),
  };
  void api
    .writeFile(syncFilePath(cache.vault), JSON.stringify(payload, null, 2))
    .catch((e) => console.warn("daily sync state persist failed", e));
}

/** Flush the pending state write (App quit/hide path). */
export function flushDailySyncPersist(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  writeNow();
}

// ------------------------------------------------------------ day content

function dayPath(date: string): string {
  return dailyPathFor(cache!.vault, date);
}

/** Editor document when the day is open, disk otherwise — the engine rule. */
async function readDayContent(date: string): Promise<string | null> {
  const path = dayPath(date);
  const view = findEditorFor(path);
  if (view) return view.state.doc.toString();
  try {
    return await api.readFile(path);
  } catch {
    return null;
  }
}

async function writeDayContent(date: string, content: string): Promise<void> {
  const path = dayPath(date);
  const view = findEditorFor(path);
  if (view) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      // Tag as sync-generated: the cross-file link extension skips its own
      // intent pass for these, mirroring engine-driven writes.
      userEvent: SYNC_USER_EVENT,
    });
  } else {
    await api.writeFile(path, content);
  }
}

/** FNV-1a, hex: cheap echo guard, never used as identity. */
function hashContent(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function dayState(date: string): DayState {
  let d = cache!.days.get(date);
  if (!d) {
    d = { rev: 0, base: null, lastPushHash: null, unresolved: false };
    cache!.days.set(date, d);
  }
  return d;
}

// ---------------------------------------------------------------- configure

/**
 * Applies settings.daily.sync: connects (or disconnects) the Rust SSE session
 * and runs the initial reconciliation. Safe to call repeatedly — settings
 * saves, vault swaps and startup all funnel through here.
 */
export async function configureSync(): Promise<void> {
  if (configuring) return;
  configuring = true;
  try {
    const settings = useAppStore.getState().settings.daily.sync;
    const vault = useAppStore.getState().vaultPath;
    if (
      !vault ||
      !settings.enabled ||
      settings.server.trim() === "" ||
      settings.key.trim() === ""
    ) {
      config = null;
      runtime = {
        connected: false,
        detail: settings.enabled ? "配置不完整" : "",
        lastSyncAt: null,
        unresolvedCount: 0,
      };
      await syncApi.disconnect().catch(() => {});
      broadcast();
      return;
    }
    await ensureSyncState(vault);
    const next: SyncConfig = { server: settings.server.trim(), key: settings.key };
    try {
      await syncApi.connect(next.server, next.key, cache!.state.deviceId);
    } catch (e) {
      config = next;
      runtime = {
        connected: false,
        detail: String(e).replace(/^[A-Z_]+:\s*/, ""),
        lastSyncAt: null,
        unresolvedCount: countUnresolved(),
      };
      broadcast();
      return;
    }
    config = next;
    runtime = {
      connected: true,
      detail: "已连接",
      lastSyncAt: null,
      unresolvedCount: countUnresolved(),
    };
    broadcast();
    await reconcileAll();
  } finally {
    configuring = false;
  }
}

// ---------------------------------------------------------------- reconcile

/**
 * First alignment after a connect: record every server revision, adopt the
 * documents that already agree with the local copy (or are missing locally),
 * and mark true divergences as unresolved instead of guessing.
 */
async function reconcileAll(): Promise<void> {
  if (!cache || !config) return;
  let pulled: SyncPulledDay[];
  try {
    pulled = await syncApi.pullDays(config.server, config.key, null);
  } catch (e) {
    runtime.detail = String(e).replace(/^[A-Z_]+:\s*/, "");
    broadcast();
    return;
  }
  for (const p of pulled) {
    const day = dayState(p.date);
    const local = await readDayContent(p.date);
    if (local === null) {
      // The day exists only on the other devices: pull it down verbatim.
      day.rev = p.rev;
      day.base = p.content;
      day.lastPushHash = hashContent(p.content);
      day.unresolved = false;
      await writeDayContent(p.date, p.content);
      continue;
    }
    if (local === p.content) {
      day.rev = p.rev;
      day.base = p.content;
      day.lastPushHash = hashContent(local);
      day.unresolved = false;
      continue;
    }
    if (day.base !== null && day.base === p.content) {
      // Local edits made while disconnected: the normal push path takes them.
      day.rev = p.rev;
      day.unresolved = false;
      schedulePush(p.date);
      continue;
    }
    // Both sides changed since the last common revision (or the very first
    // sync): do not guess — the user picks a side with force sync.
    day.rev = Math.max(day.rev, p.rev);
    day.base = null;
    day.unresolved = true;
  }
  runtime.lastSyncAt = Date.now();
  runtime.unresolvedCount = countUnresolved();
  persistState();
  broadcast();
}

// ---------------------------------------------------------------- push path

/** Called from the App-wide `vault-changed` listener with the changed paths. */
export function noteDailySyncPaths(paths: string[]): void {
  if (!cache || !config) return;
  for (const path of paths) {
    const day = dailyDayOf(path);
    if (day === null || applyingRemote.has(day)) continue;
    schedulePush(day);
  }
}

function schedulePush(date: string): void {
  if (pushTimers.has(date)) clearTimeout(pushTimers.get(date));
  pushTimers.set(
    date,
    setTimeout(() => {
      pushTimers.delete(date);
      void pushDay(date);
    }, PUSH_DEBOUNCE_MS),
  );
}

async function pushDay(date: string): Promise<void> {
  if (!cache || !config) return;
  const cfg = config;
  const day = dayState(date);
  const content = await readDayContent(date);
  if (content === null) return; // deleted locally; deletion propagates only via force sync
  if (day.lastPushHash === hashContent(content)) return; // our own write echoed back
  if (day.unresolved) return; // waiting for a force sync decision
  if (content.trim() === "") return; // an empty day has nothing to publish yet

  const results = await syncApi
    .pushDays(cfg.server, cfg.key, [
      { date, content, baseRev: day.rev, force: false, deviceId: cache.state.deviceId },
    ])
    .catch((e) => {
      runtime.detail = String(e).replace(/^[A-Z_]+:\s*/, "");
      broadcast();
      return null;
    });
  if (!results) return;
  const res = results[0];
  if (res.error) {
    runtime.detail = res.error.replace(/^[A-Z_]+:\s*/, "");
    broadcast();
    return;
  }
  if (res.ok && res.rev !== null) {
    acceptLocalPush(date, res.rev, content);
    return;
  }
  if (res.conflictRev !== null && res.conflictContent !== null) {
    await resolveConflict(date, content, res.conflictRev, res.conflictContent);
  }
}

function acceptLocalPush(date: string, rev: number, content: string): void {
  const day = dayState(date);
  day.rev = rev;
  day.base = content;
  day.lastPushHash = hashContent(content);
  day.unresolved = false;
  runtime.lastSyncAt = Date.now();
  runtime.detail = "已同步";
  runtime.unresolvedCount = countUnresolved();
  persistState();
  broadcast();
}

/** Merge against the server copy and push the result once (bounded retries). */
async function resolveConflict(
  date: string,
  local: string,
  serverRev: number,
  serverContent: string,
): Promise<void> {
  const deviceId = cache!.state.deviceId;
  const day = dayState(date);
  if (day.base === null) {
    // No common ancestor: refuse to guess on the user's behalf.
    day.unresolved = true;
    runtime.unresolvedCount = countUnresolved();
    broadcast();
    return;
  }
  const merged = mergeDocs(day.base, local, serverContent);
  await writeDayContent(date, merged);
  const results = await syncApi
    .pushDays(config!.server, config!.key, [
      { date, content: merged, baseRev: serverRev, force: false, deviceId },
    ])
    .catch(() => null);
  if (!results) return;
  const res = results[0];
  if (res.ok && res.rev !== null) {
    acceptLocalPush(date, res.rev, merged);
  } else if (res.conflictRev !== null) {
    // Extremely rare (another device pushed between our merge and push):
    // leave it to the next local edit rather than looping here.
    day.lastPushHash = hashContent(merged);
    day.base = null;
    day.unresolved = true;
    runtime.unresolvedCount = countUnresolved();
    broadcast();
  } else if (res.error) {
    runtime.detail = res.error.replace(/^[A-Z_]+:\s*/, "");
    broadcast();
  }
}

// ---------------------------------------------------------------- remote events

/** Status frames from the Rust SSE loop (`daily-sync-status`). */
export function handleSyncStatusEvent(payload: unknown): void {
  const p = payload as { connected?: boolean; detail?: string } | null;
  if (!p || typeof p.connected !== "boolean") return;
  runtime = {
    ...runtime,
    connected: p.connected,
    detail: p.detail ?? (p.connected ? "已连接" : "已断开"),
  };
  broadcast();
}

/** Decrypted day updates from the Rust SSE loop (`daily-sync-day`). */
export async function handleSyncDayEvent(payload: unknown): Promise<void> {
  const p = payload as { date?: string; rev?: number; device?: string; content?: string } | null;
  if (
    !cache ||
    !config ||
    !p ||
    typeof p.date !== "string" ||
    typeof p.rev !== "number" ||
    typeof p.content !== "string"
  ) {
    return;
  }
  runtime.lastSyncAt = Date.now();
  const day = dayState(p.date);
  if (p.device === cache.state.deviceId) {
    // Own echo: the content is already here, only the revision moves.
    if (p.rev >= day.rev) day.rev = p.rev;
    persistState();
    broadcast();
    return;
  }
  if (p.rev <= day.rev && day.base !== null) return;
  if (day.unresolved) return; // wait for the force-sync decision
  await applyRemote(p.date, p.rev, p.content, false);
}

/** The engine write discipline for one remote document. */
async function applyRemote(
  date: string,
  rev: number,
  content: string,
  force: boolean,
): Promise<void> {
  const day = dayState(date);
  const local = await readDayContent(date);
  let next: string;
  if (force || local === null) {
    next = content;
  } else if (day.base !== null && local !== day.base) {
    next = mergeDocs(day.base, local, content);
  } else {
    next = content;
  }
  applyingRemote.add(date);
  try {
    await writeDayContent(date, next);
  } finally {
    setTimeout(() => applyingRemote.delete(date), APPLY_REMOTE_FLAG_GRACE_MS);
  }
  day.rev = rev;
  day.base = next;
  day.lastPushHash = hashContent(next);
  day.unresolved = false;
  runtime.unresolvedCount = countUnresolved();
  persistState();
  broadcast();
}

// ---------------------------------------------------------------- force sync

/** 用本地 Daily/ 的每一天覆盖服务器（初始对齐：本地 → 远端）。 */
export async function forcePushAll(): Promise<void> {
  if (!cache || !config) {
    return;
  }
  const cfg = config;
  const vault = cache.vault;
  const deviceId = cache.state.deviceId;
  let names: string[] = [];
  try {
    const nodes = await api.readDir("Daily");
    names = nodes.filter((n) => n.kind === "file").map((n) => n.name);
  } catch {
    return;
  }
  const days: { date: string; content: string }[] = [];
  for (const name of names) {
    // dailyDayOf matches `/Daily/<date>.md` inside a full path — a bare
    // `Daily/<name>` would never match and silently skip every day.
    const day = dailyDayOf(dailyPathFor(vault, name.replace(/\.md$/, "")));
    if (day === null) continue;
    const content = await readDayContent(day);
    if (content !== null && content.trim() !== "") days.push({ date: day, content });
  }
  if (days.length === 0) {
    runtime.detail = "本地没有可推送的日记";
    broadcast();
    return;
  }
  const results = await syncApi.pushDays(
    cfg.server,
    cfg.key,
    days.map((d) => ({ ...d, baseRev: 0, force: true, deviceId })),
  );
  let pushed = 0;
  let failure: string | null = null;
  for (const res of results) {
    if (res.ok && res.rev !== null) {
      const local = days.find((d) => d.date === res.date)!;
      acceptLocalPush(res.date, res.rev, local.content);
      pushed++;
    } else if (res.error) {
      failure = res.error.replace(/^[A-Z_]+:\s*/, "");
    }
  }
  runtime.lastSyncAt = Date.now();
  broadcast();
  // A failed day must reach the caller: the settings page reports success or
  // failure verbatim, and a silent partial push is a lost-alignment lie.
  if (pushed < days.length) {
    throw new Error(failure ?? `${days.length - pushed} 天推送失败`);
  }
}

/** 用服务器上的每一天覆盖本地（初始对齐：远端 → 本地）。 */
export async function forcePullAll(): Promise<void> {
  if (!cache || !config) return;
  let pulled: SyncPulledDay[];
  try {
    pulled = await syncApi.pullDays(config.server, config.key, null);
  } catch (e) {
    runtime.detail = String(e).replace(/^[A-Z_]+:\s*/, "");
    broadcast();
    return;
  }
  for (const p of pulled) {
    await applyRemote(p.date, p.rev, p.content, true);
  }
  runtime.lastSyncAt = Date.now();
  runtime.detail = `已拉取 ${pulled.length} 天`;
  broadcast();
}
