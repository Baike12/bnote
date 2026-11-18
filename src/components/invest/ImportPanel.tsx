import { useRef, useState } from "react";
import { useInvestStore } from "@/invest/store";
import type {
  InvestBar,
  InvestFinancial,
  InvestFundFlowDay,
  InvestInstrument,
} from "@/invest/types";

/**
 * The data import panel (blind test, unanimous P0: every empty-state named
 * an「导入数据」feature that had no entry anywhere). Accepts the akshare
 * export shape documented in the README: one JSON file with optional
 * `instruments` / `code` + `bars` / `financials` / `fundFlow` / `snapshot`.
 * The result summary names what landed, so the user can verify without
 * reopening the charts.
 */
export function ImportPanel() {
  const close = useInvestStore((s) => s.closeImport);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function importFile(file: File) {
    setBusy(true);
    setError(null);
    setSummary(null);
    setFileName(file.name);
    try {
      const text = await file.text();
      const parsed: {
        instruments?: InvestInstrument[];
        sectors?: import("@/invest/types").InvestSector[];
        code?: string;
        bars?: InvestBar[];
        /** "sector" routes the bars to the sector-index table (B11). */
        bar_kind?: "stock" | "sector";
        financials?: InvestFinancial[];
        fundFlow?: InvestFundFlowDay[];
        snapshot?: import("@/invest/types").InvestSnapshot;
      } = JSON.parse(text);
      if (
        !parsed.instruments?.length &&
        !parsed.sectors?.length &&
        !parsed.bars?.length &&
        !parsed.financials?.length &&
        !parsed.fundFlow?.length &&
        !parsed.snapshot
      ) {
        setError(
          "JSON 里没有可导入的数据（需要 instruments / bars / financials / fundFlow / snapshot 之一）",
        );
        return;
      }
      if (parsed.bars?.length && !parsed.code) {
        setError("导入 K 线需要带 code 字段（标的代码，如 600519）");
        return;
      }
      // H6: the store owns the whole post-import orchestration (write →
      // reload lists → jump to the imported scope). The component parses and
      // renders; the flow is integration-tested on the store.
      const counts = await useInvestStore.getState().applyImport({
        instruments: parsed.instruments,
        sectors: parsed.sectors,
        code: parsed.code,
        bars: parsed.bars,
        barKind: parsed.bar_kind,
        financials: parsed.financials,
        fundFlow: parsed.fundFlow,
        snapshot: parsed.snapshot,
      });
      const parts = Object.entries(counts).map(([k, v]) => `${label(k)} ${v}`);
      setSummary(parts.join(" · "));
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="invest-import-scrim" onClick={close} role="presentation">
      <div
        className="invest-import-panel"
        role="dialog"
        aria-label="导入数据"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="invest-import-head">
          <span className="invest-import-title">导入数据</span>
          <button className="invest-import-close" onClick={close} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="invest-import-body">
          <p className="invest-import-hint">
            选择一个 JSON 文件（akshare 导出格式）。可含：
            <code>instruments</code>（标的清单）、<code>code</code> + <code>bars</code>（日 K，加
            <code>bar_kind: "sector"</code> 则为板块指数）、
            <code>financials</code>（财务）、<code>fundFlow</code>（资金流）、<code>snapshot</code>
            （快照）。
            <br />
            三市场通用：<code>instruments</code> 里每行的 <code>market</code>（cn / hk /
            us）决定该批 bars / financials / fundFlow 落到哪个市场；金额按标的计价货币（CNY / HKD /
            USD）的原始 单位填写，比率为 0–1 小数。港股、美股的行情与 K 线同样走这个入口。
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            data-testid="invest-import-file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
            }}
          />
          {!fileName ? (
            <button
              className="invest-import-pick"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? "导入中…" : "选择 JSON 文件"}
            </button>
          ) : null}
          {fileName ? <div className="invest-import-file">{fileName}</div> : null}
          {error ? <div className="invest-import-error">{error}</div> : null}
          {summary ? <div className="invest-import-summary">导入完成：{summary}</div> : null}
          {summary ? (
            <button className="invest-import-pick" onClick={close}>
              完成
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function label(key: string): string {
  switch (key) {
    case "instruments":
      return "标的";
    case "sectors":
      return "板块";
    case "bars":
      return "K 线";
    case "financials":
      return "财务";
    case "fund_flow":
      return "资金流";
    case "snapshot":
      return "快照";
    default:
      return key;
  }
}
