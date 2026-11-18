import { useEffect, useRef } from "react";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { EditorPane } from "@/components/EditorPane";
import { JsonFilePane } from "@/components/JsonFilePane";
import { startSplitDrag } from "@/components/splitDrag";
import { InstrumentList } from "@/components/invest/InstrumentList";
import { KlinePane } from "@/components/invest/KlinePane";
import { DetailTabs, SECTOR_TABS, STOCK_TABS } from "@/components/invest/DetailTabs";
import { DocTabs } from "@/components/invest/DocTabs";
import { ImportPanel } from "@/components/invest/ImportPanel";
import { setActiveKeyRegion } from "@/commands/globalKeys";
import { useAppStore } from "@/state/appStore";
import { useInvestStore } from "@/invest/store";
import {
  cycleIndex,
  leftDividerWidths,
  middleDividerWidth,
  normalizeInvestWidth,
  scopeFor,
  DEFAULT_INVEST_SIDE_WIDTH,
  DEFAULT_INVEST_CONTENT_WIDTH,
} from "@/invest/layoutModel";
import { isJsonPath } from "@/lib/path";

/**
 * Invest-mode three-column layout: instrument list (left) | K-line + details
 * or the agent (middle) | notes (right), with draggable dividers on the
 * middle column's edges. The column-width model is the study layout's
 * (columns own the widths in px; the notes column takes the rest; drags write
 * CSS variables per frame and commit once on pointerup).
 *
 * The middle column hosts either the chart+details pane or the AgentPanel,
 * driven by the app store's `mainColumn` ("agent" | "content"). Unlike study
 * mode there is no order swap: the left column is the instrument list in
 * both placements, so focusing the agent only replaces the middle column's
 * content.
 */
export function InvestLayout() {
  const sideWidth = useAppStore((s) => s.settings.investSideWidth);
  const contentWidth = useAppStore((s) => s.settings.investContentWidth);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const currentFile = useAppStore((s) => s.currentFile);
  const leftPane = useInvestStore((s) => s.leftPane);
  const setLeftPane = useInvestStore((s) => s.setLeftPane);
  const selectedTitle = useInvestStore((s) => s.selectedTitle);
  const selectedScope = useInvestStore((s) => s.selectedScope);
  const refreshSnapshot = useInvestStore((s) => s.refreshSnapshot);
  const initialize = useInvestStore((s) => s.initialize);
  const toast = useInvestStore((s) => s.toast);
  const clearToast = useInvestStore((s) => s.clearToast);
  const busy = useInvestStore((s) => s.busy);
  const importOpen = useInvestStore((s) => s.importOpen);
  const openImport = useInvestStore((s) => s.openImport);
  const runIngest = useInvestStore((s) => s.runIngest);
  const hostRef = useRef<HTMLDivElement>(null);

  // First entry into the mode loads the local library and lands on the first
  // watched instrument (idempotent — re-entry is a no-op).
  useEffect(() => {
    // Entering the mode claims the invest region for the keyboard (the same
    // claim the projects view makes on mount): otherwise the fallback order
    // would hand the chords to the notes column until the user happens to
    // click an invest pane first, and ⌘⌥←/→ would silently do nothing.
    setActiveKeyRegion("invest");
    void initialize();
  }, [initialize]);

  // The command layer signals through window events (the same split of duties
  // as the project commands): the store owns the state, this layout — the only
  // place mounted in invest mode — runs the actions.
  useEffect(() => {
    const store = () => useInvestStore.getState();
    const onCycle = (e: Event) => {
      const delta = (e as CustomEvent<number>).detail === -1 ? -1 : 1;
      void store().cycleInstrument(delta);
    };
    const onDoc = (e: Event) => {
      const delta = (e as CustomEvent<number>).detail === -1 ? -1 : 1;
      const { docs, activeDocAbs } = store();
      if (docs.length === 0) return;
      const index = docs.findIndex((d) => activeDocAbs?.endsWith(d.rel_path));
      const next = docs[cycleIndex(index < 0 ? 0 : index, docs.length, delta)];
      if (next) store().openDoc(next.rel_path);
    };
    const onToggleView = () => {
      const state = store();
      const nextKind = state.viewKind === "stocks" ? "sectors" : "stocks";
      state.setViewKind(nextKind);
      // Land on the first row of the new view so the middle column always
      // shows something.
      const first =
        nextKind === "stocks"
          ? (state.instruments.find((i) => i.watch) ?? state.instruments[0])
          : state.sectors[0];
      if (first) {
        const scope =
          nextKind === "stocks" ? scopeFor("stock", first.code) : scopeFor("sector", first.code);
        void state.selectScope(scope, nextKind === "stocks" ? first.name : first.name);
      }
    };
    const onPeriod = (e: Event) => {
      const period = (e as CustomEvent<string>).detail;
      if (period === "1d" || period === "1w" || period === "1M") void store().setPeriod(period);
    };
    const onForecast = () => void store().runForecastReplay();
    const onBacktest = () => void store().runBacktest();
    const onImport = () => store().openImport();
    // B9: the left column holds both the list and the agent panel; the chords
    // (⌘⌥R list / ⌘⌥A analysis) flip between them without touching the middle.
    const onFocusList = () => store().setLeftPane("list");
    const onFocusAgent = () => store().setLeftPane("agent");
    // ⌘⌥P: land the detail tabs on knowledge and focus its search box.
    const onKnowledge = () => store().focusKnowledge();
    // C15: bare ↑/↓ walk the filtered list; Enter opens the scope's document.
    const onListMove = (e: Event) => {
      const delta = (e as CustomEvent<number>).detail === -1 ? -1 : 1;
      void store().moveListCursor(delta);
    };
    const onOpenDoc = () => store().openCurrentDoc();
    // C18: ⌘⌥1..7 land on the Nth tab of the current scope kind's tab set.
    const onDetailTab = (e: Event) => {
      const n = (e as CustomEvent<number>).detail;
      const { selectedScope } = store();
      if (!selectedScope) return;
      const tabs = selectedScope.startsWith("stock:") ? STOCK_TABS : SECTOR_TABS;
      const tab = tabs[(n ?? 1) - 1];
      if (tab) store().setDetailTab(selectedScope, tab);
    };
    window.addEventListener("bnote:invest-cycle", onCycle);
    window.addEventListener("bnote:invest-doc", onDoc);
    window.addEventListener("bnote:invest-toggle-view", onToggleView);
    window.addEventListener("bnote:invest-period", onPeriod);
    window.addEventListener("bnote:invest-forecast", onForecast);
    window.addEventListener("bnote:invest-backtest", onBacktest);
    window.addEventListener("bnote:invest-import", onImport);
    window.addEventListener("bnote:invest-focus-list", onFocusList);
    window.addEventListener("bnote:invest-focus-agent", onFocusAgent);
    window.addEventListener("bnote:invest-knowledge", onKnowledge);
    window.addEventListener("bnote:invest-list-move", onListMove);
    window.addEventListener("bnote:invest-open-doc", onOpenDoc);
    window.addEventListener("bnote:invest-detail-tab", onDetailTab);
    return () => {
      window.removeEventListener("bnote:invest-cycle", onCycle);
      window.removeEventListener("bnote:invest-doc", onDoc);
      window.removeEventListener("bnote:invest-toggle-view", onToggleView);
      window.removeEventListener("bnote:invest-period", onPeriod);
      window.removeEventListener("bnote:invest-forecast", onForecast);
      window.removeEventListener("bnote:invest-backtest", onBacktest);
      window.removeEventListener("bnote:invest-import", onImport);
      window.removeEventListener("bnote:invest-focus-list", onFocusList);
      window.removeEventListener("bnote:invest-focus-agent", onFocusAgent);
      window.removeEventListener("bnote:invest-knowledge", onKnowledge);
      window.removeEventListener("bnote:invest-list-move", onListMove);
      window.removeEventListener("bnote:invest-open-doc", onOpenDoc);
      window.removeEventListener("bnote:invest-detail-tab", onDetailTab);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(clearToast, 4000);
    return () => clearTimeout(timer);
  }, [toast, clearToast]);

  function startDrag(
    event: React.PointerEvent<HTMLDivElement>,
    variables: string[],
    stored: Record<string, number>,
    compute: (dx: number) => Record<string, number>,
    commit: (values: Record<string, number>) => void,
  ) {
    startSplitDrag({ event, host: hostRef.current, variables, stored, compute, commit });
  }

  function startSideDrag(event: React.PointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const left = host.querySelector(".invest-left");
    const middle = host.querySelector(".invest-center");
    if (!left || !middle) return;
    const leftWidth = left.getBoundingClientRect().width;
    const middleWidth = middle.getBoundingClientRect().width;
    startDrag(
      event,
      ["--invest-side-src", "--invest-content-src"],
      { "--invest-side-src": sideWidth, "--invest-content-src": contentWidth },
      (dx) => {
        const widths = leftDividerWidths({ leftWidth, middleWidth, hostWidth: hostRect.width }, dx);
        return { "--invest-side-src": widths.left, "--invest-content-src": widths.middle };
      },
      (values) =>
        patchSettings({
          investSideWidth: values["--invest-side-src"],
          investContentWidth: values["--invest-content-src"],
        }),
    );
  }

  function startContentDrag(event: React.PointerEvent<HTMLDivElement>) {
    const host = hostRef.current;
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const middle = host.querySelector(".invest-center");
    if (!middle) return;
    const middleRect = middle.getBoundingClientRect();
    const subjectLeft = middleRect.left - hostRect.left;
    startDrag(
      event,
      ["--invest-content-src"],
      { "--invest-content-src": contentWidth },
      (dx) => ({
        "--invest-content-src": middleDividerWidth(
          {
            middleLeft: subjectLeft,
            middleWidth: middleRect.width,
            hostWidth: hostRect.width,
          },
          dx,
        ),
      }),
      (values) => patchSettings({ investContentWidth: values["--invest-content-src"] }),
    );
  }

  function resetSide() {
    patchSettings({
      investSideWidth: normalizeInvestWidth(DEFAULT_INVEST_SIDE_WIDTH, window.innerWidth),
    });
  }

  function resetMiddle() {
    patchSettings({
      investContentWidth: normalizeInvestWidth(DEFAULT_INVEST_CONTENT_WIDTH, window.innerWidth),
    });
  }

  return (
    <div
      className="study-layout invest-layout"
      ref={hostRef}
      style={
        {
          "--invest-side-src": `${sideWidth}px`,
          "--invest-content-src": `${contentWidth}px`,
        } as React.CSSProperties
      }
    >
      <div className="study-left invest-left">
        <div className="invest-left-head" data-tauri-drag-region="deep">
          <button
            className={`invest-view-btn${leftPane === "list" ? " active" : ""}`}
            onClick={() => setLeftPane("list")}
            title="标的与板块列表"
          >
            列表
          </button>
          <button
            className={`invest-view-btn${leftPane === "agent" ? " active" : ""}`}
            onClick={() => setLeftPane("agent")}
            title="AI 分析当前标的 (⌘⌥A)"
          >
            分析
          </button>
          <span className="invest-left-spacer" />
          <button
            className="invest-ingest-btn"
            title="导入标的 / K 线 / 财务 / 资金流（akshare 导出的 JSON）"
            onClick={openImport}
          >
            导入
          </button>
          <button
            className="invest-ingest-btn"
            title="从已配置的信息源抓取今日热点(YAML: .bnote/invest/sources.yaml)"
            disabled={busy === "ingest"}
            onClick={() => void runIngest()}
          >
            {busy === "ingest" ? "摄取中…" : "摄取"}
          </button>
        </div>
        {/* B9: the agent lives in the LEFT column (the original brief and the
           analyst's report both asked for it) — the middle column keeps the
           chart + details permanently, so switching to the analysis pane no
           longer makes every detail tab vanish. */}
        {leftPane === "agent" ? <AgentPanel /> : <InstrumentList />}
      </div>
      <div
        className="study-resizer resizer-agent"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整左栏宽度"
        title="拖动调整左栏宽度,双击恢复默认"
        onPointerDown={startSideDrag}
        onDoubleClick={resetSide}
      />
      <div className="invest-center content-pane">
        <div className="invest-center-head" data-tauri-drag-region="deep">
          {/* Subscribed, not getState(): a render-time read would freeze the
             title at whatever was selected on mount. */}
          <span className="invest-center-title">{selectedTitle || "未选择标的"}</span>
          {/* B14: the snapshot refresh lives in the header action slot, not in
             the tab row (blind test F P2-5), with loading + result toast. */}
          {selectedScope?.startsWith("stock:") ? (
            <button
              className="invest-center-refresh"
              disabled={busy === "snapshot"}
              title="重新抓取当前标的的实时快照（行情源可在 .bnote/invest/quotes.yaml 配置）"
              onClick={() => void refreshSnapshot()}
            >
              {busy === "snapshot" ? "刷新中…" : "刷新快照"}
            </button>
          ) : null}
        </div>
        <div className="invest-center-content">
          {/* The market pane claims the invest region: the chart has no
             focusable element of its own, so without the attribute a click
             on the chart never hands the keyboard to the invest bindings
             and the ⌘⌥←/→ instrument switch dies after it. */}
          <div className="invest-market" data-key-region="invest">
            <KlinePane />
            <DetailTabs />
          </div>
        </div>
      </div>
      <div
        className="study-resizer resizer-content"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整中间栏宽度"
        title="拖动调整中间栏宽度,双击恢复默认"
        onPointerDown={startContentDrag}
        onDoubleClick={resetMiddle}
      />
      <div className="study-right">
        <div className="study-notes-head" data-tauri-drag-region="deep">
          <span className="study-notes-title">
            {currentFile ? fileNameOf(currentFile) : "笔记"}
          </span>
        </div>
        <DocTabs />
        {isJsonPath(currentFile) ? <JsonFilePane /> : <EditorPane />}
      </div>
      {toast ? <div className="invest-toast">{toast}</div> : null}
      {importOpen ? <ImportPanel /> : null}
    </div>
  );
}

function fileNameOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(md|markdown|txt)$/i, "");
}
