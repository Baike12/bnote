import { fileIconKind, type FileIconKind } from "../fileIcon";

/**
 * File tree icons: folders (open / closed) plus file icons whose inner mark
 * is drawn per category.
 *
 * All of them are 16×16 stroked SVGs (the stroke follows currentColor, the
 * color is decided by the `.code-icon--*` class), the same linear language as
 * the other bnote icons; no icon library — only a dozen shapes are needed and
 * one more dependency is not worth it.
 */

/** The outline of a file: the corners are clipped and the top right leaves room for the folded corner. */
const FILE_PATH =
  "M4.5 1.6h4.1l3.9 3.8v9.1a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V2.6a1 1 0 0 1 1-1Z";

/** What each category draws in the inner mark (sharing the outline). */
function Mark({ kind }: { kind: FileIconKind }) {
  switch (kind) {
    case "ts":
    case "js":
    case "py":
    case "rs":
    case "go":
    case "code":
      return <path d="M6.8 8.7 5.2 10.3l1.6 1.7M9.2 8.7l1.6 1.6-1.6 1.7" />;
    case "data":
      return (
        <path d="M7.1 8.5c-.7 0-.7.6-.7 1v.5c0 .5 0 1-.7 1 .7 0 .7.5.7 1v.5c0 .4 0 1 .7 1M8.9 8.5c.7 0 .7.6.7 1v.5c0 .5 0 1 .7 1-.7 0-.7.5-.7 1v.5c0 .4 0 1-.7 1" />
      );
    case "doc":
      return <path d="M5.9 9h4.2M5.9 11h4.2M5.9 13h2.4" />;
    case "style":
      return <path d="M7.2 8.6 6.8 13.2M9.3 8.6 8.9 13.2M5.8 10h4.6M5.6 11.9h4.6" />;
    case "markup":
      return <path d="M7 9 5.4 10.5 7 12.1M9 9l1.6 1.5L9 12.1M8.5 8.4l-1 5" />;
    case "image":
      return (
        <>
          <path d="M5.7 13l1.7-2 1.2 1.3 1-1.1 1.2 1.8Z" />
          <circle cx="8.9" cy="9.7" r=".65" />
        </>
      );
    case "shell":
      return <path d="M5.9 9.2 7.7 10.9l-1.8 1.7M8.7 12.6h2.7" />;
    case "file":
      return null;
  }
}

/** The file icon; the color comes from the category (`.code-icon--<kind>`), the neutral file color by default. */
export function FileTypeIcon({ name }: { name: string }) {
  const kind = fileIconKind(name);
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`tree-icon code-icon--${kind}`}
      aria-hidden="true"
    >
      <path d={FILE_PATH} />
      <path d="M8.6 1.7v3.7h3.8" />
      <Mark kind={kind} />
    </svg>
  );
}

/** The folder icon: when open the "lid" is lifted and the color is one step stronger. */
export function FolderTypeIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`tree-icon ${open ? "code-icon--folder-open" : "code-icon--folder"}`}
      aria-hidden="true"
    >
      {open ? (
        <>
          <path d="M2.4 4.6a1.1 1.1 0 0 1 1.1-1.1h2.2l1.1 1.1h5.6a1.1 1.1 0 0 1 1.1 1.1v.9H4.4a1.4 1.4 0 0 0-1.3.9l-.7 2.6Z" />
          <path d="M2.6 12.9l1.3-4.4c.1-.4.5-.7 1-.7h8.1c.6 0 1.1.6.9 1.2l-1 3.3a1.1 1.1 0 0 1-1.1.8H3.5a.9.9 0 0 1-.9-1.2Z" />
        </>
      ) : (
        <path d="M2.4 4.6a1.1 1.1 0 0 1 1.1-1.1h2.2l1.1 1.1h5.6a1.1 1.1 0 0 1 1.1 1.1v6.2a1.1 1.1 0 0 1-1.1 1.1H3.5a1.1 1.1 0 0 1-1.1-1.1Z" />
      )}
    </svg>
  );
}
