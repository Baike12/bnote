/**
 * H6 blind test P2-15: the ingest toast used to paste the raw source error —
 * `HTTP_STATUS: https://rsshub.app/sina/rollnews/finance: 403 Forbidden` —
 * at the user. A failure line should say which source is unavailable and in
 * one plain phrase; the URL and status detail stay available in the log.
 */

export interface IngestFailure {
  source_id: string;
  error: string;
}

/** One source's failure as a short user-facing phrase. */
export function ingestFailureLabel(f: IngestFailure): string {
  const id = f.source_id.trim() || "未知源";
  const code = /\b(\d{3})\b/.exec(f.error)?.[1];
  if (f.error.startsWith("HTTP_STATUS")) {
    return `${id} 暂不可用${code ? `（HTTP ${code}）` : ""}`;
  }
  if (f.error.startsWith("HTTP_")) return `${id} 网络请求失败`;
  if (f.error.startsWith("TIMEOUT")) return `${id} 请求超时`;
  // Unknown failure kinds: keep the source, drop the payload's punctuation.
  return `${id} 抓取失败`;
}

/** `新增 0 条；2 个信息源暂不可用（sina-finance-roll（HTTP 403）、x 网络请求失败）` */
export function ingestToast(stored: number, failures: IngestFailure[]): string {
  if (failures.length === 0) return `摄取完成: 新增 ${stored} 条`;
  const labels = failures.slice(0, 2).map(ingestFailureLabel).join("、");
  const more = failures.length > 2 ? ` 等 ${failures.length} 个` : "";
  return `摄取完成: 新增 ${stored} 条；${failures.length} 个信息源暂不可用（${labels}${more}）`;
}
