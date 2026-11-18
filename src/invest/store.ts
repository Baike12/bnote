/**
 * The invest store: the single writer of the invest mode's shared state.
 *
 * State discipline (AGENTS.md rule 5):
 * - Every async load carries a **generation counter**: a result that belongs
 *   to a scope/instrument the user has already left is dropped, never written.
 * - The component-level data (detail tabs) reads through the same selectors;
 *   nothing mirrors store state locally.
 * - The notes column is the app's global `currentFile` (the EditorPane owns
 *   it); the store only owns the tab list and which tab is active, and the
 *   tab switch goes through `appStore.openFile`.
 */

import { create } from "zustand";
import { findEditorFor } from "@/editor/api";
import { investApi } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { vaultDotPath } from "@/study/vaultJson";
import {
  importTargetScope,
  cycleIndex,
  filterInstruments,
  parseScope,
  scopeFor,
} from "./layoutModel";
import { ingestToast } from "./ingestToast";
import { buildSnapshotMarkdown } from "./snapshotNote";
import type {
  InvestDocInfo,
  InvestEvent,
  InvestFinancial,
  InvestFundFlowDay,
  InvestInstrument,
  InvestPeriod,
  InvestSearchHit,
  InvestSector,
  InvestSkillBundle,
  InvestSnapshot,
  InvestViewKind,
} from "./types";

export const DEFAULT_HORIZON = 5;

interface InvestState {
  /** Whether the first load after entering the mode has finished. */
  initialized: boolean;
  viewKind: InvestViewKind;
  instruments: InvestInstrument[];
  sectors: InvestSector[];
  /** The scope of the middle column (stock:<code> / sector:<code>). */
  selectedScope: string | null;
  /** The display name of the selected scope (list rows carry it). */
  selectedTitle: string;
  /** The query of the left panel's search box (client-side last-mile filter). */
  query: string;
  /** The documents of the selected scope = the notes column's tab group. */
  docs: InvestDocInfo[];
  /** The active document (absolute path = the app's currentFile). */
  activeDocAbs: string | null;
  /** The visible bar period of the middle chart. */
  period: InvestPeriod;
  /** Monotone generation of bar loads; a stale reply is dropped. */
  barsGeneration: number;
  bars: import("./types").InvestBar[];
  barsLoading: boolean;
  /** Detail tab data of the selected scope, generation-guarded like bars. */
  detailGeneration: number;
  snapshot: InvestSnapshot | null;
  fundFlow: InvestFundFlowDay[];
  financials: InvestFinancial[];
  events: InvestEvent[];
  skill: InvestSkillBundle | null;
  busy: string | null;
  toast: string | null;
  /** H6: bumped after each completed backtest run so the BacktestTab can
   * reload without a scope switch (the run writes through the store, the
   * tab only subscribes). */
  backtestTick: number;
  /** The data-import dialog (A7: the import feature finally has an entry). */
  importOpen: boolean;
  /** The left column hosts either the instrument list or the agent (B9: the
   * chart stays put in the middle — the analyst reads the chart while the
   * agent answers). */
  leftPane: "list" | "agent";
  /** The detail tab per scope (B12: switching scopes remembers the tab). */
  detailTabByScope: Record<string, string>;
  /** The notes tab per scope (B12: the right column does the same). */
  docByScope: Record<string, string>;
  /** Bumped by ⌘⌥P: the knowledge tab focuses its search box on change. */
  knowledgeFocusTick: number;
  /** E23: price/prev_close per code, one query for the whole list. */
  quoteByCode: Record<string, { price: number; prev_close: number | null }>;

  initialize: () => Promise<void>;
  setViewKind: (kind: InvestViewKind) => void;
  setQuery: (query: string) => void;
  /** C16: the keyboard sprite appends a char; functional so a burst of
   * keystrokes cannot each start from the same stale closure value. */
  appendQuery: (ch: string) => void;
  selectScope: (scope: string, title: string) => Promise<void>;
  cycleInstrument: (delta: 1 | -1) => Promise<void>;
  /** C15: bare ↑/↓ move within the filtered list. */
  moveListCursor: (delta: 1 | -1) => Promise<void>;
  /** C15: Enter opens the current scope's remembered document. */
  openCurrentDoc: () => void;
  setPeriod: (period: InvestPeriod) => Promise<void>;
  openDoc: (relPath: string) => void;
  setDetailTab: (scope: string, tab: string) => void;
  /** B10: a search hit jumps to its scope and opens its document. */
  openSearchHit: (hit: InvestSearchHit) => Promise<void>;
  /** ⌘⌥P: the detail tabs land on knowledge and its search box focuses. */
  focusKnowledge: () => void;
  refreshDocs: () => Promise<void>;
  toggleWatch: (code: string) => Promise<void>;
  runIngest: () => Promise<void>;
  /** B14: re-fetch the live snapshot of the current stock scope. */
  refreshSnapshot: () => Promise<void>;
  refreshSkill: () => Promise<void>;
  /** Replays one rule-based forecast for the current stock scope. */
  runForecastReplay: () => Promise<void>;
  /** Runs one ma_cross baseline backtest for the current stock scope. */
  runBacktest: () => Promise<void>;
  clearToast: () => void;
  openImport: () => void;
  closeImport: () => void;
  setLeftPane: (pane: "list" | "agent") => void;
  /** Re-reads the instrument/sector lists after an import changed the library. */
  reloadAfterImport: () => Promise<void>;
  /** H6: the import orchestration — write, reload the lists, jump to the
   * imported scope so the chart shows the new bars immediately. The component
   * only parses and renders. */
  applyImport: (
    payload: import("@/lib/tauri").InvestImportInput,
  ) => Promise<Record<string, number>>;
  /** E23: reloads the list's price/prev_close summary. */
  reloadQuotes: () => Promise<void>;
  /** G27: appends the current snapshot as a Markdown table to the scope's
   * open document (the editor's autosave persists it). */
  insertSnapshotToNote: () => void;
}

let generation = 0;

/** The generation a fresh load starts at (monotone; stale replies compare lower). */
function nextGeneration(): number {
  generation += 1;
  return generation;
}

export const useInvestStore = create<InvestState>((set, get) => ({
  initialized: false,
  viewKind: "stocks",
  instruments: [],
  sectors: [],
  selectedScope: null,
  selectedTitle: "",
  query: "",
  docs: [],
  activeDocAbs: null,
  period: "1d",
  barsGeneration: 0,
  bars: [],
  barsLoading: false,
  detailGeneration: 0,
  snapshot: null,
  fundFlow: [],
  financials: [],
  events: [],
  skill: null,
  busy: null,
  toast: null,
  backtestTick: 0,
  importOpen: false,
  leftPane: "list",
  detailTabByScope: {},
  docByScope: {},
  knowledgeFocusTick: 0,
  quoteByCode: {},

  initialize: async () => {
    if (get().initialized) return;
    set({ initialized: true });
    try {
      const [instruments, sectors] = await Promise.all([
        investApi.listInstruments("", false, 500),
        investApi.listSectors(),
      ]);
      set({ instruments, sectors });
    } catch (e) {
      set({ toast: `行情库加载失败: ${String(e)}`, initialized: false });
      return;
    }
    // E23: the list rows' price/change columns read from one overview query.
    void get().reloadQuotes();
    // Land on the first watched instrument, else the first row of the list.
    const { instruments } = get();
    const first = instruments.find((i) => i.watch) ?? instruments[0];
    if (first) await get().selectScope(scopeFor("stock", first.code), first.name);
  },

  setViewKind: (kind) => set({ viewKind: kind }),
  setQuery: (query) => set({ query }),
  appendQuery: (ch) => set((s) => ({ query: s.query + ch })),

  selectScope: async (scope, title) => {
    const gen = nextGeneration();
    set({
      selectedScope: scope,
      selectedTitle: title,
      barsGeneration: gen,
      detailGeneration: gen,
      barsLoading: true,
      bars: [],
      snapshot: null,
      fundFlow: [],
      financials: [],
      events: [],
      skill: null,
      docs: [],
      activeDocAbs: null,
    });
    // The scope's document skeleton is created on first visit and the tab
    // group is loaded from it.
    try {
      const docs = await investApi.ensureScopeDocs(scope, title);
      // A later selection already landed: drop this reply (single-writer).
      if (get().selectedScope !== scope) return;
      set({ docs });
      // B12: restore the doc tab remembered for this scope, falling back to
      // the first doc when nothing (or a since-deleted doc) was remembered.
      const remembered = get().docByScope[scope];
      const doc = docs.find((d) => d.rel_path === remembered) ?? docs[0];
      if (doc) get().openDoc(doc.rel_path);
    } catch (e) {
      set({ toast: `文档目录创建失败: ${String(e)}` });
    }
    await Promise.all([loadBars(gen), loadDetail(gen, scope)]);
    await get().refreshSkill();
  },

  cycleInstrument: async (delta) => {
    const { viewKind, instruments, sectors, selectedScope } = get();
    if (viewKind === "stocks") {
      const index = instruments.findIndex((i) => scopeFor("stock", i.code) === selectedScope);
      const next = instruments[cycleIndex(index, instruments.length, delta)];
      if (next) await get().selectScope(scopeFor("stock", next.code), next.name);
    } else {
      const index = sectors.findIndex((s) => scopeFor("sector", s.code) === selectedScope);
      const next = sectors[cycleIndex(index, sectors.length, delta)];
      if (next) await get().selectScope(scopeFor("sector", next.code), next.name);
    }
  },

  /** C15: bare ↑/↓ walk the *filtered* list (the search box keeps its text —
   * blind test B P2-15: the chord used to jump across unfiltered rows). The
   * walk order matches the visual order (E23: watched first). When nothing is
   * selected yet, the first row wins. */
  moveListCursor: async (delta) => {
    const { viewKind, instruments, sectors, query, selectedScope } = get();
    if (viewKind === "stocks") {
      const filtered = filterInstruments(instruments, query);
      const ordered = [...filtered.filter((i) => i.watch), ...filtered.filter((i) => !i.watch)];
      if (ordered.length === 0) return;
      const index = ordered.findIndex((i) => scopeFor("stock", i.code) === selectedScope);
      const next = ordered[cycleIndex(index, ordered.length, delta)];
      if (next) await get().selectScope(scopeFor("stock", next.code), next.name);
    } else {
      const filtered = sectors.filter((s) => s.name.includes(query.trim()));
      if (filtered.length === 0) return;
      const index = filtered.findIndex((s) => scopeFor("sector", s.code) === selectedScope);
      const next = filtered[cycleIndex(index, filtered.length, delta)];
      if (next) await get().selectScope(scopeFor("sector", next.code), next.name);
    }
  },

  /** C15: Enter opens the scope's remembered document (the doc tab is the
   * same one selectScope restores). */
  openCurrentDoc: () => {
    const { docs, selectedScope } = get();
    if (!selectedScope) return;
    const remembered = get().docByScope[selectedScope];
    const doc = docs.find((d) => d.rel_path === remembered) ?? docs[0];
    if (doc) get().openDoc(doc.rel_path);
  },

  setPeriod: async (period) => {
    set({ period });
    await loadBars(get().barsGeneration);
  },

  openDoc: (relPath) => {
    const vault = useAppStore.getState().vaultPath;
    if (!vault) return;
    // rel_path is relative to `.bnote/invest/` (the Rust docs::register_file
    // contract); vaultDotPath owns the `.bnote/` prefix — never re-add it.
    const abs = vaultDotPath(vault, `invest/${relPath}`);
    const scope = get().selectedScope;
    // B12: the doc tab is remembered per scope (single writer: this store).
    if (scope) {
      set((s) => ({ activeDocAbs: abs, docByScope: { ...s.docByScope, [scope]: relPath } }));
    } else {
      set({ activeDocAbs: abs });
    }
    useAppStore.getState().openFile(abs);
  },

  setDetailTab: (scope, tab) => {
    set((s) => ({ detailTabByScope: { ...s.detailTabByScope, [scope]: tab } }));
  },

  openSearchHit: async (hit) => {
    // The hit carries its own scope: jump there first (selectScope restores
    // the remembered doc tab), then open the hit's document on top. Non-scope
    // hits (skill version files) have no scope directory — just open the file.
    const parsed = parseScope(hit.scope);
    if (parsed && get().selectedScope !== hit.scope) {
      const name =
        get().instruments.find((i) => i.code === parsed.code)?.name ??
        get().sectors.find((s) => s.code === parsed.code)?.name ??
        hit.title;
      await get().selectScope(hit.scope, name);
    }
    get().openDoc(hit.rel_path);
  },

  focusKnowledge: () => {
    const scope = get().selectedScope;
    set((s) => ({
      knowledgeFocusTick: s.knowledgeFocusTick + 1,
      ...(scope ? { detailTabByScope: { ...s.detailTabByScope, [scope]: "knowledge" } } : {}),
    }));
  },

  refreshDocs: async () => {
    const scope = get().selectedScope;
    if (!scope) return;
    try {
      const docs = await investApi.listDocs(scope);
      if (get().selectedScope !== scope) return;
      set({ docs });
    } catch (e) {
      set({ toast: `文档列表刷新失败: ${String(e)}` });
    }
  },

  toggleWatch: async (code) => {
    // Toggle semantics (blind-test P1: the star hardcoded `true` and could
    // never unwatch): flip the current value, update optimistically, roll
    // back when the write fails.
    const current = get().instruments.find((i) => i.code === code);
    if (!current) return;
    const next = !current.watch;
    set({
      instruments: get().instruments.map((i) => (i.code === code ? { ...i, watch: next } : i)),
    });
    try {
      const watch = await investApi.setWatch(
        marketOf(`stock:${code}`, get().instruments),
        code,
        next,
      );
      if (watch !== next) {
        set({ instruments: get().instruments.map((i) => (i.code === code ? { ...i, watch } : i)) });
      }
    } catch (e) {
      set({
        instruments: get().instruments.map((i) =>
          i.code === code ? { ...i, watch: current.watch } : i,
        ),
        toast: `自选切换失败: ${String(e)}`,
      });
    }
  },

  runIngest: async () => {
    set({ busy: "ingest" });
    try {
      const result = await investApi.ingestRun();
      const stored = result.sources.reduce((n, s) => n + s.stored, 0);
      // F25/H6: a failure names the source in plain words — no URL or status
      // payload pasted at the user (the formatter is unit-tested).
      const failures = result.sources
        .filter((s) => s.error)
        .map((s) => ({ source_id: s.source_id, error: s.error ?? "" }));
      set({ toast: ingestToast(stored, failures) });
      const scope = get().selectedScope;
      if (scope) await loadDetail(get().detailGeneration, scope);
    } catch (e) {
      set({ toast: `摄取失败: ${String(e)}` });
    } finally {
      set({ busy: null });
    }
  },

  refreshSkill: async () => {
    const scope = get().selectedScope;
    if (!scope || !parseScope(scope)) return;
    try {
      const skill = await investApi.readSkill(scope);
      if (get().selectedScope === scope) set({ skill });
    } catch {
      // The skill scaffold needs a vault; an empty workspace has none.
      set({ skill: null });
    }
  },

  /** B14: re-fetches the live snapshot with loading state + a toast that
   * either names the reason or echoes the fresh fetched_at timestamp. */
  refreshSnapshot: async () => {
    const scope = get().selectedScope;
    if (!scope?.startsWith("stock:")) return;
    set({ busy: "snapshot" });
    try {
      await investApi.snapshotRefresh(marketOf(scope, get().instruments), scope.slice(6));
      await loadDetail(get().detailGeneration, scope);
      const fetchedAt = get().snapshot?.fetched_at;
      set({
        toast: fetchedAt
          ? `快照已刷新 (${new Date(fetchedAt * 1000).toLocaleTimeString("zh-CN")})`
          : "快照已刷新",
        busy: null,
      });
    } catch (e) {
      set({ toast: `快照刷新失败: ${String(e)}`, busy: null });
    }
  },

  runForecastReplay: async () => {
    const state = get();
    if (!state.selectedScope?.startsWith("stock:")) {
      set({ toast: "预测回放只对标的生效（先切换到一个个股）" });
      return;
    }
    const code = state.selectedScope.slice("stock:".length);
    set({ busy: "forecast" });
    try {
      // as_of defaults to the backend's anchor: the last settleable point in
      // the local data (a wall-clock date on a stale dataset always errored).
      const forecast = await investApi.forecastReplay(
        state.selectedScope,
        marketOf(state.selectedScope, get().instruments),
        code,
        undefined,
      );
      set({
        toast: `已回放预测: ${forecast.direction} ${((forecast.expected_move ?? 0) * 100).toFixed(1)}%（截至 ${forecast.as_of}）`,
      });
    } catch (e) {
      set({ toast: `预测回放失败: ${String(e)}` });
    } finally {
      set({ busy: null });
    }
  },

  runBacktest: async () => {
    const state = get();
    if (!state.selectedScope?.startsWith("stock:")) {
      set({ toast: "回测只对标的生效（先切换到一个个股）" });
      return;
    }
    // H6 blind test: the run is a long operation — in-flight clicks must be
    // a no-op or one test run produces four identical rows.
    if (state.busy === "backtest") return;
    const code = state.selectedScope.slice("stock:".length);
    set({ busy: "backtest" });
    try {
      const run = await investApi.backtestRun(
        state.selectedScope,
        marketOf(state.selectedScope, get().instruments),
        code,
        "ma_cross",
      );
      set({
        toast: `回测完成: 总收益 ${(run.metrics.total_return * 100).toFixed(1)}%, 最大回撤 ${(run.metrics.max_drawdown * 100).toFixed(1)}%, ${run.metrics.trade_count} 笔交易`,
        backtestTick: get().backtestTick + 1,
      });
    } catch (e) {
      set({ toast: `回测失败: ${String(e)}` });
    } finally {
      set({ busy: null });
    }
  },

  clearToast: () => {
    if (get().toast !== null) set({ toast: null });
  },

  openImport: () => set({ importOpen: true }),
  setLeftPane: (pane) => set({ leftPane: pane }),
  closeImport: () => set({ importOpen: false }),

  reloadAfterImport: async () => {
    try {
      const [instruments, sectors] = await Promise.all([
        investApi.listInstruments("", false, 500),
        investApi.listSectors(),
      ]);
      set({ instruments, sectors });
    } catch {
      // The import itself succeeded; the refresh failing shows the existing
      // toast path on the next manual action instead of blocking here.
    }
    void get().reloadQuotes();
  },

  applyImport: async (payload) => {
    const counts = await investApi.importData(payload);
    await get().reloadAfterImport();
    // The import only changed the DB — the chart keeps its empty overlay
    // until something reloads the current scope. Jump to the imported scope
    // so the new bars land on screen immediately (blind test).
    const target = importTargetScope(
      { code: payload.code, bar_kind: payload.barKind, instruments: payload.instruments },
      get().instruments,
      get().sectors,
    );
    if (target) await get().selectScope(target.scope, target.title);
    return counts;
  },

  /** E23: reloads the list's quote summary (price/prev_close per code). */
  reloadQuotes: async () => {
    try {
      const quotes = await investApi.quoteOverview();
      const byCode: Record<string, { price: number; prev_close: number | null }> = {};
      for (const q of quotes) {
        if (q.price != null) byCode[q.code] = { price: q.price, prev_close: q.prev_close };
      }
      set({ quoteByCode: byCode });
    } catch {
      // The list still works without the price columns (all "—").
    }
  },

  insertSnapshotToNote: () => {
    const { snapshot, fundFlow, selectedTitle, selectedScope, activeDocAbs } = get();
    if (!snapshot || !selectedScope) {
      set({ toast: "没有快照可插入" });
      return;
    }
    if (!activeDocAbs) {
      set({ toast: "先打开该标的的文档（右栏）再插入" });
      return;
    }
    const view = findEditorFor(activeDocAbs);
    if (!view) {
      set({ toast: "文档编辑器未就绪" });
      return;
    }
    const code = parseScope(selectedScope)?.code ?? "";
    const md = buildSnapshotMarkdown(selectedTitle || code, code, snapshot, fundFlow);
    view.dispatch({ changes: { from: view.state.doc.length, insert: `\n\n${md}\n` } });
    set({ toast: "快照表格已插入当前文档" });
  },
}));

/** Loads the bars of the current selection; stale generations never write. */
async function loadBars(gen: number) {
  const { selectedScope, period } = useInvestStore.getState();
  if (!selectedScope) return;
  useInvestStore.setState({ barsLoading: true });
  try {
    const parsed = parseScope(selectedScope);
    const bars = parsed
      ? parsed.kind === "stock"
        ? await investApi.klineQuery(
            marketOf(selectedScope, useInvestStore.getState().instruments),
            parsed.code,
            { period, limit: 500 },
          )
        : await investApi.sectorBars(parsed.code, { period, limit: 500 })
      : [];
    const state = useInvestStore.getState();
    // Single writer: only the newest request's reply may land.
    if (state.barsGeneration !== gen) return;
    useInvestStore.setState({ bars, barsLoading: false });
  } catch (e) {
    if (useInvestStore.getState().barsGeneration === gen) {
      useInvestStore.setState({ barsLoading: false, toast: `K 线加载失败: ${String(e)}` });
    }
  }
}

/** H1: the market of a scope, resolved from the instrument master. The scope
 * string carries no market prefix (codes are unambiguous across cn/hk/us:
 * 6-digit cn / 5-digit hk / alphabetic us), so the master is the single
 * source of truth; sectors are always cn. */
export function marketOf(scope: string, instruments: InvestInstrument[]): string {
  const parsed = parseScope(scope);
  if (!parsed || parsed.kind !== "stock") return "cn";
  return instruments.find((i) => i.code === parsed.code)?.market ?? "cn";
}

/** Loads the detail tabs (snapshot / flow / financials / events). */
async function loadDetail(gen: number, scope: string) {
  const parsed = parseScope(scope);
  try {
    if (parsed?.kind === "stock") {
      const [snapshot, fundFlow, financials, events] = await Promise.all([
        investApi.snapshot(marketOf(scope, useInvestStore.getState().instruments), parsed.code),
        investApi.fundFlow(marketOf(scope, useInvestStore.getState().instruments), parsed.code, 10),
        investApi.financials(
          marketOf(scope, useInvestStore.getState().instruments),
          parsed.code,
          6,
        ),
        investApi.events(scope, 50),
      ]);
      const state = useInvestStore.getState();
      if (state.detailGeneration !== gen) return;
      useInvestStore.setState({ snapshot, fundFlow, financials, events });
    } else {
      const events = await investApi.events(scope, 50);
      const state = useInvestStore.getState();
      if (state.detailGeneration !== gen) return;
      useInvestStore.setState({ events, snapshot: null, fundFlow: [], financials: [] });
    }
  } catch (e) {
    if (useInvestStore.getState().detailGeneration === gen) {
      useInvestStore.setState({ toast: `详情加载失败: ${String(e)}` });
    }
  }
}

/** Re-runs the current detail load (after an ingest or a manual refresh). */
export async function refreshDetail() {
  const state = useInvestStore.getState();
  if (!state.selectedScope) return;
  await loadDetail(state.detailGeneration, state.selectedScope);
}
