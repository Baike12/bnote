/**
 * One-shot request channel for the code panel.
 *
 * The command layer needs the panel to do a few things (open the quick-open
 * box, open find-in-file, ask for a new name on rename), but the command
 * layer must not hold the panel's DOM. Same pattern as elsewhere in bnote:
 * a command emits a request and the panel subscribes and consumes it —
 * **exactly once**, otherwise a later subscriber would see a stale request.
 */

/** A request the panel has to handle. */
export type CodeUiRequest = { kind: "quick-open" } | { kind: "find-in-files" } | { kind: "rename" };

type Listener = (request: CodeUiRequest) => void;

const listeners = new Set<Listener>();

/** Ask the panel to do something. */
export function requestCodeUi(request: CodeUiRequest): void {
  for (const listener of [...listeners]) listener(request);
}

/** Subscribe to panel requests; returns the unsubscribe function. */
export function onCodeUiRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
