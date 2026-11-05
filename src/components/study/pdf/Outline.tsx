import { useState } from "react";
import { type PDFDocumentProxy } from "pdfjs-dist";
import { type PdfOutlineNode } from "@/study/pdfOutline";

interface OutlineNodeViewProps {
  node: PdfOutlineNode;
  depth: number;
  forceOpen: boolean;
  onPick: (page: number) => void;
}

export function OutlineNodeView({ node, depth, forceOpen, onPick }: OutlineNodeViewProps) {
  const [open, setOpen] = useState(depth < 2);
  const expanded = forceOpen || open;
  const hasChildren = node.items.length > 0;
  return (
    <div className="pdf-outline-node">
      <div className="pdf-outline-row" style={{ paddingLeft: 8 + depth * 14 }}>
        {hasChildren ? (
          <button
            className="pdf-outline-chevron"
            title={expanded ? "收起" : "展开"}
            onClick={() => setOpen((v) => !v)}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="pdf-outline-chevron placeholder" />
        )}
        <button
          className="pdf-outline-title"
          title={node.title}
          onClick={() => node.page !== null && onPick(node.page)}
        >
          {node.title}
        </button>
        {node.page !== null && <span className="pdf-outline-page">{node.page}</span>}
      </div>
      {hasChildren && expanded && (
        <div>
          {node.items.map((child, i) => (
            <OutlineNodeView
              key={`${i}-${child.title}`}
              node={child}
              depth={depth + 1}
              forceOpen={forceOpen}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** pdf.js outline destinations are either named (async lookup) or ref arrays. */
export async function resolveOutline(
  doc: PDFDocumentProxy,
  raw: unknown,
): Promise<PdfOutlineNode[]> {
  const list = Array.isArray(raw) ? raw : [];
  const resolveOne = async (item: unknown): Promise<PdfOutlineNode | null> => {
    if (!item || typeof item !== "object") return null;
    const record = item as {
      title?: unknown;
      dest?: unknown;
      items?: unknown;
    };
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) return null;
    let page: number | null = null;
    try {
      let dest = record.dest;
      if (typeof dest === "string") dest = await doc.getDestination(dest);
      if (Array.isArray(dest) && dest[0] !== undefined && dest[0] !== null) {
        page = (await doc.getPageIndex(dest[0])) + 1;
      }
    } catch {
      page = null;
    }
    const children = Array.isArray(record.items)
      ? (await Promise.all(record.items.map(resolveOne))).filter(
          (n): n is PdfOutlineNode => n !== null,
        )
      : [];
    return { title, page, items: children };
  };
  const nodes = await Promise.all(list.map(resolveOne));
  return nodes.filter((n): n is PdfOutlineNode => n !== null);
}
