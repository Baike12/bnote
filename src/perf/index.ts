/**
 * The performance system's public entry: install the sink/observers, expose
 * `window.__bnotePerf`, and re-export the tracer so modules instrument their
 * own hot phases with `perfStart` / `perfEnd`.
 */
import type { PerfHost } from "./sink";
import { flushPerf, installPerfSink } from "./sink";
import {
  clearPerf,
  installPerfObservers,
  perfEvents,
  perfLevel,
  perfReport,
  perfStats,
  startFullTrace,
  stopFullTrace,
} from "./trace";

export interface PerfApi {
  level: typeof perfLevel;
  start: (seconds?: number) => void;
  stop: () => void;
  report: typeof perfReport;
  events: typeof perfEvents;
  stats: typeof perfStats;
  clear: typeof clearPerf;
  flush: typeof flushPerf;
}

declare global {
  interface Window {
    __bnotePerf?: PerfApi;
  }
}

export function installPerf(host: PerfHost): void {
  installPerfSink(host);
  installPerfObservers();
  window.__bnotePerf = {
    level: perfLevel,
    start: (seconds = 120) => startFullTrace(seconds),
    stop: stopFullTrace,
    report: perfReport,
    events: perfEvents,
    stats: perfStats,
    clear: clearPerf,
    flush: flushPerf,
  };
}

export * from "./trace";
export { flushPerf, installPerfSink, type PerfHost } from "./sink";
export { editorPerfProbe } from "./editorProbe";
