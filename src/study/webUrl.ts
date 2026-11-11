/**
 * The "open a page" box of the study column.
 *
 * Besides remote pages it accepts a local HTML file — an absolute path or a
 * `file://` URL. A local page is read in place (nothing is imported), and the
 * URL is its identity: the history entry, the material directory and the
 * annotations all hang off this one string, so it is normalized here and
 * nowhere else.
 */

/** Absolute filesystem path -> `file://` URL, one percent-encoded segment each. */
export function fileUrlFromPath(path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const url = `file://${encoded}`;
  return normalizeFileUrl(url) ?? url;
}

/** A `file://` URL in canonical form (the same text `new URL` and the Rust side produce), or null. */
function normalizeFileUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "file:") return null;
  // `file://host/path` only has a meaning with an empty or localhost host.
  if (parsed.hostname && parsed.hostname !== "localhost") return null;
  return `file://${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * The typed text as a URL: a bare host gets `https://`, an absolute path becomes
 * a local page. Anything else is returned trimmed so the backend can reject it
 * with a message that names the real problem.
 */
export function normalizeStudyUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^file:/i.test(trimmed)) return normalizeFileUrl(trimmed) ?? trimmed;
  if (trimmed.startsWith("/")) return fileUrlFromPath(trimmed);
  return `https://${trimmed}`;
}

/**
 * The automatic name of a page: the domain for a remote page, the file name for
 * a local one (the full URL would say nothing in the history list).
 */
export function studyUrlName(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      const last = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
      return decodeURIComponent(last) || url;
    }
    return parsed.host || url;
  } catch {
    return url;
  }
}
