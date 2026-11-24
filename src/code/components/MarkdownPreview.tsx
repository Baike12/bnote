import { useEffect, useMemo, useRef } from "react";
import { CodeBlock } from "@/components/CodeBlock";
import { splitAgentMarkdown } from "@/study/agentMarkdown";
import type { OpenFile } from "../store";
import { markdownImageResolver } from "../markdownPreview";

/**
 * The rendered document of an open markdown file (code mode).
 *
 * It covers the editor instead of replacing it: the editor stays mounted and
 * measured underneath, so toggling back to the source loses neither the undo
 * stack nor the caret. Turning the preview on moves the keyboard here — the
 * caret inside the covered editor must not keep consuming keystrokes
 * invisibly.
 */
export function MarkdownPreview({ root, file }: { root: string; file: OpenFile }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const blocks = useMemo(
    () =>
      splitAgentMarkdown(file.content, {
        image: markdownImageResolver(root, file.path),
        fencePreviews: false,
      }),
    [file.content, file.path, root],
  );

  useEffect(() => {
    // The root is focusable so PageUp / PageDown and the space bar scroll the
    // document; focusing it also takes the keyboard away from the covered
    // editor (see the component comment).
    hostRef.current?.focus({ preventScroll: true });
  }, [file.path]);

  return (
    <div
      ref={hostRef}
      className="code-md-preview"
      tabIndex={0}
      role="document"
      aria-label={`${file.path} 的渲染结果`}
    >
      <div className="agent-md">
        {blocks.map((block, index) => {
          if (block.kind === "code")
            return <CodeBlock key={index} code={block.code} lang={block.lang} />;
          if (block.kind === "markdown")
            return <div key={index} dangerouslySetInnerHTML={{ __html: block.html }} />;
          return null;
        })}
      </div>
    </div>
  );
}
