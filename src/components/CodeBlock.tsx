import { useEffect, useRef, useState } from "react";
import { writeClipboardText } from "@/lib/clipboard";
import { escapeCodeHtml, highlightCodeHtml } from "@/lib/codeHighlight";

type CopyState = "idle" | "copied" | "failed";

/**
 * The copy affordance pinned to a code block's top-right corner.
 *
 * It writes the block's source, not its highlighted HTML: the span markup the
 * parser produces is not what a paste is for. The state resets after 1.5 s, and
 * a result that lands after the block unmounted (the reply scrolled out, a new
 * one replaced it) never touches the dead row.
 */
function CopyCodeButton({ code }: { code: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const mountedRef = useRef(true);
  const resetRef = useRef<number | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
    };
  }, []);
  const copy = () => {
    void writeClipboardText(code).then((ok) => {
      if (!mountedRef.current) return;
      setState(ok ? "copied" : "failed");
      if (resetRef.current !== null) window.clearTimeout(resetRef.current);
      resetRef.current = window.setTimeout(() => {
        if (mountedRef.current) setState("idle");
      }, 1500);
    });
  };
  const label = state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制代码";
  return (
    <button
      type="button"
      className="agent-code-copy"
      title={label}
      aria-label={label}
      onClick={copy}
    >
      {state === "copied" ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m5 12 5 5 9-9" />
        </svg>
      ) : state === "failed" ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V6a2 2 0 0 1 2-2h9" />
        </svg>
      )}
    </button>
  );
}

/**
 * A read-only fenced code block with syntax highlighting and a copy button.
 *
 * The parser and the palette are the code editor's own (see
 * `lib/codeHighlight.ts`), so an agent reply and a markdown preview read like
 * the file open in the code pane. The escaped source paints immediately; the
 * highlighted HTML replaces it when the parser is ready, and a result that
 * belongs to an older `code` (the reply is still streaming) is dropped.
 */
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!lang) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    void highlightCodeHtml(code, lang).then((value) => {
      if (!cancelled) setHtml(value);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  // The class is built from the fence name as a whole: a name with quotes or
  // spaces would break out of the attribute, so only a simple token passes.
  const langClass = /^[\w+#.-]+$/.test(lang) ? ` language-${lang}` : "";
  return (
    <div className="agent-code-wrap">
      <pre className={`agent-code${langClass}`}>
        <code dangerouslySetInnerHTML={{ __html: html ?? escapeCodeHtml(code) }} />
      </pre>
      <CopyCodeButton code={code} />
    </div>
  );
}
