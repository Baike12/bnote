import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from "react";
import type { CodeProjectRef } from "@/state/appStore";
import { HtmlPreview } from "@/components/agent/HtmlPreview";
import { splitAgentMarkdown } from "@/study/agentMarkdown";
import { ThinkingBlock } from "./ThinkingBlock";
import {
  canonicalToolName,
  stripAgentTrailer,
  toolSummary,
  workDurationLabel,
} from "./toolSummary";
import {
  answerStepIndex,
  finalText,
  type ChatEntry,
  type ToolRecord,
  type Turn,
  type TurnStep,
} from "./model";
import { TodoRowView } from "./TodoPanel";
import { todoFromInput } from "./todos";
import { createAgentCards, type AgentCardData, type AgentCards } from "./agentCards";
import { elapsedMs, statusLabel, tokenLabel, type SubagentRun } from "./subagents";

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
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
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
            ? "输入 / 调用命令与技能、@ 引用项目文件;悬停消息点「⤷」可分叉"
            : "项目目录就是我的工作区,会话记录存放在 ~/.bnote"
          : creativeMode
            ? "输入 / 调用技能、@ 引用仓库文件;满意后点中栏的「发布」推到 bblog"
            : "悬停任意消息点「⤷」,可以从那里分叉一条辅助会话"}
      </p>
    </div>
  );
}

/**
 * One tool call, ZCode's ToolSummaryRow: a single line — category word (a
 * shimmer sweep while running, never a spinner: dozens of cards update per
 * turn and rotating loaders would keep re-rendering), the primary text, the
 * Edit +N/−N counts, the failure word only when it failed — and the raw IO
 * collapsed inside.
 */
function ToolCard({ tool }: { tool: ToolRecord }) {
  const running = tool.ok === undefined;
  const summary = toolSummary(tool.name, tool.input, running);
  const canonical = canonicalToolName(tool.name);
  // An Agent's output is model-addressed (it carries the agent id for a later
  // SendMessage); the card is read by the user, so the id line is dropped.
  const output =
    tool.output !== undefined && canonical === "Agent"
      ? stripAgentTrailer(tool.output)
      : tool.output;
  // A todo write is a plan, not a payload: the card shows the list the call
  // wrote (the same rows as the panel) instead of a wall of JSON.
  const todos = canonical === "TodoWrite" ? todoFromInput(tool.input) : null;
  // A no-argument tool (TodoRead, TaskList) has no input worth printing: the
  // `{}` line only pushes the result down.
  const input = JSON.stringify(tool.input ?? {}, null, 2);
  return (
    <details
      className="agent-tool"
      data-status={running ? "running" : tool.ok === false ? "fail" : "ok"}
    >
      <summary>
        <span className={`agent-tool-kind${running ? " is-running" : ""}`}>{summary.kind}</span>
        {summary.primary && <span className="agent-tool-primary">{summary.primary}</span>}
        {summary.diff && (
          <span className="agent-tool-diff">
            <span className="is-added">+{summary.diff.added}</span>
            <span className="is-removed">−{summary.diff.removed}</span>
          </span>
        )}
        {tool.ok === false && <span className="agent-tool-fail">失败</span>}
        <svg
          className="agent-tool-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </summary>
      {todos ? (
        <div className="agent-tool-todos">
          {todos.length === 0 ? (
            <div className="agent-todos-empty">清单已清空</div>
          ) : (
            todos.map((row, i) => <TodoRowView key={`${i}:${row.content}`} row={row} />)
          )}
        </div>
      ) : (
        <pre className="agent-tool-io">
          {input !== "{}" && input}
          {input !== "{}" && output !== undefined && "\n"}
          {output !== undefined && `→ ${output}`}
        </pre>
      )}
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

/**
 * The work rows in the order the provider streamed them: each thinking block
 * and each piece of assistant prose sits between the tool calls that ran
 * before and after it, so the section reads like the turn actually went
 * (thinking → text → tools → thinking → …) instead of one thought pinned above
 * every tool row. The open block — the last thinking row, still without a
 * duration — is the only one drawn as streaming.
 */
function TurnSteps({
  turn,
  steps,
  streaming,
  agents,
  onOpenAgent,
  onStopAgent,
}: {
  turn: Turn;
  steps: TurnStep[];
  streaming: boolean;
  agents: AgentCards;
  onOpenAgent: (convKey: string) => void;
  onStopAgent: (run: SubagentRun) => void;
}) {
  const tools = new Map(turn.tools.map((tool) => [tool.id, tool]));
  return (
    <>
      {steps.map((step, i) => {
        if (step.kind === "thinking") {
          return (
            <ThinkingBlock
              key={i}
              thinking={turn.thinking.slice(step.start, step.end)}
              streaming={streaming && step.seconds === null}
              seconds={step.seconds}
            />
          );
        }
        if (step.kind === "text") {
          return <AssistantText key={i} text={turn.text.slice(step.start, step.end)} />;
        }
        const tool = tools.get(step.id);
        return tool ? (
          <ToolRow
            key={i}
            tool={tool}
            agents={agents}
            onOpenAgent={onOpenAgent}
            onStopAgent={onStopAgent}
          />
        ) : null;
      })}
    </>
  );
}

/** One assistant prose row: the same renderer as a reply body, wherever it sits in the turn. */
const AssistantText = memo(function AssistantText({ text }: { text: string }) {
  // The parse (and KaTeX for every formula) is pure per text: without this it
  // re-runs for every row on every panel render — each composer keystroke, an
  // agent/content swap, a settings patch.
  const blocks = useMemo(() => splitAgentMarkdown(text), [text]);
  return (
    <div className="agent-md">
      {blocks.map((block, bi) =>
        block.kind === "html" ? (
          <HtmlPreview key={bi} code={block.code} />
        ) : (
          <div key={bi} dangerouslySetInnerHTML={{ __html: block.html }} />
        ),
      )}
    </div>
  );
});

/**
 * The collapsible around a turn's working process (ZCode's
 * ConversationWorkSegmentFlow): thinking, prose and tool cards live inside in
 * stream order, the final markdown stays outside and is always visible. While
 * the turn streams it is open ("工作中", ticking); when the turn ends it
 * auto-collapses to "已工作 N 秒" unless the user opened it by hand — their
 * choice wins, the same rule as ThinkingBlock. A turn that failed, that the
 * user stopped, or that ends on work instead of an answer stays open: the
 * intermediate rows are all there is to read.
 */
function TurnWork({
  entry,
  streaming,
  answer,
  children,
}: {
  entry: ChatEntry;
  streaming: boolean;
  /** Whether the turn ends on an answer drawn outside this section (nothing is lost when it collapses). */
  answer: boolean;
  children: ReactNode;
}) {
  const turn = entry.turn;
  const hasWork = Boolean(turn && (turn.tools.length > 0 || turn.thinking));
  const interactedRef = useRef(false);
  const [open, setOpen] = useState(streaming);
  const [now, setNow] = useState(() => Date.now());

  // The tick only runs while a live turn is collapsed-irrelevant (streaming):
  // one second of interval for at most the last turn, instead of one per card.
  useEffect(() => {
    if (!streaming) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);

  // Streaming → done edge: collapse once (ZCode's assistantHistoryDefaultOpen
  // flip). A turn that failed, was stopped, or left no answer outside stays
  // open — the work rows are all there is to read.
  useEffect(() => {
    if (!streaming && !interactedRef.current) {
      setOpen(Boolean(turn?.error) || turn?.stopReason === "aborted" || !answer);
    }
  }, [streaming, turn?.error, turn?.stopReason, answer]);

  if (!turn || !hasWork) return <>{children}</>;
  const liveMs = streaming && turn.startedAt != null ? now - turn.startedAt : (turn.turnMs ?? null);
  return (
    <details
      className={`agent-turn-work${streaming ? " is-streaming" : ""}`}
      open={open}
      onToggle={(e) => {
        const next = (e.target as HTMLDetailsElement).open;
        // Opening anything inside (a tool, the thinking) is the user inspecting
        // the work: their choice keeps the section open when the turn ends.
        if (next) interactedRef.current = true;
        // React dispatches a descendant's toggle to ancestor onToggle handlers
        // too; only this details' own toggle may write its open state, or
        // collapsing one tool would collapse the whole section (one writer).
        if (e.target !== e.currentTarget) return;
        setOpen(next);
      }}
    >
      <summary>
        <span className={`agent-turn-work-label${streaming ? " is-running" : ""}`}>
          {streaming
            ? "工作中"
            : turn.stopReason === "aborted"
              ? "已停止"
              : turn.error
                ? "已出错"
                : "已工作"}
          {(liveMs != null || turn.turnMs != null) && ` · ${workDurationLabel(liveMs)}`}
        </span>
        <svg
          className="agent-tool-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </summary>
      <div className="agent-turn-work-body">{children}</div>
    </details>
  );
}

/**
 * One entry row; `streaming` marks the live assistant reply (caret + thinking).
 *
 * Memoized: the panel re-renders on every composer keystroke and on every
 * agent/content swap, and re-walking the whole transcript there (markdown
 * parse, KaTeX, image rows) is wasted work — only the row whose entry changed
 * has anything new to draw. `onFork` therefore takes the index instead of a
 * freshly built closure, so its identity stays put.
 */
const EntryRow = memo(function EntryRow({
  entry,
  index,
  streaming,
  forkable,
  onFork,
  agents,
  onOpenAgent,
  onStopAgent,
}: {
  entry: ChatEntry;
  index: number;
  streaming: boolean;
  forkable: boolean;
  onFork: (index: number) => void;
  agents: AgentCards;
  onOpenAgent: (convKey: string) => void;
  onStopAgent: (run: SubagentRun) => void;
}) {
  const turn = entry.turn;
  // The turn's trailing text is the answer and is drawn outside the work
  // section; everything before it is the process and keeps its stream order
  // inside. A turn that ends on work has no answer row at all (its prose stays
  // where it was written).
  const answer = turn ? answerStepIndex(turn) : -1;
  const processSteps = turn ? (answer >= 0 ? turn.steps.slice(0, answer) : turn.steps) : [];
  const answerText = !turn ? entry.text : finalText(turn);
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
          <TurnWork entry={entry} streaming={streaming} answer={answerText !== ""}>
            {turn && (
              <TurnSteps
                turn={turn}
                steps={processSteps}
                streaming={streaming}
                agents={agents}
                onOpenAgent={onOpenAgent}
                onStopAgent={onStopAgent}
              />
            )}
            {turn?.error && <div className="agent-error">{turn.error}</div>}
          </TurnWork>
          {/* The answer row: the turn's trailing text. A turn that ends on
              tools has no such row — its prose stays inside the section, in
              position (an empty container would render as a blank bubble, so
              nothing is drawn when there is no text). */}
          {answerText && <AssistantText text={answerText} />}
          {streaming && <span className="agent-caret" aria-hidden="true" />}
        </div>
      )}
      {forkable && (
        <button
          className="agent-fork"
          title="基于这条消息开启辅助会话"
          onClick={() => onFork(index)}
        >
          ⤷
        </button>
      )}
    </div>
  );
});

/** A noop fork handler for nested rows: nothing inside a card is forkable. */
const NO_FORK = () => {};
/** Nested rows never hold subagent cards: a subagent cannot dispatch one. */
const EMPTY_CARDS = createAgentCards();
const NO_OPEN = () => {};
const NO_STOP = () => {};

/** How many of the child's latest entries an expanded card previews (Zed: 8). */
const SUBAGENT_PREVIEW_ENTRIES = 8;

/**
 * One tool row, or — when the call was an `Agent` — the subagent card that took
 * its place.
 *
 * The subscription is the point: a card is a live window into a child session
 * that streams tens of deltas per second, while the parent transcript must not
 * re-render for them. `useSyncExternalStore` hands the row the card's current
 * data and wakes it only when *that* card changed (the registry keeps one
 * reference until its run or entries move).
 */
function ToolRow({
  tool,
  agents,
  onOpenAgent,
  onStopAgent,
}: {
  tool: ToolRecord;
  agents: AgentCards;
  onOpenAgent: (convKey: string) => void;
  onStopAgent: (run: SubagentRun) => void;
}) {
  if (canonicalToolName(tool.name) !== "Agent") return <ToolCard tool={tool} />;
  return (
    <AgentToolRow tool={tool} agents={agents} onOpenAgent={onOpenAgent} onStopAgent={onStopAgent} />
  );
}

function AgentToolRow({
  tool,
  agents,
  onOpenAgent,
  onStopAgent,
}: {
  tool: ToolRecord;
  agents: AgentCards;
  onOpenAgent: (convKey: string) => void;
  onStopAgent: (run: SubagentRun) => void;
}) {
  const card = useSyncExternalStore(
    agents.subscribe,
    () => agents.get(tool.id),
    () => null,
  );
  // A call with no run (queued behind the concurrency limit, or a run restored
  // from disk without its live session) keeps the plain tool row.
  if (!card) return <ToolCard tool={tool} />;
  return (
    <SubagentCard
      tool={tool}
      card={card}
      onOpen={() => onOpenAgent(card.run.convKey)}
      onStop={() => onStopAgent(card.run)}
    />
  );
}

/**
 * A subagent drawn where it was dispatched (Zed's subagent card): the header
 * says who is working and how long, a click opens the last few entries of its
 * own timeline inline, and 放大查看 puts that timeline in the main column.
 *
 * The header never shows the agent id — the label is the description the model
 * wrote for the task, which is what the user can recognize.
 */
function SubagentCard({
  tool,
  card,
  onOpen,
  onStop,
}: {
  tool: ToolRecord;
  card: AgentCardData;
  onOpen: () => void;
  onStop: () => void;
}) {
  const { run, entries } = card;
  const running = run.status === "running";
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // One interval for the whole card, and only while it runs: a finished run's
  // duration is frozen.
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const bodyRef = useRef<HTMLDivElement>(null);
  // Follow the tail while the agent works, but never yank the view back when
  // the reader scrolled up to read an earlier row.
  const followRef = useRef(true);
  const preview =
    entries.length > SUBAGENT_PREVIEW_ENTRIES ? entries.slice(-SUBAGENT_PREVIEW_ENTRIES) : entries;
  useEffect(() => {
    const el = bodyRef.current;
    if (!open || !el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [open, entries, running]);

  const meta = [workDurationLabel(elapsedMs(run, now)), tokenLabel(run.tokens)]
    .filter(Boolean)
    .join(" · ");
  // A run that ended without any text (the report fallback: "没有产出报告…")
  // would leave the body looking empty; that message is the one thing the user
  // must see, so it is drawn as the report. Runs that did answer carry their
  // report in the entries already and are not repeated here.
  const answered = entries.some((entry) => entry.role === "assistant" && entry.text.trim() !== "");
  const report =
    !running && !answered && tool.output !== undefined ? stripAgentTrailer(tool.output).trim() : "";

  return (
    <div className="agent-sub" data-status={run.status}>
      <div className="agent-sub-head">
        <button
          className="agent-sub-toggle"
          aria-expanded={open}
          title={run.report ?? run.label}
          onClick={() => {
            followRef.current = true;
            setOpen((value) => !value);
          }}
        >
          <span className={`agent-run-dot is-${run.status}`} aria-hidden="true" />
          <span className="agent-sub-label">{run.label}</span>
          <span className="agent-sub-model">{run.model}</span>
          <span className="agent-sub-meta">
            {running ? meta || "刚刚开始" : `${statusLabel(run.status)}${meta ? ` · ${meta}` : ""}`}
          </span>
          <svg
            className="agent-tool-chevron"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
        {running && (
          <button
            className="agent-run-stop"
            title="停止这个子代理"
            aria-label="停止这个子代理"
            onClick={onStop}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width="10" height="10">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        )}
      </div>
      {open && (
        <>
          <div
            className="agent-sub-body"
            ref={bodyRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {preview.length === 0 ? (
              <div className="agent-sub-empty">{running ? "正在准备…" : "没有可显示的过程"}</div>
            ) : (
              preview.map((entry, i) => (
                <EntryRow
                  key={entries.length - preview.length + i}
                  entry={entry}
                  index={i}
                  streaming={running && i === preview.length - 1 && entry.role === "assistant"}
                  forkable={false}
                  onFork={NO_FORK}
                  agents={EMPTY_CARDS}
                  onOpenAgent={NO_OPEN}
                  onStopAgent={NO_STOP}
                />
              ))
            )}
            {report !== "" && <pre className="agent-sub-report">{report}</pre>}
          </div>
          <button className="agent-sub-max" title="放大查看这个子代理的完整过程" onClick={onOpen}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
            放大查看
          </button>
        </>
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
  allowFork = true,
  agents,
  onOpenAgent,
  onStopAgent,
}: {
  scrollRef: Ref<HTMLDivElement>;
  entries: ChatEntry[];
  busy: boolean;
  welcome: ReactNode;
  onFork: (index: number) => void;
  /** A subagent's transcript is read-only: no fork handles (its session is not the app's to fork). */
  allowFork?: boolean;
  /** The live subagent cards, keyed by the `Agent` tool call that launched them. */
  agents: AgentCards;
  onOpenAgent: (convKey: string) => void;
  onStopAgent: (run: SubagentRun) => void;
}) {
  // The shade lives in a sibling overlay, not inside the scroller: an absolute
  // child of a scroll container would scroll away with the content. It is the
  // same "already read" veil as the PDF pane (.pdf-read-shade), fixed to the
  // top half of the visible column.
  return (
    <div className="agent-transcript-wrap">
      <div className="agent-scroll" ref={scrollRef}>
        {entries.length === 0
          ? welcome
          : entries.map((entry, i) => (
              <EntryRow
                key={i}
                entry={entry}
                index={i}
                streaming={i === entries.length - 1 && busy && entry.role === "assistant"}
                forkable={allowFork && !busy}
                onFork={onFork}
                agents={agents}
                onOpenAgent={onOpenAgent}
                onStopAgent={onStopAgent}
              />
            ))}
      </div>
      <div className="agent-read-guide" aria-hidden="true">
        <div className="agent-read-shade" />
      </div>
    </div>
  );
}
