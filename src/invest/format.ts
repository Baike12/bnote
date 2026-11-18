/**
 * The invest domain's display formatters — the **single** set of converters
 * for the unit contract (amounts in yuan, ratios as 0–1 fractions, volumes in
 * shares). Every screen that prints an invest number goes through these; a
 * raw `%`/`亿` suffix inline is a defect (blind test: the fund flow's
 * change_ratio was rendered raw as -0.0327%).
 *
 * `format.test.ts` locks each conversion; the registry row "unit-contract
 * violation" in docs/TESTING.md points here.
 */

/** A 0–1 fraction → "91.00%"; floating tails never leak (0.17 → "17.00%"). */
export function pct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

/** Signed percentage for change rows: the list rows carry +/− and the
 * up/down colors; the detail tab must read the same way (blind test P0-4). */
export function signedPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}

/** Numbers with the zh-CN grouping and a bounded fraction tail. */
export function num(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

/** Yuan → 亿元 / 万亿元, mirroring the CN market's display convention.
 * H6: the pricing currency rides inline on the value — a bare "5.13 万亿"
 * reads as CNY to a Chinese user while the snapshot is USD (blind test). */
export function yi(v: number | null | undefined, currency?: string | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const body = Math.abs(v) >= 1e12 ? `${(v / 1e12).toFixed(2)} 万亿` : `${(v / 1e8).toFixed(2)} 亿`;
  return currency ? `${body} ${currency}` : body;
}

/** Shares → whole lots (the cn quote/kline convention, 1 lot = 100 shares). */
export function sharesToLots(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return Math.round(v / 100).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}
