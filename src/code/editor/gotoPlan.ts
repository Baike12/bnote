/**
 * Pure decision layer of the jump actions (definition / type definition /
 * implementation).
 *
 * The language server answers with locations; what the user actually gets —
 * a jump, or an honest "nothing here" — is decided here, away from IPC and the
 * store, so the rule is testable and the glue only executes the plan.
 */

/** The part of a location the planner cares about. */
export interface GotoTarget {
  /** Project-relative path, or an absolute path for an external location. */
  path: string;
  /** Outside the project root (standard library, dependency source). */
  external: boolean;
}

export type GotoPlan<T extends GotoTarget> = { kind: "jump"; target: T } | { kind: "none" };

/**
 * Pick what to do with the locations the server returned.
 *
 * An in-project location always wins: a server may list a stub before the real
 * source (ty answers a type definition with `typeshed` first).
 *
 * An external-only answer still **jumps**: the editor opens the file read-only.
 * Zed and VSCode both land in a declaration file when the definition only
 * exists there; refusing it made a working server look like a dead keybinding.
 */
export function planGoto<T extends GotoTarget>(targets: readonly T[]): GotoPlan<T> {
  const inside = targets.find((t) => !t.external);
  if (inside) return { kind: "jump", target: inside };
  const first = targets[0];
  if (first) return { kind: "jump", target: first };
  return { kind: "none" };
}

/**
 * The tail of a path for a message: a stub location such as
 * `~/.cache/ty/vendored/typeshed/…/stdlib/builtins.pyi` is unreadable at full
 * length.
 */
export function shortPath(path: string, segments = 3): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join("/")}`;
}

/** Why the language server could not be asked (see the errors of commands/code.rs). */
export type UnavailableReason = "not-running" | "unreachable";

/**
 * Classify a failed language server request.
 *
 * The distinction matters: a null answer means "nothing at this position" and
 * must not be reported as a missing server — that misdiagnosis is what made the
 * UI claim the server was down while it was running and simply had no
 * definition for `torch.from_numpy(...)`.
 */
export function unavailableReasonOf(message: string): UnavailableReason | null {
  if (message.includes("LSP_NOT_RUNNING")) return "not-running";
  if (message.includes("LSP_UNREACHABLE")) return "unreachable";
  return null;
}
