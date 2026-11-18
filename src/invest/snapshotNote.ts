import { signedPct as pct, num, yi } from "./format";
import type { InvestFundFlowDay, InvestSnapshot } from "./types";

/**
 * G27: the snapshot → Markdown note renderer. The note is the durable copy
 * of what the user saw (the quote endpoint is a moving target), so the table
 * carries the as-of timestamp and the same display conventions as the detail
 * tab (yuan → 亿/万亿, ratios as 0–1 fractions).
 */

export function buildSnapshotMarkdown(
  title: string,
  code: string,
  snapshot: InvestSnapshot,
  fundFlow: InvestFundFlowDay[],
): string {
  const fetched = new Date(snapshot.fetched_at * 1000);
  // The fixed zone is load-bearing: the note is a durable copy, and a stamp
  // that shifts with the machine's timezone makes two copies of the same
  // snapshot incomparable. zh-CN formatting, Beijing time, always.
  const stamp = Number.isNaN(fetched.getTime())
    ? "未知时间"
    : fetched.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const change =
    snapshot.price != null && snapshot.prev_close
      ? (snapshot.price - snapshot.prev_close) / snapshot.prev_close
      : null;
  const lines = [
    `## ${title} ${code} 快照（${stamp}）`,
    "",
    "| 指标 | 值 |",
    "| --- | --- |",
    `| 现价 | ${num(snapshot.price)}${snapshot.currency ? ` ${snapshot.currency}` : ""} |`,
    `| 涨跌 | ${pct(change)} |`,
    `| 今开 | ${num(snapshot.open)} |`,
    `| 最高 / 最低 | ${num(snapshot.high)} / ${num(snapshot.low)} |`,
    `| 成交额 | ${yi(snapshot.amount, snapshot.currency)} |`,
    `| 换手率 | ${pct(snapshot.turnover)} |`,
    `| PE(TTM) / PB | ${num(snapshot.pe)} / ${num(snapshot.pb)} |`,
    `| 总市值 | ${yi(snapshot.market_cap, snapshot.currency)} |`,
    `| 计价货币 | ${snapshot.currency ?? "—"} |`,
    "",
  ];
  const flow = fundFlow[fundFlow.length - 1];
  if (flow) {
    lines.push(
      `| 日期 | 收盘 | 涨跌幅 | 净流入 | 主力净流入 |`,
      `| --- | --- | --- | --- | --- |`,
      `| ${flow.date} | ${num(flow.close)} | ${pct(flow.change_ratio)} | ${yi(flow.net_amount)} | ${yi(flow.main_net)} |`,
      "",
    );
  }
  return lines.join("\n");
}
