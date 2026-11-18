/**
 * The invest layout's geometry: two stored pixel widths (left instrument
 * column + middle content column; the notes column takes the rest), clamped
 * the same way the study/code layouts are. Pure logic — no React, no store.
 */

import { dragLeftEdge, dragMiddleEdge, RESIZER_WIDTH } from "@/study/layoutModel";

/** The column a resize operates on is never narrower than 10% of the layout. */
export const INVEST_MIN_RATIO = 0.1;
/** Default widths: the list stays scannable, the chart gets the bulk. */
export const DEFAULT_INVEST_SIDE_WIDTH = 280;
export const DEFAULT_INVEST_CONTENT_WIDTH = 680;

const MIN_WIDTH = 160;

/** Clamps a stored width to sane bounds against the current window width. */
export function normalizeInvestWidth(width: number, windowWidth: number): number {
  const max = Math.max(MIN_WIDTH, Math.round(windowWidth * (1 - 2 * INVEST_MIN_RATIO)));
  if (!Number.isFinite(width)) return DEFAULT_INVEST_SIDE_WIDTH;
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), max));
}

/**
 * The instrument list's display row model: search filter (code prefix when
 * the query is digits, name substring otherwise) applied on top of the
 * server-filtered list. The server does the real filtering; this is the
 * last-mile client filter for the watchlist view where the server returns
 * everything watched.
 */
export function filterInstruments<T extends { code: string; name: string; industry: string }>(
  instruments: T[],
  query: string,
): T[] {
  const q = query.trim();
  if (!q) return instruments;
  // H6 blind test: quant users type the ticker ("AAPL", "NVDA") and HK users
  // type the code tail ("700" → 00700). Codes match case-insensitively by
  // substring; a pure-digit query also matches the code tail so leading
  // zeros stay optional. Extra hits (600700 for "700") are acceptable — the
  // list shows them for disambiguation.
  const lower = q.toLowerCase();
  const digits = /^\d+$/.test(q) ? q.replace(/^0+/, "") || q : null;
  return instruments.filter(
    (i) =>
      i.code.toLowerCase().includes(lower) ||
      i.name.includes(q) ||
      i.industry.includes(q) ||
      (digits != null && i.code.endsWith(digits)),
  );
}

/**
 * The left divider's result for one pointer offset.
 *
 * This is the **seam** between the component's measurements and the shared
 * drag model: `InvestLayout` calls exactly this, so the argument order cannot
 * drift from the model's contract unseen again. (The divider bug: the
 * component passed the layout width where the model expects the delta, so a
 * single drag jumped straight to the clamp bounds.)
 *
 * Measurements are taken once at pointerdown; `dx` is the pointer offset.
 */
export function leftDividerWidths(
  m: { leftWidth: number; middleWidth: number; hostWidth: number },
  dx: number,
): { left: number; middle: number } {
  const widths = dragLeftEdge(
    m.leftWidth + RESIZER_WIDTH + dx,
    m.hostWidth,
    m.leftWidth + m.middleWidth,
  );
  return { left: widths.left, middle: widths.middle };
}

/**
 * The middle|notes divider's result for one pointer offset: the middle column
 * absorbs the delta, its left edge stays put (`middleLeft` is relative to the
 * layout's left edge, as the shared model expects).
 */
export function middleDividerWidth(
  m: { middleLeft: number; middleWidth: number; hostWidth: number },
  dx: number,
): number {
  return dragMiddleEdge(
    m.middleLeft + m.middleWidth + RESIZER_WIDTH + dx,
    m.hostWidth,
    m.middleLeft,
  ).middle;
}

/**
 * H6 follow-up: the scope an import just fed, so the view can jump there and
 * show the new data (the blind-test symptom: import succeeded, the chart kept
 * its empty overlay because nothing reloaded the current scope).
 *
 * Returns null when the payload carries no `code` (e.g. a snapshot-only or
 * instruments-only import — there is no single target to focus).
 */
export function importTargetScope(
  payload: {
    code?: string;
    bar_kind?: "stock" | "sector";
    instruments?: { code: string; name: string }[];
    sectors?: { code: string; name: string }[];
  },
  instruments: { code: string; name: string }[],
  sectors: { code: string; name: string }[],
): { scope: string; title: string } | null {
  const code = payload.code?.trim();
  if (!code) return null;
  if (payload.bar_kind === "sector") {
    const title =
      payload.sectors?.find((s) => s.code === code)?.name ??
      sectors.find((s) => s.code === code)?.name ??
      code;
    return { scope: scopeFor("sector", code), title };
  }
  const title =
    payload.instruments?.find((i) => i.code === code)?.name ??
    instruments.find((i) => i.code === code)?.name ??
    code;
  return { scope: scopeFor("stock", code), title };
}

/** Cycles to the next/prev index with wrap-around (the ⌘⌥←/→ instrument switch). */
export function cycleIndex(index: number, length: number, delta: 1 | -1): number {
  if (length === 0) return 0;
  return (index + delta + length) % length;
}

/**
 * The scope of the currently focused workspace object. Stocks and sectors
 * share one selection model: the middle column and the notes tabs all read
 * this one address.
 */
export function scopeFor(kind: "stock" | "sector", code: string): string {
  return `${kind}:${code}`;
}

/** Parses a scope address back into its parts (null = not a local scope). */
export function parseScope(scope: string): { kind: "stock" | "sector"; code: string } | null {
  const [kind, code] = scope.split(":");
  if (kind === "stock" && code) return { kind: "stock", code };
  if (kind === "sector" && code) return { kind: "sector", code };
  return null;
}

/** The document directory of a scope (mirrors the Rust `docs::scope_dir`). */
export function scopeDocDir(scope: string): string | null {
  const parsed = parseScope(scope);
  if (!parsed) return null;
  return parsed.kind === "stock" ? `stocks/${parsed.code}` : `sectors/${parsed.code}`;
}
