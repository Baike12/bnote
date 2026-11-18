import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The invest store through the fake IPC boundary: the real store logic runs,
 * only `investApi` and the app store's vault handle are in-memory. Locks the
 * single-writer discipline (stale generations never land), the cycle switch,
 * the stock-only guards, and the toast aggregation.
 */

const openFile = vi.hoisted(() => vi.fn());

vi.mock("@/state/appStore", () => ({
  // The store only reads vaultPath and delegates file opening through the
  // app store (the editor owns currentFile).
  useAppStore: { getState: () => ({ vaultPath: "/vault", openFile }) },
}));

const investApi = vi.hoisted(() => ({
  listInstruments: vi.fn(),
  importData: vi.fn(),
  listSectors: vi.fn(),
  ensureScopeDocs: vi.fn(),
  listDocs: vi.fn(),
  klineQuery: vi.fn(),
  sectorBars: vi.fn(),
  snapshot: vi.fn(),
  fundFlow: vi.fn(),
  financials: vi.fn(),
  events: vi.fn(),
  readSkill: vi.fn(),
  setWatch: vi.fn(),
  ingestRun: vi.fn(),
  forecastReplay: vi.fn(),
  backtestRun: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, investApi };
});

import { useInvestStore } from "./store";
import type { InvestBar, InvestDocInfo, InvestInstrument, InvestSector } from "./types";

function instrument(code: string, watch = false): InvestInstrument {
  return {
    code,
    market: "cn",
    name: `股票${code}`,
    industry: "测试行业",
    sector_code: null,
    sector_sub: null,
    kind: "stock",
    note: "",
    watch,
  };
}

function doc(scope: string, code: string): InvestDocInfo {
  return {
    rel_path: `${scope.startsWith("stock:") ? "stocks" : "sectors"}/${code}/README.md`,
    scope,
    kind: "readme",
    title: "README",
    mtime: 1,
  };
}

function bar(code: string): InvestBar {
  return {
    ts: `2025-01-0${code.length}`,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 100,
    amount: 150,
    source: "import",
  };
}

const a = instrument("600519");
const b = instrument("000001", true);
const sectors: InvestSector[] = [
  { code: "801010", name: "农林牧渔", level: 1, parent: null, summary: "" },
];

beforeEach(() => {
  vi.clearAllMocks();
  openFile.mockClear();
  investApi.listInstruments.mockResolvedValue([a, b]);
  investApi.listSectors.mockResolvedValue(sectors);
  investApi.klineQuery.mockImplementation(async (_market: string, code: string) => [bar(code)]);
  investApi.sectorBars.mockResolvedValue([bar("801010")]);
  investApi.snapshot.mockResolvedValue(null);
  investApi.fundFlow.mockResolvedValue([]);
  investApi.financials.mockResolvedValue([]);
  investApi.events.mockResolvedValue([]);
  investApi.readSkill.mockResolvedValue({
    scope: "stock:600519",
    version: 1,
    skill: "s",
    memory: "m",
    versions: [],
  });
  investApi.setWatch.mockImplementation(
    async (_market: string, _code: string, watch: boolean) => watch,
  );
  investApi.ensureScopeDocs.mockImplementation(async (scope: string) => [
    doc(scope, scope.split(":")[1] ?? ""),
  ]);
  // Reset the shared store to its initial shape (the module instance is
  // process-wide; each test must start from the same baseline).
  useInvestStore.setState({
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
    detailGeneration: 0,
    bars: [],
    barsLoading: false,
    snapshot: null,
    fundFlow: [],
    financials: [],
    events: [],
    skill: null,
    busy: null,
    toast: null,
  });
});

describe("initialize", () => {
  it("lands on the first watched instrument and loads its scope", async () => {
    await useInvestStore.getState().initialize();

    const state = useInvestStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.selectedScope).toBe("stock:000001");
    expect(state.selectedTitle).toBe("股票000001");
    expect(investApi.ensureScopeDocs).toHaveBeenCalledWith("stock:000001", "股票000001");
    expect(investApi.klineQuery).toHaveBeenCalled();
    expect(state.bars).toHaveLength(1);
    expect(investApi.readSkill).toHaveBeenCalledWith("stock:000001");
  });

  it("is idempotent on re-entry", async () => {
    await useInvestStore.getState().initialize();
    await useInvestStore.getState().initialize();
    expect(investApi.listInstruments).toHaveBeenCalledTimes(1);
  });

  it("reports a failed library load and stays uninitialized", async () => {
    investApi.listInstruments.mockRejectedValue("boom");
    await useInvestStore.getState().initialize();
    const state = useInvestStore.getState();
    expect(state.initialized).toBe(false);
    expect(state.toast).toContain("行情库加载失败");
  });
});

describe("the single-writer generation discipline", () => {
  it("a stale scope's late replies never land", async () => {
    // A replies slowly; B replies fast. B's selection wins.
    investApi.klineQuery.mockImplementation(async (_m: string, code: string) => {
      await new Promise((r) => setTimeout(r, code === "600519" ? 40 : 5));
      return [bar(code)];
    });
    const first = useInvestStore.getState().selectScope("stock:600519", "A");
    const second = useInvestStore.getState().selectScope("stock:000001", "B");
    await Promise.all([first, second]);
    // Let the slow reply land after both selections resolved.
    await new Promise((r) => setTimeout(r, 60));

    const state = useInvestStore.getState();
    expect(state.selectedScope).toBe("stock:000001");
    expect(state.bars[0].ts).toBe(bar("000001").ts);
    expect(state.barsLoading).toBe(false);
    // The slow scope's docs were dropped too.
    expect(state.docs[0].scope).toBe("stock:000001");
  });
});

describe("cycleInstrument", () => {
  it("walks the visible view with wrap-around", async () => {
    await useInvestStore.getState().initialize(); // lands on 000001 (watched)
    await useInvestStore.getState().cycleInstrument(1);
    expect(useInvestStore.getState().selectedScope).toBe("stock:600519"); // wrapped to the head
    await useInvestStore.getState().cycleInstrument(-1);
    expect(useInvestStore.getState().selectedScope).toBe("stock:000001");
  });

  it("cycles the sectors view by its own list", async () => {
    useInvestStore.setState({ initialized: true, viewKind: "sectors", sectors });
    await useInvestStore.getState().cycleInstrument(1);
    expect(useInvestStore.getState().selectedScope).toBe("sector:801010");
    expect(investApi.sectorBars).toHaveBeenCalled();
  });
});

describe("setPeriod", () => {
  it("reloads the bars with the new period", async () => {
    await useInvestStore.getState().initialize();
    investApi.klineQuery.mockClear();
    await useInvestStore.getState().setPeriod("1w");
    expect(investApi.klineQuery).toHaveBeenCalledWith("cn", "000001", { period: "1w", limit: 500 });
    expect(useInvestStore.getState().period).toBe("1w");
  });
});

describe("the stock-only actions guard", () => {
  it("backtest refuses a sector scope without an IPC call", async () => {
    useInvestStore.setState({ selectedScope: "sector:801010" });
    await useInvestStore.getState().runBacktest();
    expect(investApi.backtestRun).not.toHaveBeenCalled();
    expect(useInvestStore.getState().toast).toContain("回测只对标的生效");
  });

  it("forecast replay refuses a sector scope without an IPC call", async () => {
    useInvestStore.setState({ selectedScope: "sector:801010" });
    await useInvestStore.getState().runForecastReplay();
    expect(investApi.forecastReplay).not.toHaveBeenCalled();
    expect(useInvestStore.getState().toast).toContain("预测回放只对标的生效");
  });
});

describe("backtest and forecast replay", () => {
  it("runs the ma_cross baseline for the current stock", async () => {
    useInvestStore.setState({
      selectedScope: "stock:600519",
      detailGeneration: 7,
    });
    investApi.backtestRun.mockResolvedValue({
      id: 1,
      scope: "stock:600519",
      skill_version: null,
      strategy: "ma_cross",
      start_date: "2025-01-01",
      end_date: "2025-02-01",
      metrics: {
        total_return: 0.12,
        annual_return: 0.3,
        sharpe: 1.2,
        max_drawdown: -0.05,
        win_rate: 0.6,
        profit_factor: 1.4,
        trade_count: 3,
      },
      equity: [],
      run_at: 1,
      trades: [],
    });
    await useInvestStore.getState().runBacktest();
    expect(investApi.backtestRun).toHaveBeenCalledWith("stock:600519", "cn", "600519", "ma_cross");
    expect(useInvestStore.getState().toast).toContain("总收益 12.0%");
    expect(useInvestStore.getState().busy).toBeNull();
  });

  it("surfaces a failed backtest instead of lying", async () => {
    useInvestStore.setState({ selectedScope: "stock:600519" });
    investApi.backtestRun.mockRejectedValue("no bars");
    await useInvestStore.getState().runBacktest();
    expect(useInvestStore.getState().toast).toContain("回测失败");
    expect(useInvestStore.getState().busy).toBeNull();
  });
});

describe("applyImport (the post-import orchestration)", () => {
  it("writes, reloads the lists, then jumps to the imported scope", async () => {
    useInvestStore.setState({ selectedScope: "stock:600519" });
    investApi.importData.mockResolvedValue({ bars: 320 });
    // The import carries a NEW instrument: the reloaded list must contain it
    // before the jump, or selectScope would address a scope the list lost.
    const imported = instrument("00700");
    investApi.listInstruments.mockResolvedValue([a, b, imported]);

    const counts = await useInvestStore.getState().applyImport({
      code: "00700",
      bars: [],
      instruments: [{ ...imported, market: "hk" }],
    });

    expect(counts).toEqual({ bars: 320 });
    // The imported scope is selected and the charts reloaded (not the stale
    // pre-import state the blind test shipped).
    expect(useInvestStore.getState().selectedScope).toBe("stock:00700");
    expect(useInvestStore.getState().selectedTitle).toBe("股票00700");
    expect(investApi.klineQuery).toHaveBeenCalled();
  });

  it("an import without a code reloads the lists but changes no selection", async () => {
    useInvestStore.setState({ selectedScope: "stock:600519" });
    investApi.importData.mockResolvedValue({ snapshot: 1 });
    await useInvestStore.getState().applyImport({ snapshot: {} as never });
    expect(useInvestStore.getState().selectedScope).toBe("stock:600519");
  });
});

describe("backtestTick (the list-refresh signal)", () => {
  it("bumps after a completed run so BacktestTab reloads in place", async () => {
    useInvestStore.setState({ selectedScope: "stock:600519" });
    investApi.backtestRun.mockResolvedValue({
      id: 1,
      scope: "stock:600519",
      skill_version: null,
      strategy: "ma_cross",
      start_date: "2025-01-01",
      end_date: "2025-02-01",
      metrics: {
        total_return: 0.1,
        annual_return: 0.2,
        sharpe: 1,
        max_drawdown: -0.05,
        win_rate: 0.5,
        profit_factor: 1.2,
        trade_count: 2,
      },
      equity: [],
      run_at: 1,
      trades: [],
    });
    const before = useInvestStore.getState().backtestTick;
    await useInvestStore.getState().runBacktest();
    expect(useInvestStore.getState().backtestTick).toBe(before + 1);
  });

  it("does not bump when the run failed", async () => {
    useInvestStore.setState({ selectedScope: "stock:600519" });
    investApi.backtestRun.mockRejectedValue("no bars");
    const before = useInvestStore.getState().backtestTick;
    await useInvestStore.getState().runBacktest();
    expect(useInvestStore.getState().backtestTick).toBe(before);
  });
});

describe("runIngest", () => {
  it("aggregates the per-source result into one toast and refreshes the detail", async () => {
    useInvestStore.setState({ selectedScope: "stock:600519", detailGeneration: 3 });
    investApi.ingestRun.mockResolvedValue({
      run_id: "r1",
      started_at: 1,
      sources: [
        { source_id: "s1", fetched: 5, stored: 3, skipped: 2, error: null },
        { source_id: "s2", fetched: 2, stored: 1, skipped: 1, error: "fetch failed" },
      ],
    });
    await useInvestStore.getState().runIngest();
    expect(useInvestStore.getState().toast).toContain("新增 4 条");
    // F25/H6: the failure names the unavailable source in plain words.
    expect(useInvestStore.getState().toast).toContain("1 个信息源暂不可用");
    expect(useInvestStore.getState().toast).toContain("s2 抓取失败");
    expect(useInvestStore.getState().busy).toBeNull();
  });

  it("reports a failed run", async () => {
    investApi.ingestRun.mockRejectedValue("offline");
    await useInvestStore.getState().runIngest();
    expect(useInvestStore.getState().toast).toContain("摄取失败");
    expect(useInvestStore.getState().busy).toBeNull();
  });
});

describe("toggleWatch", () => {
  it("applies the server answer to the matching row", async () => {
    useInvestStore.setState({ instruments: [a] });
    investApi.setWatch.mockResolvedValue(true);
    await useInvestStore.getState().toggleWatch("600519");
    expect(useInvestStore.getState().instruments[0].watch).toBe(true);
  });

  it("surfaces a failed toggle", async () => {
    useInvestStore.setState({ instruments: [a] });
    investApi.setWatch.mockRejectedValue("unknown code");
    await useInvestStore.getState().toggleWatch("600519");
    expect(useInvestStore.getState().toast).toContain("自选切换失败");
    expect(useInvestStore.getState().instruments[0].watch).toBe(false);
  });
});

describe("openDoc", () => {
  it("opens the scope document through the app store (the editor owns currentFile)", () => {
    useInvestStore.getState().openDoc("stocks/600519/README.md");
    expect(openFile).toHaveBeenCalledWith("/vault/.bnote/invest/stocks/600519/README.md");
    expect(useInvestStore.getState().activeDocAbs).toBe(
      "/vault/.bnote/invest/stocks/600519/README.md",
    );
  });
});

describe("refreshDocs", () => {
  it("re-reads the tab list for the current scope", async () => {
    useInvestStore.setState({ selectedScope: "stock:600519" });
    investApi.listDocs.mockResolvedValue([doc("stock:600519", "600519")]);
    await useInvestStore.getState().refreshDocs();
    expect(investApi.listDocs).toHaveBeenCalledWith("stock:600519");
    expect(useInvestStore.getState().docs[0].rel_path).toBe("stocks/600519/README.md");
  });

  it("is a no-op without a scope", async () => {
    await useInvestStore.getState().refreshDocs();
    expect(investApi.listDocs).not.toHaveBeenCalled();
  });
});

describe("refreshSkill", () => {
  it("reads the bundle of the current scope", async () => {
    useInvestStore.setState({ selectedScope: "stock:600519" });
    await useInvestStore.getState().refreshSkill();
    expect(useInvestStore.getState().skill?.version).toBe(1);
  });

  it("clears the skill when the scaffold is missing (no vault yet)", async () => {
    useInvestStore.setState({
      selectedScope: "stock:600519",
      skill: { scope: "stock:600519", version: 1, skill: "s", memory: "m", versions: [] },
    });
    investApi.readSkill.mockRejectedValue("NOT_FOUND");
    await useInvestStore.getState().refreshSkill();
    expect(useInvestStore.getState().skill).toBeNull();
  });
});

describe("clearToast", () => {
  it("clears a shown toast and stays idle when none is shown", () => {
    useInvestStore.setState({ toast: "hi" });
    useInvestStore.getState().clearToast();
    expect(useInvestStore.getState().toast).toBeNull();
    useInvestStore.getState().clearToast();
    expect(useInvestStore.getState().toast).toBeNull();
  });
});

describe("refreshDetail", () => {
  it("re-runs the detail load of the current scope", async () => {
    useInvestStore.setState({ selectedScope: "stock:600519", detailGeneration: 2 });
    investApi.events.mockResolvedValue([
      {
        id: 1,
        scope: "stock:600519",
        date: "2025-01-01",
        kind: "policy",
        title: "t",
        body: "",
        source: "",
        url: "",
        sentiment: null,
      },
    ]);
    const { refreshDetail } = await import("./store");
    await refreshDetail();
    expect(investApi.snapshot).toHaveBeenCalledWith("cn", "600519");
    expect(useInvestStore.getState().events).toHaveLength(1);
  });

  it("is a no-op without a scope", async () => {
    const { refreshDetail } = await import("./store");
    investApi.snapshot.mockClear();
    await refreshDetail();
    expect(investApi.snapshot).not.toHaveBeenCalled();
  });
});

describe("load failure", () => {
  it("a failed K-line load surfaces a toast and clears the spinner", async () => {
    investApi.klineQuery.mockRejectedValue("no bars");
    await useInvestStore.getState().selectScope("stock:600519", "A");
    const state = useInvestStore.getState();
    expect(state.barsLoading).toBe(false);
    expect(state.toast).toContain("加载失败");
  });

  it("a failed detail load surfaces a toast (the spinner belongs to the bars)", async () => {
    useInvestStore.setState({ selectedScope: "stock:600519", detailGeneration: 5 });
    investApi.snapshot.mockRejectedValue("no snapshot");
    const { refreshDetail } = await import("./store");
    await refreshDetail();
    expect(useInvestStore.getState().toast).toContain("详情加载失败");
  });
});
