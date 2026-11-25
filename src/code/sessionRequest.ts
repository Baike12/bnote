/**
 * The channel between the project-and-session sidebar and the agent panel.
 *
 * Sidebar → panel (restore / new session):
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
 *
 * Panel → sidebar (records changed): the panel is the single writer of session
 * records, and the sidebar owns its own disk snapshot. A write has to be
 * announced or the sidebar keeps showing the list it read before the first
 * message created the record (ZCode's `task_created` refresh, same contract).
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

type SessionsChangedListener = (workdir: string) => void;

const sessionsChangedListeners = new Set<SessionsChangedListener>();

/**
 * Announce that the record directory of `workdir` changed (a first message
 * created a session, a round was appended, the model wrote its title). The
 * sidebar re-reads that one group; it never writes the records itself.
 */
export function notifySessionsChanged(workdir: string): void {
  for (const listener of [...sessionsChangedListeners]) listener(workdir);
}

/** Subscribe to record changes; returns the unsubscribe function. */
export function onSessionsChanged(listener: SessionsChangedListener): () => void {
  sessionsChangedListeners.add(listener);
  return () => {
    sessionsChangedListeners.delete(listener);
  };
}

/**
 * Remote sessions attach to the Mac's live session instead of restoring a new
 * local one. Two channels, the same split as restore: a one-shot request for
 * the project that is already open, and a pending pick keyed by workdir for a
 * row in another project that `openProjectAt` lands on afterwards.
 */
let pendingRemote: { workdir: string; id: string } | null = null;

export function setPendingRemoteAttach(workdir: string, transcriptId: string): void {
  pendingRemote = { workdir, id: transcriptId };
}

/** Consume the pending attach for `workdir` (a pick for another checkout is dropped). */
export function takePendingRemoteAttach(workdir: string): string | null {
  const entry = pendingRemote;
  pendingRemote = null;
  return entry && entry.workdir === workdir ? entry.id : null;
}

type RemoteAttachListener = (transcriptId: string) => void;

const remoteAttachListeners = new Set<RemoteAttachListener>();

/** Ask the mounted panel to attach to a live remote session. */
export function requestRemoteAttach(transcriptId: string): void {
  for (const listener of [...remoteAttachListeners]) listener(transcriptId);
}

export function onRemoteAttachRequest(listener: RemoteAttachListener): () => void {
  remoteAttachListeners.add(listener);
  return () => {
    remoteAttachListeners.delete(listener);
  };
}
