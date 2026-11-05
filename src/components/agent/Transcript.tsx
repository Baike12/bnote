import type { ReactNode, Ref } from "react";
import type { AgentTodoItem } from "@/lib/tauri";
import type { CodeProjectRef } from "@/state/appStore";
import { HtmlPreview } from "@/components/HtmlPreview";
import { splitAgentMarkdown } from "@/study/agentMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";
import type { ChatEntry, ToolRecord } from "./model";

/** The empty state: what this session is for, by mode. */
export function AgentWelcome({
  mode,
  creativeMode,
  codeProject,
}: {
  mode: "notes" | "study" | "code" | "projects";
  creativeMode: boolean;
  codeProject: CodeProjectRef | null;
}) {
  return (
    <div className="agent-welcome">
      <div className="agent-welcome-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
        </svg>
      </div>
      <p className="agent-welcome-title">
        {mode === "code"
          ? codeProject
            ? "编码模式:我直接读写当前代码仓库并运行命令"
            : "先在中栏打开一个代码项目"
          : creativeMode
            ? "创作模式:生成 HTML 会在中栏实时预览"
            : "问我关于当前 PDF / 网页的问题"}
      </p>
      <p className="agent-hint">
        {mode === "code"
          ? codeProject
            ? "开工前列 todo(/compact 可手动压缩上下文);悬停消息点「⤷」可分叉"
            : "项目目录就是我的工作区,会话记录存放在 ~/.bnote"
          : creativeMode
            ? "输入 / 调用技能、@ 引用仓库文件;满意后点中栏的「发布」推到 bblog"
            : "悬停任意消息点「⤷」,可以从那里分叉一条辅助会话"}
      </p>
    </div>
  );
}

/** One tool call: collapsed by default, the input JSON and the output inside. */
function ToolCard({ tool }: { tool: ToolRecord }) {
  return (
    <details className="agent-tool">
      <summary>
        <span
          className={`agent-tool-dot${
            tool.ok === false ? " fail" : tool.ok === undefined ? " running" : ""
          }`}
        />
        <span className="agent-tool-name">{tool.name}</span>
        {tool.ok === false && <span className="agent-tool-fail">失败</span>}
        <svg className="agent-tool-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </summary>
      <pre className="agent-tool-io">
        {JSON.stringify(tool.input, null, 2)}
        {tool.output !== undefined && `\n→ ${tool.output}`}
      </pre>
      {tool.images && tool.images.length > 0 && (
        <div className="agent-msg-images">
          {tool.images.map((img, j) => (
            <img
              key={j}
              className="agent-msg-image"
              src={`data:${img.mediaType};base64,${img.data}`}
              alt="工具返回的截图"
            />
          ))}
        </div>
      )}
    </details>
  );
}

/** One entry row; `streaming` marks the live assistant reply (caret + thinking). */
function EntryRow({
  entry,
  streaming,
  forkable,
  onFork,
}: {
  entry: ChatEntry;
  streaming: boolean;
  forkable: boolean;
  onFork: () => void;
}) {
  return (
    <div className={`agent-msg-row${entry.role === "user" ? " is-user" : ""}`}>
      {entry.role === "notice" ? (
        <div className="agent-notice">{entry.text}</div>
      ) : entry.role === "user" ? (
        <div className="agent-msg agent-msg-user">
          {entry.images && entry.images.length > 0 && (
            <div className="agent-msg-images">
              {entry.images.map((img, j) => (
                <img
                  key={j}
                  className="agent-msg-image"
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt="随消息发送的图片"
                />
              ))}
            </div>
          )}
          {entry.text}
        </div>
      ) : (
        <div className="agent-msg agent-msg-assistant">
          <ThinkingBlock
            thinking={entry.turn?.thinking ?? ""}
            streaming={Boolean(streaming && (entry.turn?.thinking ?? ""))}
            seconds={entry.turn?.thinkSeconds ?? null}
          />
          {entry.turn?.tools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
          {entry.turn?.error && <div className="agent-error">{entry.turn.error}</div>}
          <div className="agent-md">
            {splitAgentMarkdown(entry.text).map((block, bi) =>
              block.kind === "html" ? (
                <HtmlPreview key={bi} code={block.code} />
              ) : (
                <div key={bi} dangerouslySetInnerHTML={{ __html: block.html }} />
              ),
            )}
          </div>
          {streaming && <span className="agent-caret" aria-hidden="true" />}
        </div>
      )}
      {forkable && (
        <button className="agent-fork" title="基于这条消息开启辅助会话" onClick={onFork}>
          ⤷
        </button>
      )}
    </div>
  );
}

/**
 * The scrolling conversation body: the welcome state when there is nothing
 * yet, otherwise the entries. Only the last assistant entry can be the live
 * one (the panel's `busy` session and this entry being last).
 */
export function AgentTranscript({
  scrollRef,
  entries,
  busy,
  welcome,
  onFork,
}: {
  scrollRef: Ref<HTMLDivElement>;
  entries: ChatEntry[];
  busy: boolean;
  welcome: ReactNode;
  onFork: (index: number) => void;
}) {
  return (
    <div className="agent-scroll" ref={scrollRef}>
      {entries.length === 0
        ? welcome
        : entries.map((entry, i) => (
            <EntryRow
              key={i}
              entry={entry}
              streaming={i === entries.length - 1 && busy && entry.role === "assistant"}
              forkable={!busy}
              onFork={() => onFork(i)}
            />
          ))}
    </div>
  );
}

/** The todo tool's latest list, above the composer. */
export function AgentTodos({ todos }: { todos: AgentTodoItem[] }) {
  if (todos.length === 0) return null;
  return (
    <div className="agent-todos" aria-label="任务清单">
      {todos.map((t) => (
        <div key={t.content} className={`agent-todo is-${t.status}`}>
          <span className="agent-todo-mark" aria-hidden="true">
            {t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○"}
          </span>
          <span className="agent-todo-text">
            {t.status === "in_progress" ? t.active_form : t.content}
          </span>
        </div>
      ))}
    </div>
  );
}
