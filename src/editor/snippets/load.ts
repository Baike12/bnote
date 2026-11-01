import { type RawSnippet } from "./default-snippets";
import { builtinSnippets, reloadSnippets } from "./engine";

/**
 * The single owner of the snippet source: which set of snippets is currently
 * loaded (built-in or the vault's snippets.js). The settings application
 * (applySettingsToEditor) may only flip the switch through
 * applySnippetsEnabled and must not touch the source — otherwise every file
 * open or settings change would knock the user snippets back to the built-in
 * ones (a real regression). Writes to the source go only through
 * applySnippetSource / SnippetLoader.
 */
let currentRaws: RawSnippet[] | null = null;

/** The user snippets currently loaded; null means the built-in ones are used. */
export function currentUserSnippets(): RawSnippet[] | null {
  return currentRaws;
}

/** Replaces the snippet source (and compiles it). The enabled flag applies
 *  at the same time. */
export function applySnippetSource(raws: RawSnippet[] | null, enabled: boolean): void {
  currentRaws = raws;
  reloadSnippets(raws, enabled);
}

/** Flips only the enabled switch and keeps the loaded source. The settings
 *  application always goes through here. */
export function applySnippetsEnabled(enabled: boolean): void {
  reloadSnippets(currentRaws, enabled);
}

export interface SnippetLoadOutcome {
  /** user=the user snippets are in effect; builtin=fallen back to built-in; error=the load failed (the editor side has already fallen back to built-in) */
  status: "user" | "builtin" | "error";
  /** The number of snippets actually in effect: the export count for user, the built-in count for builtin */
  count: number;
  error?: string;
}

function builtinOutcome(): SnippetLoadOutcome {
  return { status: "builtin", count: builtinSnippets.list.length };
}

/** Validates the shape of a dynamically imported module: an array in the
 *  default export, or a bare array (the mod.exports style). */
export function normalizeSnippetExport(mod: unknown): RawSnippet[] {
  const data = (mod as { default?: unknown } | null)?.default ?? mod;
  if (!Array.isArray(data)) {
    throw new Error("snippets.js 必须 default 导出片段数组(export default [...])");
  }
  return data as RawSnippet[];
}

/** Dynamic import through a Blob URL: src runs as ESM, so the snippet file can
 *  be any JavaScript. */
export async function importSnippetModule(src: string): Promise<RawSnippet[]> {
  const blob = new Blob([src], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const mod = await import(/* @vite-ignore */ url);
    return normalizeSnippetExport(mod);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The snippet loader with a content cache. Vault events are debounced every
 * 300ms and any file change triggers a reload — re-importing the same content
 * (compiling 130+ snippets) must be blocked; when only the switch changed and
 * the source did not, only the switch is flipped, again without recompiling.
 */
export class SnippetLoader {
  private lastSrc: string | null = null;
  private lastEnabled = true;
  private lastOutcome: SnippetLoadOutcome;

  constructor(private readonly importer: (src: string) => Promise<RawSnippet[]>) {
    this.lastOutcome = builtinOutcome();
  }

  /** Named load rather than apply: `apply(null, …)` would trip eslint's
   *  prefer-spread rule. */
  async load(src: string | null, enabled: boolean): Promise<SnippetLoadOutcome> {
    if (src === this.lastSrc) {
      if (enabled !== this.lastEnabled) {
        this.lastEnabled = enabled;
        applySnippetsEnabled(enabled);
      }
      return this.lastOutcome;
    }
    this.lastSrc = src;
    this.lastEnabled = enabled;
    if (!src) {
      applySnippetSource(null, enabled);
      this.lastOutcome = builtinOutcome();
      return this.lastOutcome;
    }
    try {
      const raws = await this.importer(src);
      applySnippetSource(raws, enabled);
      this.lastOutcome = { status: "user", count: raws.length };
    } catch (e) {
      // A syntax error, a wrong export shape, or a CSP block all land here:
      // the editor immediately falls back to the built-in snippets, and the
      // error is handed to the caller for display (a toast when the user's
      // file changed, never swallowed into console).
      applySnippetSource(null, enabled);
      this.lastOutcome = { status: "error", count: 0, error: String(e) };
    }
    return this.lastOutcome;
  }
}

export const snippetLoader = new SnippetLoader(importSnippetModule);
