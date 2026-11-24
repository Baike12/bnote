import { useEffect, useState } from "react";
import { escapeCodeHtml, highlightCodeHtml } from "@/lib/codeHighlight";

/**
 * A read-only fenced code block with syntax highlighting.
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
    <pre className={`agent-code${langClass}`}>
      <code dangerouslySetInnerHTML={{ __html: html ?? escapeCodeHtml(code) }} />
    </pre>
  );
}
