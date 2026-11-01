import { fileIconKind, type FileIconKind } from "../fileIcon";

/**
 * 文件树图标:文件夹(开/合两态)+ 按分类画内芯的文件图标。
 *
 * 全部是 16×16 的描边 SVG(描边跟随 currentColor,颜色由 `.code-icon--*`
 * 类决定),与 bnote 其余图示同一套线性语言;不引图标库——只用得到十来个
 * 形状,多一个依赖不划算。
 */

/** 文件外框:四角折一下,右上角留出折页。 */
const FILE_PATH =
  "M4.5 1.6h4.1l3.9 3.8v9.1a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V2.6a1 1 0 0 1 1-1Z";

/** 每个分类在内芯画什么(共享外框)。 */
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

/** 文件图标;颜色取分类色(`.code-icon--<kind>`),默认走文件中性色。 */
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
      className={`code-tree-icon code-icon--${kind}`}
      aria-hidden="true"
    >
      <path d={FILE_PATH} />
      <path d="M8.6 1.7v3.7h3.8" />
      <Mark kind={kind} />
    </svg>
  );
}

/** 文件夹图标:开着的是「掀开的盖」,颜色也重一档。 */
export function FolderTypeIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`code-tree-icon ${open ? "code-icon--folder-open" : "code-icon--folder"}`}
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
