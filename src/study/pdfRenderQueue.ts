/**
 * One scheduler for every pdf.js page render.
 *
 * pdf.js yields once per animation frame between its operator-list chunks
 * (render() passes `useRequestAnimationFrame` for the display intent), but a
 * chunk is allowed to run ~15 ms of drawing (EXECUTION_TIME in pdf.mjs). Four
 * active pages rendering at once therefore stack their chunks into the same
 * frame — about 60 ms of pdf.js work per scroll frame, which is the jank the
 * reader had. The queue keeps exactly **one** render in flight.
 *
 * While the reader is scrolling, only the pages that are actually on screen
 * may start: a page outside the viewport waits for the scroll to go quiet. A
 * fling then costs paint only, and no visible page is left blank (a visible
 * page is picked first, so it never waits behind a pre-render).
 *
 * State has one owner: this module. Pages only enqueue; the reader only
 * reports scrolling.
 */

export interface PdfRenderJob {
  /** Page number: a newer job for the same page replaces the queued one. */
  key: number;
  /** Whether the page is on screen right now; asked when the job is picked. */
  onScreen: () => boolean;
  /**
   * Does the work. `setAbort` registers how to abort the pdf.js task that is
   * running, so a page released mid-render does not keep burning frames.
   */
  run: (setAbort: (abort: () => void) => void) => Promise<void>;
}

export interface PdfRenderHandle {
  /** Drop the job: removed while queued, aborted while running. */
  cancel: () => void;
}

export interface PdfRenderQueueDeps {
  /** A scroll this recent still counts as "the user is scrolling". */
  quietMs?: number;
  now?: () => number;
  /** `setTimeout` with an explicit delay, returning its cancel. Injected in tests. */
  schedule?: (run: () => void, delayMs: number) => () => void;
}

export interface PdfRenderQueue {
  enqueue: (job: PdfRenderJob) => PdfRenderHandle;
  /** The reader scrolled: deferred jobs wait for the next quiet moment. */
  noteScroll: () => void;
}

const DEFAULT_QUIET_MS = 120;

export function createPdfRenderQueue(deps: PdfRenderQueueDeps = {}): PdfRenderQueue {
  const quietMs = deps.quietMs ?? DEFAULT_QUIET_MS;
  const now = deps.now ?? (() => Date.now());
  const schedule =
    deps.schedule ??
    ((run: () => void, delayMs: number) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });

  interface Entry extends PdfRenderJob {
    cancelled: boolean;
    /** Set once the job starts; stays null while it is only queued. */
    abort: (() => void) | null;
  }

  let pending: Entry[] = [];
  let running = false;
  /** When the last scroll was reported, in `now()` milliseconds. */
  let lastScroll = Number.NEGATIVE_INFINITY;
  let wakeUp: (() => void) | null = null;

  const scrolling = () => now() - lastScroll < quietMs;

  function pump() {
    if (wakeUp) {
      wakeUp();
      wakeUp = null;
    }
    if (running || pending.length === 0) return;

    // A visible page jumps the queue: during a scroll it is the only one
    // allowed to start, at rest it is still the most urgent one.
    const entry = pending.find((job) => !scrolling() || job.onScreen());
    if (!entry) {
      // Everything is deferred; come back once the scroll has gone quiet.
      const wait = Math.max(0, lastScroll + quietMs - now());
      wakeUp = schedule(pump, wait + 1);
      return;
    }
    pending = pending.filter((job) => job !== entry);

    running = true;
    void entry
      .run((abort) => {
        entry.abort = abort;
        // The page was released while its task was being set up.
        if (entry.cancelled) abort();
      })
      .catch((error: unknown) => {
        // A failed page must not wedge the queue: the next one still goes.
        console.warn("[pdf] page render failed", entry.key, error);
      })
      .finally(() => {
        running = false;
        pump();
      });
  }

  return {
    enqueue(job: PdfRenderJob): PdfRenderHandle {
      const entry: Entry = { ...job, cancelled: false, abort: null };
      // A newer render of the same page (a width change, a zoom step) makes
      // the queued one pointless: dropping it removes a whole page of work.
      pending = pending.filter((other) => other.key !== job.key);
      pending.push(entry);
      pump();
      return {
        cancel: () => {
          entry.cancelled = true;
          if (pending.includes(entry)) {
            pending = pending.filter((other) => other !== entry);
            return;
          }
          entry.abort?.();
        },
      };
    },
    noteScroll() {
      lastScroll = now();
    },
  };
}

/** The reader's single queue: concurrency is a property of the whole app, not of one page. */
export const pdfRenderQueue = createPdfRenderQueue();
