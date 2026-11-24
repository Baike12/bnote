import type { SVGProps } from "react";

/**
 * The project sidebar's icons, in the same 16px stroked language as the rest
 * of bnote (lucide-style outlines, `currentColor` so the row state decides
 * the color). No icon package: a handful of shapes do not justify one.
 */
const base: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

/** New session: a message bubble with a plus. */
export function IconNewSession() {
  return (
    <svg {...base}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
      <path d="M12 7v6" />
      <path d="M9 10h6" />
    </svg>
  );
}

/** Worktree: the git-branch shape. */
export function IconWorktree() {
  return (
    <svg {...base}>
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="18" cy="6" r="2.4" />
      <path d="M6 8.4v7.2" />
      <path d="M18 8.4a6 6 0 0 1-6 6H9" />
    </svg>
  );
}

/** Open project: a folder with an arrow going into it. */
export function IconOpenProject() {
  return (
    <svg {...base}>
      <path d="M12 10v6" />
      <path d="M9 13h6" />
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

/** Search: a magnifier. */
export function IconSearch() {
  return (
    <svg {...base}>
      <circle cx="11" cy="11" r="7.2" />
      <path d="M21 21l-4.6-4.6" />
    </svg>
  );
}

/** Refresh: a circular arrow. */
export function IconRefresh() {
  return (
    <svg {...base}>
      <path d="M21 12a9 9 0 1 1-3.1-6.8" />
      <path d="M21 3.6V9h-5.4" />
    </svg>
  );
}

/** Collapse the column: a panel with its left side marked. */
export function IconPanelLeft() {
  return (
    <svg {...base}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

/** Settings: the gear. */
export function IconSettings() {
  return (
    <svg {...base}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

/** Archive: a box with its lid. */
export function IconArchive() {
  return (
    <svg {...base}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

/** Restore: an arrow leaving the box. */
export function IconRestore() {
  return (
    <svg {...base}>
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M3 4h18v4H3z" />
      <path d="M12 16v-5" />
      <path d="M9.5 13.5 12 11l2.5 2.5" />
    </svg>
  );
}

/** Delete: the trash can. */
export function IconTrash() {
  return (
    <svg {...base}>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

/** Streaming: the loader arc (spun by `.cp-spin`). */
export function IconSpinner() {
  return (
    <svg {...base}>
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  );
}

/** Pin: the pushpin that keeps a project on top. */
export function IconPin() {
  return (
    <svg {...base}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z" />
    </svg>
  );
}
