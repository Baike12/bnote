import os from "node:os";

/**
 * Perf budgets are order-of-magnitude, but a median measured on an
 * oversubscribed machine still drifts several-fold. A gate that runs there
 * reports a red that says nothing about the code (docs/TESTING.md), so the
 * perf suites skip themselves and print the measured load instead.
 *
 * The ceiling stays below one runnable task per core: even fill-1
 * oversubscription moves a 2.5ms median past its budget.
 */
export const PERF_LOAD_CEILING = 0.75;

export interface LoadVerdict {
  /** True when the machine is idle enough for the budgets to mean anything. */
  fit: boolean;
  /** 1-minute load average as reported by `os.loadavg()`. */
  load1: number;
  cpus: number;
  /** Load above this value means the machine is too busy to measure. */
  limit: number;
}

export function loadVerdict(load1: number, cpus: number): LoadVerdict {
  const limit = Math.max(2, Math.ceil(cpus * PERF_LOAD_CEILING));
  return { fit: load1 < limit, load1, cpus, limit };
}

/** The verdict for the current machine, ready to print when it is unfit. */
export function currentLoadVerdict(): LoadVerdict {
  return loadVerdict(os.loadavg()[0], os.cpus().length);
}

/**
 * `BNOTE_PERF_REQUIRE=1` turns the load skip into a hard condition: in a
 * controlled runner (the CI perf job) a skipped gate is the failure — a
 * silently green `gate:full` with zero perf coverage shipped once, and it was
 * the user-visible "白天卡顿没有兜底" hole in the registry.
 */
export function perfRequired(): boolean {
  return process.env.BNOTE_PERF_REQUIRE === "1";
}

/** The line a skipped gate prints, or null when the machine is fit. */
export function skipNotice(verdict: LoadVerdict): string | null {
  if (verdict.fit) return null;
  const load = verdict.load1.toFixed(2);
  return (
    `perf gate skipped: 1-min load ${load} ≥ ${verdict.limit} limit ` +
    `(${verdict.cpus} cpus) — rerun pnpm test:perf on an idle machine.`
  );
}
