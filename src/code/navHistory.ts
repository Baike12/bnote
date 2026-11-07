import type { LspPosition } from "./types";

/**
 * The origins of the jumps inside the code pane.
 *
 * One entry per jump ("go to definition", a reference, a problem, a quick-open
 * hit): where the caret was before it ran. "Go back" pops the most recent one,
 * so pressing it twice walks the jumps backwards in order.
 */
export interface CodeLocation {
  /** Project-relative path. */
  path: string;
  position: LspPosition;
}

/** How many origins to keep (a long session must not grow without bound). */
export const NAV_BACK_LIMIT = 50;

export function sameLocation(a: CodeLocation, b: CodeLocation): boolean {
  return (
    a.path === b.path &&
    a.position.line === b.position.line &&
    a.position.character === b.position.character
  );
}

/**
 * Push an origin. Consecutive duplicates collapse (jumping twice from the same
 * caret is still one place to come back to), and the oldest entries fall off
 * once the limit is reached.
 */
export function pushNavBack(stack: readonly CodeLocation[], origin: CodeLocation): CodeLocation[] {
  const last = stack[stack.length - 1];
  if (last && sameLocation(last, origin)) return stack as CodeLocation[];
  const next = [...stack, origin];
  return next.length > NAV_BACK_LIMIT ? next.slice(next.length - NAV_BACK_LIMIT) : next;
}

/** The target of one "go back": the most recent origin, and the stack without it. */
export function popNavBack(stack: readonly CodeLocation[]): {
  target: CodeLocation | null;
  rest: CodeLocation[];
} {
  if (stack.length === 0) return { target: null, rest: [] };
  return { target: stack[stack.length - 1], rest: stack.slice(0, -1) };
}
