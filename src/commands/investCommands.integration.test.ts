import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
});

import "@/commands/builtin";
import { useAppStore } from "@/state/appStore";
import { runCommand } from "./registry";

/**
 * The invest commands signal through window events (the store owns the
 * state, the layout runs the action). This test pins the command → signal
 * contract: every command dispatches exactly its event with its payload,
 * only inside the invest mode, and the left-column chords (⌘⌥R / ⌘⌥A)
 * dispatch their focus signals like the rest.
 */

const INVEST_EVENTS: Array<[string, string, unknown?]> = [
  ["invest.next-instrument", "bnote:invest-cycle", 1],
  ["invest.prev-instrument", "bnote:invest-cycle", -1],
  ["invest.next-doc", "bnote:invest-doc", 1],
  ["invest.prev-doc", "bnote:invest-doc", -1],
  ["invest.toggle-sector-view", "bnote:invest-toggle-view", undefined],
  ["invest.kline-period-day", "bnote:invest-period", "1d"],
  ["invest.kline-period-week", "bnote:invest-period", "1w"],
  ["invest.kline-period-month", "bnote:invest-period", "1M"],
  ["invest.forecast-replay", "bnote:invest-forecast", undefined],
  ["invest.backtest-run", "bnote:invest-backtest", undefined],
  ["invest.search-knowledge", "bnote:invest-knowledge", undefined],
  // C15: bare ↑/↓ walk the filtered list; Enter opens the scope's doc.
  ["invest.list-up", "bnote:invest-list-move", -1],
  ["invest.list-down", "bnote:invest-list-move", 1],
  ["invest.open-doc", "bnote:invest-open-doc", undefined],
  // C17: TradingView-style chart keys.
  ["invest.kline-scroll-left", "bnote:invest-kline-scroll", -1],
  ["invest.kline-scroll-right", "bnote:invest-kline-scroll", 1],
  ["invest.kline-zoom-out", "bnote:invest-kline-zoom", 0.8],
  ["invest.kline-zoom-in", "bnote:invest-kline-zoom", 1.25],
  // C18: ⌘⌥1..7 land on the Nth detail tab.
  ["invest.detail-tab-1", "bnote:invest-detail-tab", 1],
  ["invest.detail-tab-7", "bnote:invest-detail-tab", 7],
];

beforeEach(() => {
  useAppStore.setState({ mode: "invest", mainColumn: "agent" });
});

describe("the invest command surface", () => {
  it("each command dispatches exactly its window signal", () => {
    const dispatch = vi.spyOn(window, "dispatchEvent");
    try {
      for (const [id, type, detail] of INVEST_EVENTS) {
        dispatch.mockClear();
        runCommand(id);
        expect(dispatch, id).toHaveBeenCalledTimes(1);
        const event = dispatch.mock.calls[0][0] as CustomEvent;
        expect(event.type, id).toBe(type);
        expect(event.detail, id).toBe(detail ?? null);
      }
    } finally {
      dispatch.mockRestore();
    }
  });

  it("the commands are hidden outside the invest mode (the when guard no-ops them)", () => {
    useAppStore.setState({ mode: "notes" });
    const dispatch = vi.spyOn(window, "dispatchEvent");
    try {
      for (const [id] of INVEST_EVENTS) {
        dispatch.mockClear();
        runCommand(id);
        expect(dispatch, id).not.toHaveBeenCalled();
      }
    } finally {
      dispatch.mockRestore();
    }
  });

  it("invest.focus-market and invest.focus-agent flip the left column's pane", () => {
    // B9: the middle column is permanent; these chords switch the LEFT column
    // between the list and the agent panel, both through window events.
    const dispatch = vi.spyOn(window, "dispatchEvent");
    try {
      runCommand("invest.focus-market");
      let event = dispatch.mock.calls[dispatch.mock.calls.length - 1][0] as CustomEvent;
      expect(event.type).toBe("bnote:invest-focus-list");

      runCommand("invest.focus-agent");
      event = dispatch.mock.calls[dispatch.mock.calls.length - 1][0] as CustomEvent;
      expect(event.type).toBe("bnote:invest-focus-agent");
    } finally {
      dispatch.mockRestore();
    }
  });
});
