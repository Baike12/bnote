import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  agentApi,
  homeApi,
  type AgentChatItem,
  type AgentEvent,
  type AgentTodoItem,
  type MaterialInfo,
  type SavedSessionMeta,
  type SessionModelConfig,
  type SkillInfo,
  type StudyContent,
} from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { imeOnChineseFocus, imeSyncToEditor } from "@/editor/imeSwitch";
import { isImeEnter } from "@/lib/imeEnter";
import { forkLabel } from "@/study/agentFork";
import { DEFAULT_AGENT_FONT, stepAgentFont } from "@/study/agentFont";
import { ensureMaterial, sessionFilePath } from "@/study/materials";
import { transcriptIO } from "@/study/transcriptIO";
import {
  codeSessionIdentity,
  codeSessionPath,
  type CodeSessionScope,
} from "@/code/sessionScope";
import { cleanGeneratedTitle, displayTitle } from "@/study/sessionTitle";
import { resolveFamily, type SessionNode } from "@/study/sessionTree";
import {
  buildSessionMeta,
  historyFromTranscript,
  parseTranscript,
  serializeTranscript,
  sessionMetaFromRaw,
  sessionTitleFromLines,
  turnLines,
  type TranscriptLine,
  type TranscriptUserLine,
} from "@/study/transcript";
import { isWereadUrl } from "@/study/weread";
import { applySuggestion, parseSuggestTrigger, type SuggestTrigger } from "@/agent/suggest";
import { AgentHeader } from "@/components/AgentHeader";
import { buildSuggestItems, AgentSuggest, type SuggestItem } from "@/components/AgentSuggest";
import { HtmlPreview } from "@/components/HtmlPreview";
import { splitAgentMarkdown } from "@/study/agentMarkdown";
import {
  contextLabel,
  formatPercent,
  formatTokenCount,
  occupancyPercent,
  usageTitle,
  type AgentUsage,
} from "@/study/agentUsage";
import {
  MAX_IMAGES_PER_MESSAGE,
  fileToAgentImage,
  type AgentImage,
} from "@/study/agentImages";

interface ToolRecord {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  ok?: boolean;
  /** The screenshots the tool returns to the model with the result (a rendered preview for instance); they are only displayed. */
  images?: AgentImage[];
}

interface Turn {
  /** Streaming text buffer for the current assistant reply. */
  text: string;
  /** The streamed thinking process (plain text; it does not enter the session history, it is only displayed). */
  thinking: string;
  /** Timestamp of the first thinking delta (used for the timer). */
  thinkingStart: number | null;
  /** How long the thinking took (in seconds, computed and frozen when the turn ends). */
  thinkSeconds: number | null;
  tools: ToolRecord[];
  error?: string;
}

interface ChatEntry {
  role: "user" | "assistant" | "notice";
  text: string;
  /** The timestamp written into the session record. */
  at: number;
  /** The screenshots and images attached to a user message (display only; on the model side the backend session history is the truth). */
  images?: AgentImage[];
  turn?: Turn;
  /**
   * The number of entries of the backend session history "up to and including
   * this one". user = the previous one + 1; assistant = the authoritative
   * count the backend reports with the turn_end / error events (see
   * agentFork.ts). null = still unknown (it errored and no count could be
   * obtained).
   */
  items: number | null;
}

/** One session inside the panel: the main session, or an auxiliary session forked from some message. */
interface Conv {
  key: string;
  sessionId: string | null;
  entries: ChatEntry[];
  label: string;
  /** The session this one was forked from; null for the main session. */
  parent: string | null;
  /** The summary of an auxiliary session (the first line of the source message). */
  basedOn: string;
  /**
   * The number of copied prefix entries at the time of the fork:
   * `entries[forkAt]` is the first message that belongs to this session
   * itself. The title has to use it, the question of the parent session
   * must not stand in for it.
   */
  forkAt: number;
  /** Where the title comes from: llm = the model generated it (it is not generated again after a restart). */
  titleSource: "llm" | "first-message";
  /**
   * A session level error (start failed / send failed). It is displayed
   * persistently at the top of the conversation (following ZCode's
   * ChatErrorBanner) until the user retries or closes it, instead of only a
   * toast that disappears after a few seconds: most of the "sending got no
   * answer" cases the user sees are exactly such failures swallowed by a
   * toast.
   */
  error?: string;
  /** Where the error came from, it decides what the "retry" button does. */
  errorKind?: "start" | "send";
  /** The todo tool's latest list (rendered above the composer; transient). */
  todos: AgentTodoItem[];
  /** The MCP connection failures the backend reported at startup (an empty array = everything is fine). */
  mcpErrors: string[];
  /**
   * The session record file (`<material dir>/sessions/<id>.jsonl`). null =
   * there is no id yet (just started / the start failed) or the browser
   * cannot write to disk.
   */
  transcriptPath: string | null;
  /** The session id in the file name (the history drawer highlights the current entry with it). */
  sessionFileId: string | null;
  /** The transcript lives in the agent home (`~/.bnote`) instead of the vault (coding sessions). */
  transcriptHome?: boolean;
  /** The model config snapshot of this session at the moment it started: later setting changes do not affect it, and the restore continues with it. */
  model: SessionModelConfig | null;
  /** The token usage of the last model request (the context usage = input + output). */
  usage: AgentUsage | null;
}

/** Identity of the material a session is pinned to (url re-open = same key). */
function studyContentKey(content: StudyContent | null): string {
  if (!content) return "none";
  if (content.kind === "pdf") return `pdf:${content.path}`;
  return `url:${content.url}`;
}

/** A list entry turned into the node used to resolve the family (missing fields mean the main session / an empty prefix). */
function toSessionNode(meta: SavedSessionMeta): SessionNode {
  return {
    id: meta.id,
    title: meta.title,
    parent: meta.parent ?? null,
    basedOn: meta.basedOn ?? "",
    forkAt: meta.forkAt ?? 0,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

function findConvBySession(convs: Conv[], sessionId: string): Conv | undefined {
  return convs.find((c) => c.sessionId === sessionId);
}

let convSeq = 0;
function nextConvKey(): string {
  convSeq += 1;
  return `c${convSeq}`;
}

/** The distance within which the thinking summary counts as pinned to the bottom (same value as ZCode's reasoning: within 2 px of the bottom). */
const THINKING_BOTTOM_LOCK_PX = 2;

/** The summary line: the last line of non-empty text (the same logic as ZCode's resolveReasoningStreamingSummary). */
export function thinkingSummaryLine(thinking: string): string {
  const lines = thinking.replace(/\r\n?/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = lines[i]?.trim() ?? "";
    if (text) return text;
  }
  return "";
}

/**
 * The collapsible block of the thinking process, modelled after ZCode's
 * Reasoning (the modified vercel/ai-elements): while streaming it is
 * collapsed, the summary line shows the last line of the thinking text and
 * scrolls to the end; when it is done the label becomes "thinking, lasted N
 * seconds". The content is shown as plain text (no markdown rendering: the
 * thinking is appended while streaming and rerunning the markdown parser on
 * every delta stutters on a long thinking). The open state scrolls inside a
 * limited height, sticks to the bottom by default, pauses when the user
 * scrolls away from the bottom and resumes when they scroll back.
 */
function ThinkingBlock({
  thinking,
  streaming,
  seconds,
}: {
  thinking: string;
  streaming: boolean;
  seconds: number | null;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const tailRef = useRef<HTMLSpanElement | null>(null);
  const stickBottomRef = useRef(true);
  const interactedRef = useRef(false);
  const [open, setOpen] = useState(false);

  // Streaming append: it sticks to the bottom while open; while collapsed the viewport of the single summary line is pushed to the end (the old content moves left).
  useEffect(() => {
    if (!streaming) return;
    if (open) {
      if (stickBottomRef.current) {
        const el = bodyRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
    } else {
      const tail = tailRef.current;
      if (tail) tail.scrollLeft = tail.scrollWidth;
    }
  }, [thinking, open, streaming]);

  // Collapse at the end of the output (ZCode autoCollapseKey): when the turn ends and the user has not opened the block manually, it returns to the collapsed state. Once the user has opened it (interacted) their choice is respected.
  useEffect(() => {
    if (!streaming && !interactedRef.current) setOpen(false);
  }, [streaming]);

  if (!thinking) return null;
  const tail = streaming && !open ? thinkingSummaryLine(thinking) : "";
  return (
    <details
      className={`agent-thinking${streaming ? " is-streaming" : ""}`}
      open={open}
      onToggle={(e) => {
        const next = (e.target as HTMLDetailsElement).open;
        if (next) interactedRef.current = true;
        setOpen(next);
      }}
    >
      <summary>
        <svg className="agent-thinking-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 4.5a3 3 0 0 0-3 3v.5a3 3 0 0 0-1.5 5.6A3 3 0 0 0 9 18.5a2.6 2.6 0 0 0 3 0 2.6 2.6 0 0 0 3 0 3 3 0 0 0 1.5-4.9A3 3 0 0 0 15 8v-.5a3 3 0 0 0-3-3Z" />
          <path d="M12 4.5V3M9.8 11.2c.7.5 1.6.5 2.2 0 .6.5 1.5.5 2.2 0M10 14.5h4" />
        </svg>
        {streaming ? (
          <span className="agent-thinking-live">正在思考</span>
        ) : (
          <span className="agent-thinking-done">
            思考
            <span className="agent-thinking-sec"> · 持续了 {seconds ?? 0} 秒</span>
          </span>
        )}
        {tail && (
          <span className="agent-thinking-tail" ref={tailRef}>
            <span className="agent-thinking-tail-text">{tail}</span>
          </span>
        )}
      </summary>
      <div
        className="agent-thinking-body"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickBottomRef.current =
            el.scrollHeight - el.clientHeight - el.scrollTop <= THINKING_BOTTOM_LOCK_PX;
        }}
      >
        {thinking}
      </div>
    </details>
  );
}

/** A session record line turned into a UI message (used when a session is restored). */
function entryFromLine(line: TranscriptLine): ChatEntry {
  if (line.type === "user") {
    return {
      role: "user",
      text: line.text,
      at: line.at,
      items: null,
      images: line.images,
    };
  }
  return {
    role: "assistant",
    text: line.text,
    at: line.at,
    items: null,
    turn: {
      text: line.text,
      thinking: line.thinking ?? "",
      thinkingStart: null,
      thinkSeconds: line.thinkSeconds ?? null,
      tools: line.tools ?? [],
      error: line.error,
    },
  };
}

/** A UI message turned into a session record line (when forking, the prefix of the parent session is written into the new file). */
function entriesToLines(entries: ChatEntry[]): TranscriptLine[] {
  // Notice entries are display-only status lines, never transcript content.
  return entries
    .filter((e) => e.role !== "notice")
    .map((e): TranscriptLine =>
    e.role === "user"
      ? { type: "user", at: e.at, text: e.text, images: e.images }
      : {
          type: "assistant",
          at: e.at,
          text: e.text,
          thinking: e.turn?.thinking ?? "",
          thinkSeconds: e.turn?.thinkSeconds ?? null,
          tools: e.turn?.tools ?? [],
          error: e.turn?.error,
        },
    );
}

function cloneEntry(e: ChatEntry): ChatEntry {
  return {
    ...e,
    images: e.images?.map((img) => ({ ...img })),
    turn: e.turn ? { ...e.turn, tools: e.turn.tools.map((t) => ({ ...t })) } : undefined,
  };
}

/** The time in the history session list: today shows hours and minutes, older entries show month and day. */
function formatSessionTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Size the composer to its content: one line at rest, up to twelve visible
 * lines (the cap is in CSS, which then scrolls).
 *
 * `auto` first, then the content height: without the reset the element keeps
 * its previous height and `scrollHeight` cannot shrink after a deletion.
 */
function fitInputHeight(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * The left column of study mode: asking questions about the current content.
 *
 * The session model: a main session (follows the current PDF or web page,
 * it is reopened when the content or the config changes) plus a few
 * auxiliary sessions (forked from any message with the "fork" button, the
 * backend copies the history prefix and the original session stays
 * untouched). The dropdown in the header and ⌘⇧Y switch between the
 * sessions.
 *
 * The events are routed by sessionId: a streaming reply of a background
 * session (one that is not displayed) is still written into its own entries
 * and is complete when the user switches back to it.
 *
 * The panel stays mounted in the three column layout (it is there as soon as
 * study mode is entered), so the main session is created as soon as the
 * content is ready: opening a material connects once, switching the material
 * opens it again.
 */
/** The three permission modes of the composer (ZCode's selector shape). */
const PERMISSION_MODES: {
  id: "confirm" | "auto" | "full" | "plan";
  label: string;
  description: string;
}[] = [
  { id: "confirm", label: "变更前确认", description: "改文件、跑命令前先问我。" },
  { id: "auto", label: "自主模式", description: "在有风险时询问。" },
  { id: "full", label: "完全访问", description: "减少确认次数。" },
  { id: "plan", label: "计划模式", description: "只读调研;计划经你批准后才开始改文件。" },
];

function ShieldIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5 5 6v5.2c0 4.2 2.9 7.6 7 9.3 4.1-1.7 7-5.1 7-9.3V6l-7-2.5Z" />
    </svg>
  );
}

interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** `ask_user_question` arrives as unknown JSON: narrow it before rendering. */
function parseQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question : "";
    if (!question) continue;
    const options: { label: string; description?: string }[] = [];
    if (Array.isArray(record.options)) {
      for (const option of record.options) {
        if (!option || typeof option !== "object") continue;
        const entry = option as Record<string, unknown>;
        if (typeof entry.label !== "string") continue;
        options.push({
          label: entry.label,
          description: typeof entry.description === "string" ? entry.description : undefined,
        });
      }
    }
    out.push({
      question,
      header: typeof record.header === "string" ? record.header : undefined,
      multiSelect: record.multiSelect === true,
      options,
    });
  }
  return out;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function AgentPanel() {
  const studyContent = useAppStore((s) => s.studyContent);
  const mode = useAppStore((s) => s.mode);
  const codeProject = useAppStore((s) => s.codeProject);
  const creativeMode = useAppStore((s) => s.creativeMode);
  const setCreativeMode = useAppStore((s) => s.setCreativeMode);
  const flatFiles = useAppStore((s) => s.flatFiles);
  const recentFiles = useAppStore((s) => s.recentFiles);
  const currentFile = useAppStore((s) => s.currentFile);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const agentConfigVersion = useAppStore((s) => s.agentConfigVersion);
  const agentSwitchSignal = useAppStore((s) => s.agentSwitchSessionSignal);
  const agentPanelCommand = useAppStore((s) => s.agentPanelCommand);
  const showToast = useAppStore((s) => s.showToast);
  const patchSettings = useAppStore((s) => s.patchSettings);
  /** The conversation font scale: it is written to the --agent-fs of the panel root, and both the body text and the derived sizes in the CSS multiply it. */
  const agentFontScale = useAppStore((s) => s.settings.agentFontScale);
  const permissionMode = useAppStore((s) => s.settings.agentPermissionMode);
  /**
   * The session entered plan mode through EnterPlanMode. This is session
   * state, not the composer preference: the composer mode is what the next
   * session starts with, and the agent must not change the user's default.
   */
  const [planActive, setPlanActive] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const modeRef = useRef<HTMLDivElement | null>(null);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [input, setInput] = useState("");
  /** The images waiting to be sent (pasted screenshots / picked files), they enter the backend session history together with the message. */
  const [pendingImages, setPendingImages] = useState<AgentImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** The IME composition session (bookkeeping via compositionstart/end): Enter must not send while a candidate is confirmed. */
  const composingRef = useRef(false);
  const [starting, setStarting] = useState(false);
  const [busySession, setBusySession] = useState<string | null>(null);
  /** The saved Agent config (model / context window); the footnote can show it even before a session exists. */
  const [agentConfig, setAgentConfig] = useState<{ model: string; contextWindow: number } | null>(
    null,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const convsRef = useRef<Conv[]>([]);
  /** The restore generation: after switching the material, starting a new session or restoring the family again, the old read results are all void. */
  const restoreTokenRef = useRef(0);
  /** The sessions whose lazy start was already kicked off (it is started only once per switch, it does not wait for the first one to come back). */
  const lazyStartingRef = useRef<Set<string>>(new Set());
  /** convKey -> the first message of that session itself: after the first turn succeeded it is used to let the model name the session. */
  const titleSeedRef = useRef<Map<string, string>>(new Map());
  /** The sessions whose title was already requested (a failure is not retried, the local fallback title stays). */
  const titleAskedRef = useRef<Set<string>>(new Set());
  const turnsRef = useRef<Map<string, Turn>>(new Map());
  const busyRef = useRef<string | null>(null);
  /** The content plus config a main session was already created for. */
  const startedKeyRef = useRef<string | null>(null);
  /** The request sequence number of the session start: an expired callback (the content or the config changed) is dropped instead of writing blindly. */
  const startTokenRef = useRef(0);
  /** The "restart the main session" button of ⌘⇧Y shares the same start path. */
  const [restartNonce, setRestartNonce] = useState(0);
  /** The output directory of this material (annotations + session records) and the list of the saved sessions. */
  const studyWereadBook = useAppStore((s) => s.studyWereadBook);
  /** The heading of the history drawer: which material / project these sessions belong to. */
  const [scopeLabel, setScopeLabel] = useState<{ title: string; detail: string } | null>(null);
  const [savedSessions, setSavedSessions] = useState<SavedSessionMeta[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** A tool marked `ask` is waiting for approval. */
  const [approval, setApproval] = useState<{
    sessionId: string;
    id: string;
    tool: string;
    input: unknown;
  } | null>(null);
  const [approvalFeedback, setApprovalFeedback] = useState("");
  /** `ask_user_question` is waiting for an answer. */
  const [pendingQuestion, setPendingQuestion] = useState<{
    sessionId: string;
    id: string;
    questions: AskQuestion[];
  } | null>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<number, string[]>>({});
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The composer grows with the text and rests at one line: a fixed two-row
  // field left an empty second line under every short question.
  useEffect(() => {
    const el = inputRef.current;
    if (el) fitInputHeight(el);
  }, [input, agentFontScale]);

  // A width change re-wraps the same text, so the needed height changes
  // without any input event (the study column can be dragged narrower). Only
  // the width is watched: reacting to our own height write would loop.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitInputHeight(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const historyRef = useRef<HTMLDivElement>(null);
  const historyFocusPending = useRef(false);
  /** agentPanelCommand is an increasing counter: only the entry that is newer than the last one is executed. */
  const lastAgentCommandSeq = useRef(0);
  const materialRef = useRef<{ identity: string; info: MaterialInfo | null } | null>(null);
  /**
   * The coding session scope: its transcript lives in the agent home
   * (`~/.bnote/projects/<project>/`), not in the vault. The identity is
   * `code:<project root>` so switching projects switches the session family
   * while a restart within one project restores the previous one.
   */
  const codeScopeRef = useRef<CodeSessionScope | null>(null);
  /** convKey -> the session record file. It is written when the start succeeded or the session was restored and appended after every turn. */
  const transcriptRef = useRef<Map<string, string>>(new Map());
  /** sessionId -> { convKey, record file }: the closing events of a session that was switched away still have to be written to disk. */
  const sessionIndexRef = useRef<
    Map<string, { convKey: string; path: string | null; home: boolean }>
  >(new Map());
  /** convKey -> whether the record lives in the agent home (coding sessions). Read by persistTurn, which may run after the conv left the list. */
  const transcriptHomeRef = useRef<Map<string, boolean>>(new Map());
  /** convKey -> whether the metadata line (title + model snapshot) was already written. It is written once per session and always at the very front of the file. */
  const metaWrittenRef = useRef<Map<string, boolean>>(new Map());
  /** convKey -> the model config snapshot of the session (used to write the metadata line; it also has to be available for the closing turn of a session that was switched away). */
  const modelByConvRef = useRef<Map<string, SessionModelConfig | null>>(new Map());
  /** The user message of a turn is recorded here first and written to disk together with the assistant reply (nothing is written when the send failed). */
  const pendingUserRef = useRef<Map<string, TranscriptUserLine>>(new Map());
  /** The restart counter (the reload / the plus for a new session): when it changes a new session is opened instead of restoring the most recent one. */
  const restartKeyRef = useRef<number | null>(null);
  /** The latest value of creativeMode (read through the ref inside the useCallback closure of startSession). */
  const creativeModeRef = useRef(creativeMode);
  useEffect(() => {
    creativeModeRef.current = creativeMode;
  }, [creativeMode]);
  /**
   * Which agent definition the session runs with: code mode gets the coding
   * agent, creative mode wins inside study mode, everything else is the study
   * assistant. Kept in a ref so startSession (a long-lived callback) sees the
   * current shape without re-creating it.
   */
  const agentModeRef = useRef<"study" | "creative" | "coding">("study");
  useEffect(() => {
    agentModeRef.current = mode === "code" ? "coding" : creativeMode ? "creative" : "study";
  }, [mode, creativeMode]);
  /**
   * Prompt history (↑ / ↓ recall): the entries come from
   * `~/.bnote/history.jsonl`, filtered to the current project, and are fetched
   * lazily on the first ↑ inside an empty box.
   */
  const historyItemsRef = useRef<string[] | null>(null);
  const historyIndexRef = useRef(-1);
  const historyLoadingRef = useRef(false);
  /** The completion state of the input box: the skills, the @ file trigger and the selected index. */
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [suggestTrigger, setSuggestTrigger] = useState<SuggestTrigger | null>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);

  useEffect(() => {
    convsRef.current = convs;
  }, [convs]);
  /** A live copy of the key of the current session (the shortcut effect must not rerun when the session changes). */
  const activeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  // The skill list: the input box / the completion and the creative mode welcome page use it; it is refreshed after the config is saved (the skill directory may have changed). A failure silently leaves it empty (the browser harness has no backend).
  useEffect(() => {
    let cancelled = false;
    void agentApi
      .listSkills()
      .then((list) => {
        if (!cancelled) setSkills(list);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentConfigVersion]);

  // The model name and the context window of the footnote come from the saved config (the same one the session uses). If the config changed again while it was being read (saving the settings bumps the version), the stale result is dropped.
  useEffect(() => {
    let cancelled = false;
    void agentApi
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        setAgentConfig({ model: cfg.model, contextWindow: cfg.context_window });
      })
      .catch(() => {
        if (!cancelled) setAgentConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agentConfigVersion]);

  /**
   * The material content the sessions belong to: for WeRead the studyContent
   * stops at the entry of the middle column (the bookshelf), only the in-page
   * router knows the book that is really being read — the sessions belong to
   * the book, the sessions of all books must not be mixed on the bookshelf.
   */
  const materialContent = useMemo<StudyContent | null>(() => {
    if (!studyContent) return null;
    if (studyContent.kind !== "url" || !isWereadUrl(studyContent.url)) return studyContent;
    return studyWereadBook
      ? { kind: "url", url: studyWereadBook.url, title: studyWereadBook.title }
      : studyContent;
  }, [studyContent, studyWereadBook]);

  const suggestItems = useMemo(
    () =>
      buildSuggestItems({
        trigger: suggestTrigger,
        skills,
        flatFiles,
        recentFiles,
        vaultPath,
        currentFile,
      }),
    [suggestTrigger, skills, flatFiles, recentFiles, vaultPath, currentFile],
  );

  const activeConv = convs.find((c) => c.key === activeKey) ?? null;
  // Only a non-empty sessionId counts as "generating": while the session is not up yet (or the start failed) both sessionId and busySession are null, they are equal but that is not a streaming reply.
  const activeBusy =
    activeConv?.sessionId != null && busySession === activeConv.sessionId;

  const updateConv = useCallback((key: string, patch: (c: Conv) => Conv) => {
    setConvs((prev) => prev.map((c) => (c.key === key ? patch(c) : c)));
  }, []);

  /** Fetch the session list of this material again (the history drawer + the restore of the most recent one). */
  const refreshSessions = useCallback(async (): Promise<SavedSessionMeta[]> => {
    const code = codeScopeRef.current;
    if (code) {
      const list = await homeApi.sessionsList(code.workdir).catch(() => []);
      if (codeScopeRef.current !== code) return list;
      setSavedSessions(list);
      return list;
    }
    const material = materialRef.current;
    if (!material?.info) {
      setSavedSessions([]);
      return [];
    }
    const list = await agentApi.sessionsList(material.info.relDir).catch(() => []);
    // The material changed while the disk was read: the result belongs to the previous material and must not be written into the current list.
    if (materialRef.current !== material) return list;
    setSavedSessions(list);
    return list;
  }, []);

  const startSession = useCallback(
    async (
      convKey: string,
      content: StudyContent | null,
      opts?: {
        /** Restore: the model side history that was restored. */
        history?: AgentChatItem[];
        /** Restore: keep writing to this file; without it a new file is created for a new session. */
        transcriptPath?: string | null;
        /** The record lives in the agent home (`~/.bnote`) instead of the vault. */
        transcriptHome?: boolean;
        /** Fork: the prefix of the parent session is written into the new file first. */
        seedLines?: TranscriptLine[];
        /** Fork: the parent relation written into the metadata line (the restore after a restart rebuilds the session family from it). */
        forkMeta?: {
          parent: string | null;
          basedOn: string;
          forkAt: number;
          /** The fork title, the same as the in-memory label (only when it is missing does it fall back to the first line of the prefix). */
          title?: string;
        };
        /** Restore/fork: reuse the model config of the source session; without it the current config of the settings is used. */
        model?: SessionModelConfig;
        /** Restore: the session record id, so the persisted task list continues. */
        taskListId?: string;
      },
    ) => {
      const token = ++startTokenRef.current;
      setStarting(true);
      updateConv(convKey, (c) => ({ ...c, error: undefined, errorKind: undefined }));
      try {
        const mode = agentModeRef.current;
        const info = await agentApi.startSession(
          content,
          undefined,
          opts?.history,
          opts?.model,
          mode === "study" ? undefined : mode,
          // A coding session anchors relative paths and bash in the repository.
          mode === "coding" ? codeScopeRef.current?.workdir : undefined,
          opts?.taskListId,
        );
        // Dropped when it expired: the content changed in the meantime (a new material / a new session), a new start has taken over.
        if (startTokenRef.current !== token) return;
        // The path of the session record: a restore keeps the old file, a new session uses "the scope directory + the session id of the backend". Creative mode is fixed at .bnote/creative/sessions/, so it never mixes with the sessions of a material. A coding session writes into the agent home instead (the repository is not the notebook).
        const home = opts?.transcriptHome ?? false;
        const vault = useAppStore.getState().vaultPath;
        const relDir = creativeModeRef.current
          ? "creative"
          : (materialRef.current?.info?.relDir ?? null);
        const homeDir = codeScopeRef.current?.homeDir ?? null;
        const transcriptPath =
          opts?.transcriptPath ??
          (home
            ? codeSessionPath(homeDir, info.sessionId)
            : vault && relDir
              ? sessionFilePath(vault, relDir, info.sessionId)
              : null);
        const fileName = transcriptPath?.split("/").pop() ?? null;
        const sessionFileId = fileName ? fileName.replace(/\.jsonl$/, "") : null;
        if (transcriptPath) transcriptRef.current.set(convKey, transcriptPath);
        transcriptHomeRef.current.set(convKey, home);
        sessionIndexRef.current.set(info.sessionId, { convKey, path: transcriptPath, home });
        const model = info.model ?? opts?.model ?? null;
        modelByConvRef.current.set(convKey, model);
        if (transcriptPath && opts?.seedLines && opts.seedLines.length > 0) {
          // Fork: the new file (the new session id) holds no old content, the metadata line and the prefix are written in one go. The metadata has to be the first line — the list side only reads the head of the file to get the title and the model snapshot.
          const meta = buildSessionMeta({
            at: Date.now(),
            // The same as the in-memory label (the summary of the fork point): after a restart the list and the header show the same title.
            title: opts.forkMeta?.title ?? sessionTitleFromLines(opts.seedLines),
            model,
            parent: opts.forkMeta?.parent ?? null,
            basedOn: opts.forkMeta?.basedOn,
            forkAt: opts.forkMeta?.forkAt,
          });
          await transcriptIO(home)
            .write(transcriptPath, serializeTranscript([meta, ...opts.seedLines]))
            .catch((e) => console.warn("[agent] failed to write the fork prefix", e));
          metaWrittenRef.current.set(convKey, true);
        } else {
          // Restore: the file already has the metadata (old records have none, the title falls back to the parsing on the list side); a new session: the metadata line is written together with the first message when it reaches the disk, so that an empty session never enters the list.
          metaWrittenRef.current.set(convKey, Boolean(opts?.transcriptPath));
        }
        if (startTokenRef.current !== token) return;
        setConvs((prev) =>
          prev.map((c) =>
            c.key === convKey
              ? {
                  ...c,
                  sessionId: info.sessionId,
                  mcpErrors: info.mcpErrors,
                  transcriptPath,
                  sessionFileId,
                  transcriptHome: home,
                  model,
                }
              : c,
          ),
        );
        if (opts?.seedLines && opts.seedLines.length > 0) void refreshSessions();
      } catch (e) {
        if (startTokenRef.current !== token) return;
        const msg = String(e).replace(/^[A-Z_]+:\s*/, "");
        updateConv(convKey, (c) => ({ ...c, error: msg, errorKind: "start" }));
        showToast(msg);
      } finally {
        if (startTokenRef.current === token) setStarting(false);
      }
    },
    [showToast, updateConv, refreshSessions],
  );

  /**
   * Restore a saved session: read the record back → rebuild the messages of
   * the UI and the model history → continue the conversation.
   * The session record is the only source, the backend only opens a new live
   * session with that history.
   *
   * The token is the restore generation: if the material / a new session
   * changed while the disk was read, the result is void and nothing is
   * written to a conv that is no longer in the list.
   */
  const launchRestored = useCallback(
    async (conv: Conv, token: number) => {
      const path = conv.transcriptPath;
      if (!path) return;
      const raw = await transcriptIO(conv.transcriptHome === true)
        .read(path)
        .catch(() => null);
      if (restoreTokenRef.current !== token) return;
      const lines = parseTranscript(raw);
      if (lines.length === 0) {
        showToast("这条会话记录是空的");
        return;
      }
      // The model config snapshot of the session itself: later setting changes do not affect this session, and a restore continues with it.
      const sessionMeta = sessionMetaFromRaw(raw);
      updateConv(conv.key, (c) => ({
        ...c,
        entries: lines.map(entryFromLine),
        label: sessionMeta?.title?.trim() ? sessionMeta.title : c.label,
        basedOn: sessionMeta?.basedOn ?? c.basedOn,
        forkAt: sessionMeta?.forkAt ?? c.forkAt,
        titleSource: sessionMeta?.titleSource === "llm" ? "llm" : "first-message",
        model: sessionMeta?.model ?? c.model,
      }));
      transcriptRef.current.set(conv.key, path);
      // The record file already has the metadata (old records have none, the title falls back to the list side); it is not written twice, and the bookkeeping of the other sessions is not cleared either — the round that is still streaming needs it when it closes.
      metaWrittenRef.current.set(conv.key, true);
      void startSession(conv.key, materialContent, {
        history: historyFromTranscript(lines),
        transcriptPath: path,
        transcriptHome: conv.transcriptHome === true,
        model: sessionMeta?.model,
        taskListId: conv.sessionFileId ?? undefined,
      });
    },
    [materialContent, showToast, startSession, updateConv],
  );

  /**
   * Restore a session family: along the parent chain the main session and
   * the auxiliary sessions forked from it are restored together.
   *
   * Earlier only the "most recently updated one" was hung up, and that is
   * often exactly the auxiliary session that was just forked, so after a
   * restart the panel stayed on the child session and the main session had
   * no entry at all. Now the root (the main session) is the default landing
   * spot, the auxiliary sessions first stand in the list and only read the
   * disk + start the backend session when they are switched to.
   */
  const restoreFamily = useCallback(
    async (anchorId: string, sessions: SavedSessionMeta[], activate: "root" | "anchor") => {
      const info = materialRef.current?.info;
      const code = codeScopeRef.current;
      const vault = useAppStore.getState().vaultPath;
      const recordPath = (id: string): string | null => {
        if (code) return codeSessionPath(code.homeDir, id);
        return info && vault ? sessionFilePath(vault, info.relDir, id) : null;
      };
      if (!code && (!info || !vault)) return;
      const family = resolveFamily(anchorId, sessions.map(toSessionNode));
      if (!family) return;
      const token = ++restoreTokenRef.current;

      const keyByFile = new Map<string, string>();
      for (const member of family.members) keyByFile.set(member.id, nextConvKey());
      const convs: Conv[] = family.members.map((member) => ({
        key: keyByFile.get(member.id)!,
        sessionId: null,
        entries: [],
        label: member.title,
        parent: member.parent ? (keyByFile.get(member.parent) ?? null) : null,
        basedOn: member.basedOn,
        forkAt: member.forkAt,
        titleSource: "first-message",
        mcpErrors: [],
        transcriptPath: recordPath(member.id),
        sessionFileId: member.id,
        model: null,
        usage: null,
        todos: [],
      }));
      setConvs(convs);
      turnsRef.current.clear();
      lazyStartingRef.current.clear();

      const rootKey = keyByFile.get(family.rootId)!;
      const focusKey = activate === "anchor" ? (keyByFile.get(anchorId) ?? rootKey) : rootKey;
      setActiveKey(focusKey);
      // Only the landing one is started: a backend session is globally single flight (the token of startSession), starting two at once voids the one that arrives first. The others start lazily when they are switched to.
      const focus = convs.find((c) => c.key === focusKey);
      if (focus) {
        lazyStartingRef.current.add(focusKey);
        void launchRestored(focus, token).finally(() =>
          lazyStartingRef.current.delete(focusKey),
        );
      }
    },
    [launchRestored],
  );

  /**
   * Switch to a session. In a family only the landing one was started during
   * the restore, the other sessions read the disk + start the backend session
   * the first time they are switched to (a session that is never switched to
   * never pays that cost).
   */
  const activateConv = useCallback(
    (key: string) => {
      setActiveKey(key);
      const conv = convsRef.current.find((c) => c.key === key);
      if (!conv || conv.sessionId || !conv.transcriptPath) return;
      if (lazyStartingRef.current.has(key)) return;
      lazyStartingRef.current.add(key);
      void launchRestored(conv, restoreTokenRef.current).finally(() =>
        lazyStartingRef.current.delete(key),
      );
    },
    [launchRestored],
  );

  /**
   * After the first reply the model names the session (from the **own** first
   * message of that session).
   *
   * The local fallback title (the truncated first message / the ↳ fork point)
   * is already in the label, here it is only replaced by something that
   * reads more like a title; on a failure it stays as it is. The title is
   * also written back into the first line of the record file, the history
   * list and the restore after a restart both read it.
   */
  const generateTitle = useCallback(
    (convKey: string, seed: string) => {
      if (titleAskedRef.current.has(convKey)) return;
      const conv = convsRef.current.find((c) => c.key === convKey);
      if (!conv || conv.titleSource === "llm") return;
      titleAskedRef.current.add(convKey);
      const relDir = materialRef.current?.info?.relDir;
      const codeWorkdir = codeScopeRef.current?.workdir;
      void agentApi
        .generateTitle(seed, conv.model ?? undefined)
        .then((raw) => {
          const clean = cleanGeneratedTitle(raw);
          if (!clean) return;
          const label = displayTitle(clean, conv.parent !== null);
          updateConv(convKey, (c) => ({ ...c, label, titleSource: "llm" }));
          const id = conv.sessionFileId;
          if (!id) return;
          const write = codeWorkdir
            ? homeApi.setSessionTitle(codeWorkdir, id, label)
            : relDir
              ? agentApi.setSessionTitle(relDir, id, label)
              : null;
          if (write) void write.then(() => refreshSessions()).catch(() => {});
        })
        .catch(() => {
          // No key / network failure / the model refused: keep the local fallback title and do not bother the user.
        });
    },
    [refreshSessions, updateConv],
  );
  // - Switching the scope (material / code project): restore the most recent session of that scope (only when there is none a new one is opened);
  // - Clicking ⟳ / ＋ new session: force a new session (the old one stays in the history, the config is the current one from the settings);
  // - Saving the settings: nothing happens — the sessions that are already open keep using their own model config snapshot.
  // - Leaving and re-entering study / code mode: the panel is mounted again and restores per scope.
  useEffect(() => {
    const identity = mode === "code"
      ? codeSessionIdentity(codeProject?.path ?? null)
      : creativeMode
        ? `creative|${restartNonce}`
        : studyContentKey(materialContent);
    const key = `${mode === "code" ? "d" : creativeMode ? "c" : "s"}|${identity}|${restartNonce}`;
    if (startedKeyRef.current === key) return;
    startedKeyRef.current = key;
    // A new scope starts outside plan mode (the plan belonged to the previous
    // conversation's session).
    setPlanActive(false);

    const forcedNew =
      restartKeyRef.current !== null && restartKeyRef.current !== restartNonce;
    restartKeyRef.current = restartNonce;

    const token = ++startTokenRef.current;
    void (async () => {
      const vault = useAppStore.getState().vaultPath;
      let info: MaterialInfo | null = null;
      if (mode === "code") {
        // A coding session belongs to the repository: its records live in the
        // agent home (`~/.bnote/projects/<project>/`), never in the vault.
        materialRef.current = null;
        codeScopeRef.current = null;
        setSavedSessions([]);
        if (!codeProject) {
          setScopeLabel(null);
          setConvs([]);
          setActiveKey(null);
          return;
        }
        const workspace = await homeApi.workspace(codeProject.path).catch(() => null);
        if (startTokenRef.current !== token) return;
        codeScopeRef.current = workspace
          ? { identity, workdir: codeProject.path, homeDir: workspace.dir }
          : null;
        setScopeLabel({ title: codeProject.title, detail: codeProject.path });
        const sessions = workspace
          ? await homeApi.sessionsList(codeProject.path).catch(() => [])
          : [];
        if (startTokenRef.current !== token) return;
        setSavedSessions(sessions);
        if (!forcedNew && sessions.length > 0) {
          await restoreFamily(sessions[0].id, sessions, "root");
          return;
        }
        const conv: Conv = {
          key: nextConvKey(),
          sessionId: null,
          entries: [],
          label: "主会话",
          parent: null,
          basedOn: "",
          forkAt: 0,
          titleSource: "first-message",
          mcpErrors: [],
          transcriptPath: null,
          sessionFileId: null,
          model: null,
          usage: null,
          todos: [],
        };
        setConvs([conv]);
        setActiveKey(conv.key);
        turnsRef.current.clear();
        void startSession(conv.key, null);
        return;
      }
      codeScopeRef.current = null;
      if (creativeMode) {
        // Creative mode has no material directory: its sessions all land in .bnote/creative/sessions/.
        info = { kind: "pdfs", dir: "creative", relDir: "creative", title: "创作模式" };
      } else {
        info = vault && materialContent ? await ensureMaterial(vault, materialContent) : null;
      }
      if (startTokenRef.current !== token) return;
      materialRef.current = { identity, info };
      setScopeLabel(info ? { title: info.title, detail: info.relDir } : null);
      const sessions = info
        ? await agentApi.sessionsList(info.relDir).catch(() => [])
        : [];
      if (startTokenRef.current !== token) return;
      setSavedSessions(sessions);

      if (!forcedNew && sessions.length > 0) {
        // The family of the most recent one: the root (the main session) is the landing spot, the auxiliary sessions hang off the session switcher.
        await restoreFamily(sessions[0].id, sessions, "root");
        return;
      }
      const conv: Conv = {
        key: nextConvKey(),
        sessionId: null,
        entries: [],
        label: "主会话",
        parent: null,
        basedOn: "",
        forkAt: 0,
        titleSource: "first-message",
        mcpErrors: [],
        transcriptPath: null,
        sessionFileId: null,
        model: null,
        usage: null,
        todos: [],
      };
      setConvs([conv]);
      setActiveKey(conv.key);
      turnsRef.current.clear();
      void startSession(conv.key, materialContent);
    })();
  }, [materialContent, creativeMode, mode, codeProject, restartNonce, startSession, restoreFamily]);

  // ⌘⇧Y / the command: switch back and forth between the main session and the most recent auxiliary session.
  useEffect(() => {
    if (agentSwitchSignal === 0) return;
    const list = convsRef.current;
    if (list.length < 2) {
      showToast("还没有辅助会话:悬停消息点「⤷」创建");
      return;
    }
    const cur = list.find((c) => c.key === activeKeyRef.current);
    let next = list[list.length - 1].key;
    if (cur?.parent) {
      const parent = list.find((c) => c.key === cur.parent);
      next = parent ? parent.key : list[0].key;
    }
    activateConv(next);
  }, [agentSwitchSignal, showToast, activateConv]);

  // Scroll to the bottom after switching the session (every session is looked at from its newest message).
  useEffect(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    });
  }, [activeKey]);

  /** Moves through the fetched prompt history (index -1 = the empty box). */
  function stepHistory(direction: 1 | -1) {
    const items = historyItemsRef.current;
    if (!items || items.length === 0) return;
    const next = historyIndexRef.current + direction;
    if (next < 0) {
      historyIndexRef.current = -1;
      setInput("");
      return;
    }
    if (next >= items.length) {
      historyIndexRef.current = items.length - 1;
      return;
    }
    historyIndexRef.current = next;
    setInput(items[next]);
  }

  function ensureTurn(convKey: string): Turn {
    let turn = turnsRef.current.get(convKey);
    if (!turn) {
      turn = { text: "", thinking: "", thinkingStart: null, thinkSeconds: null, tools: [] };
      turnsRef.current.set(convKey, turn);
    }
    return turn;
  }

  /** Write the streaming draft into the session (the same shape whether it is final or not); the draft reuses the same turn reference. */
  function writeEntries(
    convKey: string,
    turn: Turn,
    finalize: boolean,
    items: number | null,
  ) {
    setConvs((prev) =>
      prev.map((c) => {
        if (c.key !== convKey) return c;
        const entries = c.entries.slice();
        const draft: ChatEntry = {
          role: "assistant",
          text: turn.text,
          at: Date.now(),
          turn,
          items,
        };
        const last = entries[entries.length - 1];
        if (last && last.role === "assistant" && last.turn === turn) {
          entries[entries.length - 1] = finalize ? { ...draft } : draft;
        } else {
          entries.push(draft);
        }
        return { ...c, entries };
      }),
    );
  }

  /** Finalizes the streaming turn: the draft entry is replaced in place (it
   *  used to be appended a second time, so every reply showed up twice). */
  function commitTurn(convKey: string, items: number | null) {
    const turn = turnsRef.current.get(convKey);
    if (!turn) return;
    if (turn.thinking && turn.thinkSeconds == null && turn.thinkingStart != null) {
      turn.thinkSeconds = Math.max(1, Math.round((Date.now() - turn.thinkingStart) / 1000));
    }
    turnsRef.current.delete(convKey);
    writeEntries(convKey, turn, true, items);
    persistTurn(convKey, turn);
  }

  /**
   * Write this round into the session record: the user message and the
   * assistant reply are appended together (one append, the order is fixed;
   * when the send failed the user message never entered the file). A failed
   * write is only logged, it does not affect the conversation — the disk is
   * a record, not a precondition of sending.
   */
  function persistTurn(convKey: string, turn: Turn, pathOverride?: string) {
    const path = pathOverride ?? transcriptRef.current.get(convKey);
    if (!path) return;
    const user = pendingUserRef.current.get(convKey) ?? null;
    pendingUserRef.current.delete(convKey);
    // The first round inserts the metadata line (title + model snapshot) at the very front, see turnLines.
    const firstWrite = !metaWrittenRef.current.get(convKey);
    if (firstWrite) metaWrittenRef.current.set(convKey, true);
    const lines = turnLines({
      user,
      assistant: {
        type: "assistant",
        at: Date.now(),
        text: turn.text,
        thinking: turn.thinking,
        thinkSeconds: turn.thinkSeconds,
        tools: turn.tools,
        error: turn.error,
      },
      first: firstWrite,
      model: modelByConvRef.current.get(convKey) ?? null,
    });
    void transcriptIO(transcriptHomeRef.current.get(convKey) === true)
      .append(path, serializeTranscript(lines))
      .then(() => refreshSessions())
      .catch((e) => console.warn("[agent] failed to write the session record", e));
  }

  function handleAgentEvent(sessionId: string, event: AgentEvent) {
    const conv = findConvBySession(convsRef.current, sessionId);
    if (!conv) {
      // The session is no longer in the list (a new material / the old sessions are void after a restart): the streaming deltas are dropped harmlessly, but the **terminating event must clear the busy flag** — otherwise the panel stays on "generating" forever and the next send is silently swallowed by busyRef. The content that this round has already produced is still written into its own session record: the user only switched away from the material, the answer must not be lost.
      if (event.type === "turn_end" || event.type === "error") {
        const entry = sessionIndexRef.current.get(sessionId);
        if (entry) {
          const turn = turnsRef.current.get(entry.convKey);
          if (turn) {
            if (event.type === "error") turn.error = event.message;
            if (turn.thinking && turn.thinkSeconds == null && turn.thinkingStart != null) {
              turn.thinkSeconds = Math.max(
                1,
                Math.round((Date.now() - turn.thinkingStart) / 1000),
              );
            }
            turnsRef.current.delete(entry.convKey);
            persistTurn(entry.convKey, turn, entry.path ?? undefined);
          }
          sessionIndexRef.current.delete(sessionId);
        }
        if (busyRef.current === sessionId) {
          busyRef.current = null;
          setBusySession(null);
        }
      }
      return;
    }
    switch (event.type) {
      case "thinking_delta": {
        const turn = ensureTurn(conv.key);
        turn.thinking += event.text;
        turn.thinkingStart ??= Date.now();
        writeEntries(conv.key, turn, false, null);
        break;
      }
      case "text_delta": {
        const turn = ensureTurn(conv.key);
        turn.text += event.text;
        writeEntries(conv.key, turn, false, null);
        break;
      }
      case "tool_start": {
        const turn = ensureTurn(conv.key);
        turn.tools = [...turn.tools, { id: event.id, name: event.name, input: event.input }];
        writeEntries(conv.key, turn, false, null);
        break;
      }
      case "tool_end": {
        const turn = turnsRef.current.get(conv.key);
        if (!turn) break;
        turn.tools = turn.tools.map((t) =>
          t.id === event.id
            ? { ...t, output: event.output, ok: event.ok, images: event.images }
            : t,
        );
        writeEntries(conv.key, turn, false, null);
        break;
      }
      case "usage": {
        updateConv(conv.key, (c) => ({
          ...c,
          usage: { input: event.input, output: event.output },
        }));
        break;
      }
      case "notice": {
        // A dim status line (compaction / subagent / background task). It is
        // display-only: it never reaches the transcript and a restore drops it.
        updateConv(conv.key, (c) => ({
          ...c,
          entries: [
            ...c.entries,
            { role: "notice", text: event.text, at: Date.now(), items: null },
          ],
        }));
        break;
      }
      case "todos": {
        updateConv(conv.key, (c) => ({ ...c, todos: event.todos }));
        break;
      }
      case "permission_request": {
        setApprovalFeedback("");
        setApproval({
          sessionId,
          id: event.id,
          tool: event.tool,
          input: event.input,
        });
        break;
      }
      case "question": {
        setQuestionAnswers({});
        setPendingQuestion({
          sessionId,
          id: event.id,
          questions: parseQuestions(event.questions),
        });
        break;
      }
      case "plan_mode": {
        setPlanActive(event.enabled);
        updateConv(conv.key, (c) => ({
          ...c,
          entries: [
            ...c.entries,
            {
              role: "notice",
              text: event.enabled
                ? "已进入计划模式:先只读调研,计划批准后才改文件"
                : "计划已批准,恢复编辑",
              at: Date.now(),
              items: null,
            },
          ],
        }));
        break;
      }
      case "tasks": {
        // The v2 task list has no dedicated panel: the tool cards already show
        // every change, and the list itself lives in the model's context.
        break;
      }
      case "turn_end": {
        commitTurn(conv.key, event.items);
        // The first round succeeded: name the session after its own first message (the local fallback title holds the line until then).
        const seed = titleSeedRef.current.get(conv.key);
        if (seed) {
          titleSeedRef.current.delete(conv.key);
          generateTitle(conv.key, seed);
        }
        if (busyRef.current === sessionId) {
          busyRef.current = null;
          setBusySession(null);
        }
        break;
      }
      case "error": {
        const turn = turnsRef.current.get(conv.key);
        if (turn) {
          turn.error = event.message;
          commitTurn(conv.key, event.items);
        } else {
          updateConv(conv.key, (c) => ({
            ...c,
            entries: [
              ...c.entries,
              {
                role: "assistant",
                text: "",
                at: Date.now(),
                items: event.items > 0 ? event.items : null,
                turn: {
                  text: "",
                  thinking: "",
                  thinkingStart: null,
                  thinkSeconds: null,
                  tools: [],
                  error: event.message,
                },
              },
            ],
          }));
          persistTurn(conv.key, {
            text: "",
            thinking: "",
            thinkingStart: null,
            thinkSeconds: null,
            tools: [],
            error: event.message,
          });
        }
        if (busyRef.current === sessionId) {
          busyRef.current = null;
          setBusySession(null);
        }
        break;
      }
    }
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    });
  }

  // Stream events; route by sessionId into the owning conversation.
  // The composer mode is a settings value (new sessions inherit it) mirrored
  // onto the live session, which is where the tool dispatch reads it.
  const activeSessionId = activeConv?.sessionId ?? null;
  useEffect(() => {
    if (!activeSessionId) return;
    void agentApi
      .setPermissionMode(activeSessionId, permissionMode)
      .catch((e) => console.warn("[agent] failed to set permission mode", e));
  }, [activeSessionId, permissionMode]);

  // The mode popover closes on any click outside it.
  useEffect(() => {
    if (!modeOpen) return;
    const onDown = (event: MouseEvent) => {
      if (modeRef.current && !modeRef.current.contains(event.target as Node)) {
        setModeOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modeOpen]);

  useEffect(() => {
    let off: (() => void) | undefined;
    // Wrapped in try/catch: the browser harness has no Tauri event bridge and
    // `listen` throws synchronously there (a rejected promise would not catch
    // that), while the panel itself still renders.
    void (async () => {
      try {
        off = await listen<{ sessionId: string; event: AgentEvent }>("agent-event", (event) => {
          handleAgentEvent(event.payload.sessionId, event.payload.event);
        });
      } catch {
        // No stream events in this environment.
      }
    })();
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Queue the attachments (pasting and the file picker share this path): over the limit it refuses and says so, a failure only toasts and does not interrupt. */
  async function addImages(files: File[]) {
    if (files.length === 0) return;
    const room = MAX_IMAGES_PER_MESSAGE - pendingImages.length;
    if (files.length > room) {
      showToast(`一次最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`);
    }
    const picked = files.slice(0, Math.max(0, room));
    const results = await Promise.allSettled(
      picked.map((file) => fileToAgentImage(file, file.type)),
    );
    const ok: AgentImage[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") ok.push(r.value);
      else showToast(String(r.reason?.message ?? r.reason));
    }
    if (ok.length > 0) setPendingImages((prev) => [...prev, ...ok]);
  }

  /** Pick a completion candidate: the trigger word is replaced and the caret lands after the inserted text. */
  const pickSuggestion = (item: SuggestItem) => {
    if (!suggestTrigger) return;
    const next = applySuggestion(input, suggestTrigger, item.insert);
    setInput(next.text);
    setSuggestTrigger(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      }
    });
  };

  async function send() {
    const text = input.trim();
    const conv = activeConv;
    // The next ↑ refetches: this prompt is about to enter the history file.
    historyIndexRef.current = -1;
    historyItemsRef.current = null;
    if (!conv || (!text && pendingImages.length === 0)) return;
    // Manual compaction: a built-in panel command, not a message — the model
    // never sees "/compact", it sees the summary replace its history.
    if (text === "/compact") {
      const sid = conv.sessionId;
      if (!sid || busyRef.current === sid) return;
      busyRef.current = sid;
      setBusySession(sid);
      setInput("");
      try {
        await agentApi.compact(sid);
      } catch (e) {
        busyRef.current = null;
        setBusySession(null);
        showToast(String(e).replace(/^[A-Z_]+:\s*/, ""));
      }
      return;
    }
    const info = conv.sessionId;
    if (!info) {
      // The session is not up yet: it goes into the persistent error banner as well, not only into a toast that flashes by.
      updateConv(conv.key, (c) => ({
        ...c,
        error: c.error ?? `会话未就绪:${c.error ?? "请稍候重试或重新开始会话"}`,
        errorKind: c.errorKind ?? "start",
      }));
      return;
    }
    if (busyRef.current === info) return;
    const images = pendingImages;
    setInput("");
    setPendingImages([]);
    busyRef.current = info;
    setBusySession(info);
    const last = conv.entries[conv.entries.length - 1];
    const items = last?.items != null ? last.items + 1 : null;
    const at = Date.now();
    // The user message hangs on this round first and reaches the disk together with the assistant reply; a failed send drops it.
    pendingUserRef.current.set(conv.key, {
      type: "user",
      at,
      text,
      images: images.length > 0 ? images : undefined,
    });
    // The first request of the session itself: remember this message. After this round succeeded it is used to let the model name the session — the title of an auxiliary session must come from its own question, the message of the parent session must not stand in for it.
    if (conv.titleSource !== "llm" && !titleSeedRef.current.has(conv.key)) {
      titleSeedRef.current.set(conv.key, text || "[图片]");
    }
    updateConv(conv.key, (c) => ({
      ...c,
      error: undefined,
      errorKind: undefined,
      label: c.label === "主会话" ? forkLabel(text || "[图片]", 30) : c.label,
      entries: [
        ...c.entries,
        { role: "user", text, at, images: images.length > 0 ? images : undefined, items },
      ],
    }));
    try {
      await agentApi.send(info, text, images);
    } catch (e) {
      busyRef.current = null;
      setBusySession(null);
      pendingUserRef.current.delete(conv.key);
      const message = String(e).replace(/^[A-Z_]+:\s*/, "");
      // The backend did not receive this round: the ghost message that was just inserted into the UI is taken back, the content goes back into the input box and the reason stays on the error banner of the session. Otherwise the UI hangs on a message that will never be answered.
      updateConv(conv.key, (c) => ({
        ...c,
        error: message,
        errorKind: "send",
        entries: c.entries.slice(0, -1),
      }));
      setInput(text);
      setPendingImages(images);
    }
  }

  function abort() {
    const info = activeConv?.sessionId;
    if (info) void agentApi.abort(info);
  }

  /**
   * Fork an auxiliary session from the message at index: the prefix of the
   * history is copied, the original session stays untouched. The forked
   * session has its own record file (the prefix is written into it first),
   * so it can be continued after a close and a reopen.
   */
  const forkFrom = useCallback(
    (index: number) => {
      const src = activeConv;
      if (!src) return;
      if (!src.sessionId) {
        showToast("会话未就绪,不能分叉");
        return;
      }
      const origin = src.entries[index];
      if (!origin) return;
      const label = origin.text.trim() || (origin.images?.length ? "[图片]" : "");
      const prefix = src.entries.slice(0, index + 1).map(cloneEntry);
      const seedLines = entriesToLines(prefix);
      const conv: Conv = {
        key: nextConvKey(),
        sessionId: null,
        entries: prefix,
        label: `↳ ${forkLabel(label)}`,
        parent: src.key,
        basedOn: forkLabel(label, 40),
        forkAt: prefix.length,
        titleSource: "first-message",
        mcpErrors: [],
        transcriptPath: null,
        sessionFileId: null,
        // The auxiliary session reuses the model config of the source session: a fork must not change the model.
        model: src.model,
        usage: null,
        todos: [],
      };
      setConvs((prev) => [...prev, conv]);
      setActiveKey(conv.key);
      void startSession(conv.key, materialContent, {
        history: historyFromTranscript(seedLines),
        seedLines,
        model: src.model ?? undefined,
        // The parent relation goes into the new file: after a restart it hangs this auxiliary session back onto the main session.
        forkMeta: {
          parent: src.sessionFileId,
          basedOn: conv.basedOn,
          forkAt: prefix.length,
          title: conv.label,
        },
      });
    },
    [activeConv, materialContent, showToast, startSession],
  );

  const parentConv = activeConv?.parent
    ? (convs.find((c) => c.key === activeConv.parent) ?? null)
    : null;

  /** Hand the focus to the history list: the first session, without a session the drawer itself. */
  const focusHistory = useCallback(() => {
    const first = historyRef.current?.querySelector<HTMLButtonElement>(".agent-history-item");
    (first ?? historyRef.current)?.focus();
  }, []);

  // Shortcut / command → panel action. The signal carries only the kind; the concrete session and the input box are private state of the panel.
  useEffect(() => {
    const cmd = agentPanelCommand;
    if (!cmd || cmd.seq === lastAgentCommandSeq.current) return;
    lastAgentCommandSeq.current = cmd.seq;
    // Focusing the input box = explicitly entering the Chinese writing box: even when it already has the focus (the shortcut pressed again and again, the user switched back to English inside the box) the IME is pulled back to Chinese.
    const focusInput = () => {
      inputRef.current?.focus();
      imeOnChineseFocus(true);
    };
    switch (cmd.kind) {
      case "focus-input":
        focusInput();
        break;
      case "new":
        setHistoryOpen(false);
        setRestartNonce((n) => n + 1);
        focusInput();
        break;
      case "fork": {
        if (!activeConv || activeConv.entries.length === 0) {
          showToast("当前会话还没有消息可分叉");
          return;
        }
        forkFrom(activeConv.entries.length - 1);
        focusInput();
        break;
      }
      case "back": {
        if (!parentConv) {
          showToast("当前不是辅助会话");
          return;
        }
        activateConv(parentConv.key);
        focusInput();
        break;
      }
      case "attach-images": {
        const incoming = cmd.images ?? [];
        if (incoming.length === 0) break;
        const room = MAX_IMAGES_PER_MESSAGE - pendingImages.length;
        if (room <= 0) {
          showToast(`一次最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`);
          break;
        }
        if (incoming.length > room) {
          showToast(`一次最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`);
        }
        setPendingImages((prev) => [...prev, ...incoming.slice(0, room)]);
        focusInput();
        break;
      }
      case "toggle-creative":
        setCreativeMode(!creativeModeRef.current);
        focusInput();
        break;
      case "history":
        historyFocusPending.current = true;
        // Pressing it again while the drawer is already open hands the focus into it right away.
        if (historyOpen) focusHistory();
        else setHistoryOpen(true);
        break;
    }
  }, [agentPanelCommand, activeConv, parentConv, forkFrom, historyOpen, focusHistory, showToast, pendingImages, activateConv, setCreativeMode]);

  // Once the history drawer is open the focus goes to the list, Tab / Enter work right away.
  useEffect(() => {
    if (!historyOpen || !historyFocusPending.current) return;
    historyFocusPending.current = false;
    focusHistory();
  }, [historyOpen, focusHistory]);

  // The footnote shows the model config of **this session**: a setting change does not affect a session that is already open, showing the current settings would lie. While the session is not up yet it falls back to the current config.
  const configuredModel = agentConfig?.model.trim() ?? "";
  const modelName = activeConv?.model?.model.trim() || configuredModel;
  const contextLimit = activeConv?.model?.contextWindow ?? agentConfig?.contextWindow ?? 0;
  const modelStale = Boolean(modelName && configuredModel && modelName !== configuredModel);
  const activeUsage = activeConv?.usage ?? null;
  const usagePct = occupancyPercent(activeUsage, contextLimit);

  return (
    <aside
      className="agent-panel"
      data-key-region="agent"
      style={{ "--agent-fs": String(agentFontScale) } as React.CSSProperties}
    >
      {/* Study mode has no title bar, the header is the drag area of the window; deep lets the text be dragged too,
          the buttons inside the header are let through by the drag.js of Tauri itself (see AgentHeader). */}
      <AgentHeader
        convs={convs.map((c) => ({
          key: c.key,
          label: c.label,
          parent: c.parent,
          basedOn: c.basedOn,
        }))}
        activeKey={activeKey}
        onSelect={activateConv}
        creativeMode={creativeMode}
        onToggleCreative={() => setCreativeMode(!creativeMode)}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((v) => !v)}
        onNewSession={() => {
          setHistoryOpen(false);
          setRestartNonce((n) => n + 1);
        }}
        parent={
          parentConv
            ? {
                key: parentConv.key,
                label: parentConv.label,
                parent: parentConv.parent,
                basedOn: parentConv.basedOn,
              }
            : null
        }
        onBack={() => parentConv && activateConv(parentConv.key)}
        fontScale={agentFontScale}
        onFontStep={(direction) =>
          patchSettings({ agentFontScale: stepAgentFont(agentFontScale, direction) })
        }
        onFontReset={() => patchSettings({ agentFontScale: DEFAULT_AGENT_FONT })}
      />
      {activeConv && activeConv.mcpErrors.length > 0 && (
        <div className="agent-mcp-warn" title={activeConv.mcpErrors.join("\n")}>
          MCP 部分服务器连接失败
        </div>
      )}
      {starting && <div className="agent-status">正在连接模型…</div>}
      {!starting && activeConv?.error && (
        <div className="agent-status fail" role="alert">
          <span className="agent-status-text" title={activeConv.error}>
            {activeConv.errorKind === "send" ? "发送失败:" : "会话未就绪:"}
            {activeConv.error}
          </span>
          {activeConv.errorKind === "send" ? (
            <button
              className="btn btn-ghost agent-status-retry"
              title="用刚才的内容重新发送"
              onClick={() => void send()}
            >
              重试
            </button>
          ) : (
            <button
              className="btn btn-ghost agent-status-retry"
              onClick={() =>
                void startSession(activeConv.key, materialContent, {
                  transcriptPath: activeConv.transcriptPath,
                  model: activeConv.model ?? undefined,
                })
              }
            >
              重试
            </button>
          )}
          <button
            className="agent-status-dismiss"
            title="关闭提示"
            aria-label="关闭提示"
            onClick={() =>
              updateConv(activeConv.key, (c) => ({
                ...c,
                error: undefined,
                errorKind: undefined,
              }))
            }
          >
            ×
          </button>
        </div>
      )}
      <div className="agent-scroll" ref={scrollRef}>
        {!activeConv || activeConv.entries.length === 0 ? (
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
        ) : (
          activeConv.entries.map((entry, i) => {
            const isLast = i === activeConv.entries.length - 1;
            const streaming = isLast && activeBusy && entry.role === "assistant";
            return (
              <div
                className={`agent-msg-row${entry.role === "user" ? " is-user" : ""}`}
                key={i}
              >
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
                      <details className="agent-tool" key={tool.id}>
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
                    ))}
                    {entry.turn?.error && (
                      <div className="agent-error">{entry.turn.error}</div>
                    )}
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
                {!activeBusy && (
                  <button
                    className="agent-fork"
                    title="基于这条消息开启辅助会话"
                    onClick={() => forkFrom(i)}
                  >
                    ⤷
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
      {activeConv && activeConv.todos.length > 0 && (
        <div className="agent-todos" aria-label="任务清单">
          {activeConv.todos.map((t) => (
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
      )}
      <div className="agent-composer">
        {suggestTrigger && suggestItems.length > 0 && (
          <AgentSuggest
            kind={suggestTrigger.kind}
            items={suggestItems}
            activeIndex={suggestIndex}
            onPick={pickSuggestion}
            onHover={setSuggestIndex}
          />
        )}
        {pendingImages.length > 0 && (
          <div className="agent-attach-row">
            {pendingImages.map((img, i) => (
              <span className="agent-attach-thumb" key={i}>
                <img src={`data:${img.mediaType};base64,${img.data}`} alt="" />
                <button
                  className="agent-attach-remove"
                  title="移除这张图片"
                  onClick={() =>
                    setPendingImages((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="agent-input"
          placeholder={
            mode === "code"
              ? "描述要改什么…(bash/编辑/测试;/compact 压缩上下文)"
              : creativeMode
                ? "描述要创作的内容…(输入 / 调技能、@ 引用文件,可粘贴截图)"
                : "询问当前内容…(可直接粘贴截图)"
          }
          value={input}
          rows={1}
          data-ime-chinese="true"
          onFocus={() => imeOnChineseFocus(true)}
          // The click forces it too: the focus event does not fire again when it already has the focus (the user switched back to English with Ctrl+Space inside the box and clicks back in, Chinese has to be asked for again here).
          onPointerDown={() => imeOnChineseFocus(true)}
          onBlur={() => {
            imeSyncToEditor();
            setSuggestTrigger(null);
          }}
          onChange={(e) => {
            setInput(e.target.value);
            const caret = e.target.selectionStart ?? e.target.value.length;
            setSuggestTrigger(parseSuggestTrigger(e.target.value, caret));
            setSuggestIndex(0);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onPaste={(e) => {
            // Only a clipboard that holds images (screenshots) is taken over: when there is text as well the normal paste wins, so copying text from a web page is never hijacked.
            const files = Array.from(e.clipboardData?.items ?? [])
              .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
              .map((it) => it.getAsFile())
              .filter((f): f is File => f !== null);
            const hasText = (e.clipboardData?.getData("text/plain") ?? "") !== "";
            if (files.length === 0 || hasText) return;
            e.preventDefault();
            void addImages(files);
          }}
          onKeyDown={(e) => {
            // While the completion popup is open the arrow keys / Enter / Tab / Esc belong to the popup; the confirmation key of the IME is never taken.
            if (suggestTrigger && suggestItems.length > 0) {
              const ime = isImeEnter(e.nativeEvent, composingRef.current);
              if (e.key === "ArrowDown" && !ime) {
                e.preventDefault();
                setSuggestIndex((i) => (i + 1) % suggestItems.length);
                return;
              }
              if (e.key === "ArrowUp" && !ime) {
                e.preventDefault();
                setSuggestIndex((i) => (i - 1 + suggestItems.length) % suggestItems.length);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSuggestTrigger(null);
                return;
              }
              if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey && !ime) {
                e.preventDefault();
                pickSuggestion(suggestItems[suggestIndex] ?? suggestItems[0]);
                return;
              }
            }
            // ↑ in an empty box (or at the very start) recalls the previous
            // prompt; ↓ walks forward and past the newest one clears the box.
            if (e.key === "ArrowUp" && !suggestTrigger && input === "") {
              e.preventDefault();
              if (historyItemsRef.current) {
                stepHistory(-1);
                return;
              }
              if (historyLoadingRef.current) return;
              historyLoadingRef.current = true;
              const project = codeScopeRef.current?.workdir ?? vaultPath ?? null;
              void homeApi
                .history(project, 50)
                .then((list) => {
                  historyItemsRef.current = list
                    .map((entry) => entry.display)
                    .filter((text) => text.trim() !== "");
                  historyIndexRef.current = -1;
                  historyLoadingRef.current = false;
                  stepHistory(-1);
                })
                .catch(() => {
                  // No backend (harness) or no history yet: the box stays empty.
                  historyLoadingRef.current = false;
                });
              return;
            }
            if (
              e.key === "ArrowDown" &&
              !suggestTrigger &&
              historyIndexRef.current >= 0
            ) {
              e.preventDefault();
              stepHistory(1);
              return;
            }
            if (e.key !== "Enter" || e.shiftKey) return;
            // The confirmation key of the IME (Enter after typing latin letters in the Chinese mode) must not be a send: it is let through so that the IME fills the letters into the input box.
            if (isImeEnter(e.nativeEvent, composingRef.current)) return;
            e.preventDefault();
            void send();
          }}
        />
        <div className="agent-composer-foot">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void addImages(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button
            className="agent-attach-btn"
            title="插入图片(也可直接粘贴截图)"
            onClick={() => fileInputRef.current?.click()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="5" width="18" height="14" rx="2.5" />
              <circle cx="9" cy="10.5" r="1.6" />
              <path d="m5 17 4.2-4.2a1.5 1.5 0 0 1 2.1 0L16 17.5M14 15l2-2a1.5 1.5 0 0 1 2.1 0L21 15.9" />
            </svg>
          </button>
          <div className="agent-mode" ref={modeRef}>
            <button
              className="agent-mode-btn"
              onClick={() => setModeOpen((v) => !v)}
              title={PERMISSION_MODES.find((m) => m.id === permissionMode)?.description}
            >
              <ShieldIcon />
              {planActive
                ? "计划模式"
                : PERMISSION_MODES.find((m) => m.id === permissionMode)?.label}
            </button>
            {modeOpen && (
              <div className="agent-mode-pop" role="menu">
                {PERMISSION_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    className={`agent-mode-item${mode.id === permissionMode ? " is-active" : ""}`}
                    role="menuitemradio"
                    aria-checked={mode.id === permissionMode}
                    onClick={() => {
                      patchSettings({ agentPermissionMode: mode.id });
                      setModeOpen(false);
                    }}
                  >
                    <span className="agent-mode-item-label">
                      {mode.label}
                      {mode.id === permissionMode && <span className="agent-mode-check">✓</span>}
                    </span>
                    <span className="agent-mode-item-desc">{mode.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span
            className="agent-meta"
            title={
              usageTitle(activeUsage, contextLimit, modelName) +
              (modelStale
                ? `\n本会话按自己的配置继续(设置里现在是 ${configuredModel});点 ⟳ 开始新会话才会用新配置。`
                : "")
            }
          >
            <span className="agent-meta-model">
              {modelName || "未配置模型"}
              {modelStale ? " · 会话配置" : ""}
            </span>
            <span className="agent-meta-ctx">{contextLabel(activeUsage, contextLimit)}</span>
            {usagePct !== null && (
              <span className="agent-meta-pct">{formatPercent(usagePct)}</span>
            )}
            {activeUsage && (
              <span className="agent-meta-io">
                ↑{formatTokenCount(activeUsage.input)} ↓{formatTokenCount(activeUsage.output)}
              </span>
            )}
          </span>
          {activeBusy ? (
            <button className="agent-send stop" onClick={abort}>
              停止
            </button>
          ) : (
            <button
              className="agent-send"
              onClick={() => void send()}
              disabled={!activeConv?.sessionId || (input.trim() === "" && pendingImages.length === 0)}
              title={
                activeConv?.sessionId
                  ? "发送(Enter)"
                  : (activeConv?.error ?? "正在连接模型…")
              }
            >
              发送
            </button>
          )}
        </div>
      </div>
      {/* Tool approval (the definition marked this tool `ask`): the turn is
          parked until the user answers, so this must be a blocking overlay. */}
      {approval && (
        <div className="agent-approval" role="dialog" aria-label="工具授权">
          <div className="agent-approval-card">
            <div className="agent-approval-head">
              <span className="agent-approval-title">
                {approval.tool === "ExitPlanMode" ? "计划待批准" : "需要授权"}
              </span>
              <code className="agent-approval-tool">{approval.tool}</code>
            </div>
            <pre className="agent-approval-input">
              {approval.tool === "ExitPlanMode"
                ? String((approval.input as { plan?: string } | null)?.plan ?? "")
                : prettyJson(approval.input)}
            </pre>
            <input
              className="agent-approval-feedback"
              placeholder="拒绝原因(可选,会告诉模型)"
              value={approvalFeedback}
              onChange={(e) => setApprovalFeedback(e.target.value)}
            />
            <div className="agent-approval-actions">
              <button
                className="agent-approval-allow"
                onClick={() => {
                  const pending = approval;
                  setApproval(null);
                  void agentApi
                    .permissionReply(pending.sessionId, pending.id, true)
                    .catch((e) => showToast(String(e).replace(/^[A-Z_]+:\s*/, "")));
                }}
              >
                允许
              </button>
              <button
                className="agent-approval-deny"
                onClick={() => {
                  const pending = approval;
                  const feedback = approvalFeedback;
                  setApproval(null);
                  void agentApi
                    .permissionReply(pending.sessionId, pending.id, false, feedback || undefined)
                    .catch((e) => showToast(String(e).replace(/^[A-Z_]+:\s*/, "")));
                }}
              >
                拒绝
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ask_user_question: the model asked the user to decide something. */}
      {pendingQuestion && (
        <div className="agent-approval" role="dialog" aria-label="模型提问">
          <div className="agent-approval-card">
            {pendingQuestion.questions.map((q, index) => {
              const picked = questionAnswers[index] ?? [];
              const toggle = (label: string) => {
                setQuestionAnswers((prev) => {
                  const current = prev[index] ?? [];
                  const next = q.multiSelect
                    ? current.includes(label)
                      ? current.filter((v) => v !== label)
                      : [...current, label]
                    : [label];
                  return { ...prev, [index]: next };
                });
              };
              return (
                <div key={index} className="agent-question">
                  <div className="agent-approval-head">
                    <span className="agent-approval-title">
                      {q.header || `问题 ${index + 1}`}
                    </span>
                  </div>
                  <p className="agent-question-text">{q.question}</p>
                  <div className="agent-question-options">
                    {q.options.map((option) => (
                      <button
                        key={option.label}
                        className={`agent-question-option${
                          picked.includes(option.label) ? " is-picked" : ""
                        }`}
                        title={option.description}
                        onClick={() => toggle(option.label)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="agent-approval-actions">
              <button
                className="agent-approval-allow"
                disabled={pendingQuestion.questions.some(
                  (_, index) => (questionAnswers[index] ?? []).length === 0,
                )}
                onClick={() => {
                  const pending = pendingQuestion;
                  const answer = pending.questions
                    .map((q, index) => {
                      const picked = questionAnswers[index] ?? [];
                      return picked.length > 0
                        ? `${q.question}\n→ ${picked.join(", ")}`
                        : null;
                    })
                    .filter((line): line is string => line !== null)
                    .join("\n\n");
                  setPendingQuestion(null);
                  setQuestionAnswers({});
                  void agentApi
                    .questionReply(pending.sessionId, pending.id, answer)
                    .catch((e) => showToast(String(e).replace(/^[A-Z_]+:\s*/, "")));
                }}
              >
                提交
              </button>
            </div>
          </div>
        </div>
      )}
      {/* The history drawer: the conversations saved under this material, clicking one restores it and continues. */}
      {historyOpen && (
        <div className="agent-history" role="dialog" aria-label="历史会话" ref={historyRef} tabIndex={-1}>
          <div className="agent-history-head">
            <div className="agent-history-heading">
              <span className="agent-history-heading-title">历史会话</span>
              <span className="agent-history-heading-sub" title={scopeLabel?.detail}>
                {scopeLabel?.title || "本材料"}
              </span>
            </div>
            <button
              className="agent-history-close"
              title="关闭"
              aria-label="关闭"
              onClick={() => setHistoryOpen(false)}
            >
              ×
            </button>
          </div>
          <button
            className="agent-history-new"
            onClick={() => {
              setHistoryOpen(false);
              setRestartNonce((n) => n + 1);
            }}
          >
            ＋ 新会话
          </button>
          {savedSessions.length === 0 ? (
            <p className="agent-history-empty">
              {mode === "code" ? "这个项目还没有保存过会话" : "这份材料还没有保存过会话"}
            </p>
          ) : (
            <ul className="agent-history-list">
              {savedSessions.map((s) => (
                <li key={s.id}>
                  <button
                    className={`agent-history-item${
                      s.id === activeConv?.sessionFileId ? " is-active" : ""
                    }`}
                    title={s.title}
                    onClick={() => {
                      setHistoryOpen(false);
                      if (s.id === activeConv?.sessionFileId) return;
                      // Already in this family (it is in memory) → switch directly; otherwise the family is rebuilt from it, the main session hangs back as well, only the landing spot is this one.
                      const existing = convs.find((c) => c.sessionFileId === s.id);
                      if (existing) activateConv(existing.key);
                      else void restoreFamily(s.id, savedSessions, "anchor");
                    }}
                  >
                    <span className="agent-history-item-title">{s.title}</span>
                    <span className="agent-history-item-time">
                      {formatSessionTime(s.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
