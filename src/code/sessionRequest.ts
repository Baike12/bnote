/**
 * How the project-and-session sidebar asks the agent panel to restore a
 * session or start a new one. Two paths, because acting on another project is
 * not the same event as acting inside the open one:
 *
 * - **Another project / worktree**: the sidebar records a pending pick (a
 *   session to restore, or "start fresh") keyed by the target workdir, then
 *   opens that checkout. The agent panel's code-scope effect consumes the
 *   pending entry before its default "restore the newest session" rule, so the
 *   click lands where the user pointed.
 * - **The open project**: the panel is already mounted, so a one-shot request
 *   channel is enough (the same pattern as `src/code/ui.ts`).
 *
 * Both restore routes end in `restoreFamily(id, sessions, "anchor")` — the
 * exact code path the history drawer's pick uses.
 */

let pending: { workdir: string; sessionId: string } | null = null;

/** Record the session to land on in `workdir` once that project opens. */
export function setPendingCodeSession(workdir: string, sessionId: string): void {
  pending = { workdir, sessionId };
}

/**
 * Consume the pending session for `workdir` (or drop it when it belongs to a
 * different checkout: the user opened something else in between).
 */
export function takePendingCodeSession(workdir: string): string | null {
  const entry = pending;
  pending = null;
  return entry && entry.workdir === workdir ? entry.sessionId : null;
}

/**
 * The "start a fresh session here" pick for a project that is not open yet:
 * set before `openProjectAt`, consumed by the scope effect instead of the
 * restore rule (the newest record is not what the row asked for).
 */
let pendingNew: string | null = null;

export function setPendingCodeNewSession(workdir: string): void {
  pendingNew = workdir;
}

/**
 * Consume the pending new-session marker. Returns false when it belonged to a
 * different checkout, which also drops it (the user opened something else).
 */
export function takePendingCodeNewSession(workdir: string): boolean {
  const entry = pendingNew;
  pendingNew = null;
  return entry === workdir;
}

type Listener = (sessionId: string) => void;

const listeners = new Set<Listener>();

/** Ask the mounted agent panel to restore this session of the open project. */
export function requestSessionRestore(sessionId: string): void {
  for (const listener of [...listeners]) listener(sessionId);
}

/** Subscribe to restore requests; returns the unsubscribe function. */
export function onSessionRestore(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type NewSessionListener = () => void;

const newSessionListeners = new Set<NewSessionListener>();

/** Ask the mounted agent panel to start a fresh session in the open project. */
export function requestNewSession(): void {
  for (const listener of [...newSessionListeners]) listener();
}

/** Subscribe to "new session" requests; returns the unsubscribe function. */
export function onNewSessionRequest(listener: NewSessionListener): () => void {
  newSessionListeners.add(listener);
  return () => {
    newSessionListeners.delete(listener);
  };
}
