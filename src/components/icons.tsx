import type { SVGProps } from "react";

/**
 * Sidebar header icons. Stroke shapes instead of text glyphs: "＋" and "▤"
 * read as a generic plus and a lined box rather than "new note"/"new folder".
 * currentColor keeps them in step with `.icon-btn` (dim → bright on hover).
 */
const iconProps: SVGProps<SVGSVGElement> = {
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

/** 新建笔记：一页纸 + 加号。 */
export function IconNewNote() {
  return (
    <svg {...iconProps}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M12 18v-6" />
      <path d="M9 15h6" />
    </svg>
  );
}

/** 新建文件夹：文件夹 + 加号。 */
export function IconNewFolder() {
  return (
    <svg {...iconProps}>
      <path d="M12 10v6" />
      <path d="M9 13h6" />
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}
