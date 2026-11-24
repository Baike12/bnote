import { relDirname, resolveRelativePath } from "@/lib/path";
import { imageSrc } from "./image";

/**
 * The rendered view of a markdown file in code mode.
 *
 * Rendering reuses the agent's markdown renderer (`splitAgentMarkdown`): one
 * markdown model, one set of escaping rules, KaTeX already wired. What code
 * mode adds is the part the agent never needs — **resolving relative image
 * references against the file's own directory** through the asset protocol,
 * exactly like the code area's image view. Fences stay code blocks (a README's
 * html / mermaid fences are source there, as in VSCode's preview).
 */

/** Escape one HTML attribute value. */
function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Percent-decode a reference; a malformed escape keeps the raw text. */
function decodeRef(ref: string): string {
  if (!ref.includes("%")) return ref;
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

/**
 * One `![alt](ref)` of a project file as `<img>` HTML.
 *
 * Remote and data URLs pass through. Everything else is a path relative to the
 * markdown file (the standard markdown form, `../img/x.png` included); a
 * leading `/` is read from the project root. A reference the asset protocol
 * cannot serve returns null, and the markdown stays literal — a missing image
 * must never throw inside the render.
 */
export function markdownImageHtml(
  root: string,
  filePath: string,
  ref: string,
  alt: string,
): string | null {
  const raw = ref.trim();
  if (!raw) return null;
  if (/^(https?:|data:)/i.test(raw)) {
    return `<img src="${escapeAttr(raw)}" alt="${escapeAttr(alt)}">`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // asset:, blob:, mailto: … are not images here
  const rel = resolveRelativePath(relDirname(filePath), decodeRef(raw));
  const src = imageSrc(root, rel);
  if (!src) return null;
  return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`;
}

/** The image resolver `splitAgentMarkdown` wants for one open file. */
export function markdownImageResolver(
  root: string,
  filePath: string,
): (ref: string, alt: string) => string | null {
  return (ref, alt) => markdownImageHtml(root, filePath, ref, alt);
}
