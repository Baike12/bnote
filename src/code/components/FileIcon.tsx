import { DEFAULT_FILE_ICON_SRC, fileIconSrc } from "../fileIcon";

/**
 * File tree icons: folders are drawn here (open / closed), files use the
 * Material icon set under `public/material-icons` — the same colored per-type
 * assets ZCode ships, so a file reads by its type at a glance instead of by a
 * coarse category.
 */

/** One colored Material icon per file type; a name the set does not know falls back to the document icon. */
export function FileTypeIcon({ name }: { name: string }) {
  return (
    <img
      src={fileIconSrc(name)}
      alt=""
      className="tree-icon"
      aria-hidden="true"
      draggable={false}
      onError={(event) => {
        const img = event.currentTarget;
        // document.svg itself is missing → stop, a second error would loop.
        if (img.getAttribute("src") !== DEFAULT_FILE_ICON_SRC) img.src = DEFAULT_FILE_ICON_SRC;
      }}
    />
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
