import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import {
  agentApi,
  homeApi,
  remoteApi,
  type AgentChatItem,
  type AgentConfig,
  type AgentEvent,
  type MaterialInfo,
  type ModelSelection,
  type SavedSessionMeta,
  type SessionModelConfig,
  type SkillInfo,
  type StudyContent,
} from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import {
  imeBeginSkillSearch,
  imeEndSkillSearch,
  imeOnComposerFocus,
  imeSyncToEditor,
} from "@/editor/imeSwitch";
import { isImeEnter } from "@/lib/imeEnter";
import { forkLabel } from "@/study/agentFork";
import { DEFAULT_AGENT_FONT, stepAgentFont } from "@/study/agentFont";
import { ensureMaterial, sessionFilePath } from "@/study/materials";
import { transcriptIO } from "@/study/transcriptIO";
import { codeSessionIdentity, codeSessionPath, type CodeSessionScope } from "@/code/sessionScope";
import {
  notifySessionsChanged,
  onNewSessionRequest,
  onRemoteAttachRequest,
  onSessionRestore,
  requestSessionRestore,
  takePendingCodeNewSession,
  takePendingCodeSession,
  takePendingRemoteAttach,
} from "@/code/sessionRequest";
import { useProjectSidebarStore } from "@/code/projectSidebarStore";
import { cleanGeneratedTitle, displayTitle } from "@/study/sessionTitle";
import { resolveFamily } from "@/study/sessionTree";
import {
  buildSessionMeta,
  historyFromTranscript,
  serializeTranscript,
  sessionTitleFromLines,
  type TranscriptLine,
} from "@/study/transcript";
import { isWereadUrl } from "@/study/weread";
import { useInvestStore } from "@/invest/store";
import { scopeDocDir } from "@/invest/layoutModel";
import { setAgentPageTurn } from "@/study/pageTurn";
import {
  applySuggestion,
  buildSkillPrompt,
  insertSlashCommand,
  parseSuggestTrigger,
  type SuggestTrigger,
} from "@/agent/suggest";
import { AgentHeader } from "@/components/agent/AgentHeader";
import { buildSuggestItems, AgentSuggest, type SuggestItem } from "@/components/agent/AgentSuggest";
import { MAX_IMAGES_PER_MESSAGE, fileToAgentImage, type AgentImage } from "@/study/agentImages";
import {
  cloneEntry,
  entriesFromLines,
  entriesToLines,
  nextConvKey,
  studyContentKey,
  toSessionNode,
  type Conv,
  type Turn,
} from "@/components/agent/model";
import {
  agentConvKey,
  applyEnd,
  applyStart,
  newSubagentRun,
  type SubagentRun,
} from "@/components/agent/subagents";
import { collectAgentCards, createAgentCards } from "@/components/agent/agentCards";
import { lastUserEntryIndex, rewindKeep, rewindPrefix } from "@/components/agent/editResend";
import { followTranscript, measureTurnCap } from "@/components/agent/panelScroll";
import { resolveSelection, sessionSelection } from "@/components/agent/modelSelection";
import { createStreamHandler } from "@/components/agent/streamEvents";
import { createTranscriptWriter } from "@/components/agent/transcriptWriter";
import { createTranscriptCache } from "@/components/agent/transcriptCache";
import { parseBuiltinCommand, runBuiltinCommand } from "@/components/agent/builtinCommands";
import { AgentTranscript, AgentWelcome } from "@/components/agent/Transcript";
import { AgentTodos } from "@/components/agent/TodoPanel";
import { AgentMeta, AgentPermissionMenu } from "@/components/agent/Composer";
import { ModelPicker } from "@/components/agent/ModelPicker";
import { AgentHistoryDrawer } from "@/components/agent/HistoryDrawer";
import { AgentApprovalCard, type ApprovalRequest } from "@/components/agent/ApprovalCard";
import { AgentQuestionCard, type PendingQuestion } from "@/components/agent/QuestionCard";
import { AgentComposer, type ComposerController } from "@/components/agent/AgentComposer";
import { composerKeyAction } from "@/agent/composerKeys";

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
/**
 * Warm parses of the recently opened session records. Switching between
 * sessions re-reads the same files, and parsing a long record is two full
 * passes over its lines; the cache is the module's one owner (bounded LRU,
 * shape-checked per hit, see `transcriptCache`).
 */
const transcriptCache = createTranscriptCache();

export function AgentPanel() {
  const studyContent = useAppStore((s) => s.studyContent);
  const mode = useAppStore((s) => s.mode);
  const codeProject = useAppStore((s) => s.codeProject);
  const creativeMode = useAppStore((s) => s.creativeMode);
  /** The invest session scope: switching the instrument re-scopes the panel's sessions. */
  const investScope = useInvestStore((s) => s.selectedScope);
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
  /** The conv whose record is being read from disk (the transcript shows a placeholder, not the welcome state). */
  const [readingKey, setReadingKey] = useState<string | null>(null);
  const [busySession, setBusySession] = useState<string | null>(null);
  /** The saved Agent catalog (providers, models, thinking levels); the picker and the footnote read it. */
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  /** convKey → the catalog selection that session runs on (the picker's single source; a not-yet-started session keeps the choice its start will use). */
  const selectionByConvRef = useRef<Map<string, ModelSelection>>(new Map());
  /**
   * convKey → the last model-switch request issued. The thinking slider emits
   * one pick per level crossed, so switches overlap; only the newest request may
   * write its answer back, otherwise a slow older reply relabels the chip (and
   * appends its snapshot to the record) after a newer one already won.
   */
  const modelSeqRef = useRef<Map<string, number>>(new Map());
  /** convKey → the queue that keeps the backend's `set_model` calls in issue order. */
  const modelChainRef = useRef<Map<string, Promise<void>>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
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
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  /** `ask_user_question` is waiting for an answer. */
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  /** The prompt box's editor (text, caret, vim mode); null until mounted. */
  const composerRef = useRef<ComposerController | null>(null);
  /** The global vim switch: with it on, the composer is a vim surface too. */
  const vim = useAppStore((s) => s.settings.vim);

  // The composer's own auto height follows the content (CM sizes itself); a
  // font-size change re-wraps every line at a new height, and the CSS var
  // lands without an editor transaction, so the measurement is requested.
  useEffect(() => {
    composerRef.current?.view()?.requestMeasure();
  }, [agentFontScale]);
  /**
   * The message loaded in the composer to be rewritten and resent (ZCode's
   * composer edit mode): which conv, which row, and the draft it replaced —
   * cancel puts that draft back.
   */
  const [editing, setEditing] = useState<{
    convKey: string;
    index: number;
    stash: { text: string; images: AgentImage[] };
  } | null>(null);
  /**
   * The convs whose in-flight turn is being thrown away by an edit: the stream
   * handler must draw and record nothing for them until the rewrite is done.
   */
  const discardingRef = useRef<Set<string>>(new Set());
  /** An edit is being submitted: neither cancel nor another target may move under the backend's rewind. */
  const editSubmittingRef = useRef(false);
  /** The pending images, readable from callbacks whose identity must not follow every keystroke. */
  const pendingImagesRef = useRef<AgentImage[]>([]);
  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);
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
  /** convKey -> the model config snapshot of the session (used to write the metadata line; it also has to be available for the closing turn of a session that was switched away). */
  const modelByConvRef = useRef<Map<string, SessionModelConfig | null>>(new Map());
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
  const agentModeRef = useRef<"study" | "creative" | "coding" | "invest">("study");
  useEffect(() => {
    agentModeRef.current =
      mode === "code"
        ? "coding"
        : mode === "invest"
          ? "invest"
          : creativeMode
            ? "creative"
            : "study";
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
  /**
   * The code project's file index for `@` completion (CC's ls-files snapshot).
   * Loaded per workdir; a stale fetch is dropped by comparing the path before
   * writing (the project can change while the walk runs).
   */
  const [projectFiles, setProjectFiles] = useState<string[] | null>(null);
  useEffect(() => {
    if (mode !== "code" || !codeProject?.path) {
      setProjectFiles(null);
      return;
    }
    const workdir = codeProject.path;
    let cancelled = false;
    void agentApi
      .listProjectFiles(workdir)
      .then((files) => {
        if (!cancelled) setProjectFiles(files);
      })
      .catch(() => {
        if (!cancelled) setProjectFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, codeProject?.path]);
  /**
   * Streaming auto-follow is on while a turn streams; an upward scroll by the
   * user (wheel / trackpad / a page flip) turns it off for the rest of the
   * turn — once they take the scroll, the view must not fight back.
   */
  const followRef = useRef(true);
  /**
   * The freeze cap of the running turn: the scrollTop at which the reply start
   * (the line right below the newest user message) sits on the shade line. The
   * follow never scrolls past it — reached it, the view stays put and the
   * growing reply below is read by scrolling manually. Null = no shade, no cap.
   */
  const turnCapRef = useRef<number | null>(null);
  /** The scrollTop the follow last left the view at: any decrease below it
   *  while streaming is the user taking over (see the scroll listener). */
  const lastFollowPosRef = useRef<number | null>(null);

  useEffect(() => {
    convsRef.current = convs;
  }, [convs]);
  /**
   * A live copy of the saved sessions: the one-shot restore channel (the
   * project sidebar asking for a session of the open project) must read the
   * newest list without re-subscribing on every refresh.
   */
  const savedSessionsRef = useRef<SavedSessionMeta[]>([]);
  useEffect(() => {
    savedSessionsRef.current = savedSessions;
  }, [savedSessions]);
  /** A live copy of the key of the current session (the shortcut effect must not rerun when the session changes). */
  const activeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  // The skill list: the input box / the completion and the creative mode welcome page use it; it is refreshed after the config is saved (the skill directory may have changed) and when the mode changes (each mode scans its own roots). A failure silently leaves it empty (the browser harness has no backend).
  const agentMode =
    mode === "code" ? "coding" : mode === "invest" ? "invest" : creativeMode ? "creative" : "study";
  const agentWorkdir = agentMode === "coding" ? (codeProject?.path ?? null) : null;
  useEffect(() => {
    let cancelled = false;
    void agentApi
      .listSkills(agentMode, agentWorkdir)
      .then((list) => {
        if (!cancelled) setSkills(list);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentConfigVersion, agentMode, agentWorkdir]);

  // The model picker and the footnote read the saved catalog. If the config changed again while it was being read (saving the settings bumps the version), the stale result is dropped.
  useEffect(() => {
    let cancelled = false;
    void agentApi
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        setAgentConfig(cfg);
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
        projectFiles: mode === "code" ? (projectFiles ?? []) : null,
      }),
    [suggestTrigger, skills, flatFiles, recentFiles, vaultPath, currentFile, mode, projectFiles],
  );

  const activeConv = convs.find((c) => c.key === activeKey) ?? null;
  /**
   * The row the "edit and resend" handle sits on: the last user message of a
   * conversation that has a live session. A subagent's timeline and a session
   * that never came up have nothing to resend to.
   */
  const editTargetIndex =
    activeConv && !activeConv.agent && activeConv.sessionId
      ? lastUserEntryIndex(activeConv.entries)
      : null;
  /**
   * The project sidebar's active-row highlight. The sidebar store owns that
   * value; the panel is its only writer, so it publishes what it is actually
   * showing rather than the sidebar guessing from a click.
   */
  const activeSessionFileId = activeConv?.sessionFileId ?? null;
  useEffect(() => {
    if (mode !== "code" || !codeProject) return;
    // The row's presence is the record writer's news (see
    // `notifySessionsChanged`); the panel only reports which row is selected.
    useProjectSidebarStore.getState().setActiveSession(codeProject.path, activeSessionFileId);
  }, [mode, codeProject, activeSessionFileId]);
  /**
   * The sidebar's running indicator: the one backend session this panel is
   * streaming, published with its record id so the row shows a spinner and
   * leads its group (ZCode's running-first order). The panel tracks one busy
   * session, so this mirrors exactly that, not a guess.
   */
  const runningFileId =
    busySession === null
      ? null
      : (convs.find((c) => c.sessionId === busySession)?.sessionFileId ?? null);
  useEffect(() => {
    const sidebar = useProjectSidebarStore.getState();
    if (mode !== "code" || !codeProject || runningFileId === null) {
      sidebar.setRunningSession(null);
      return;
    }
    sidebar.setRunningSession({ workdir: codeProject.path, id: runningFileId });
  }, [mode, codeProject, runningFileId]);
  // Only a non-empty sessionId counts as "generating": while the session is not up yet (or the start failed) both sessionId and busySession are null, they are equal but that is not a streaming reply.
  // A subagent's own transcript streams while its row is running — it is not
  // the panel's busy session (that one is the parent's), so it is derived from
  // the run record instead.
  const activeBusy = activeConv?.agent
    ? activeConv.agent.status === "running"
    : activeConv?.sessionId != null && busySession === activeConv.sessionId;

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
      // The sidebar owns its own disk snapshot and is not a subscriber of
      // this list: announce the write, or a session created by the first
      // message stays invisible there until a project switch or a manual
      // refresh (ZCode's task_created refresh, same contract).
      notifySessionsChanged(code.workdir);
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

  // The record writer: its queue and metadata bookkeeping are private to it
  // (see transcriptWriter), the panel only says where a conv's record is.
  const writerRef = useRef<ReturnType<typeof createTranscriptWriter> | null>(null);
  if (!writerRef.current) {
    writerRef.current = createTranscriptWriter({
      pathOf: (key) => transcriptRef.current.get(key),
      homeOf: (key) => transcriptHomeRef.current.get(key) === true,
      modelOf: (key) => modelByConvRef.current.get(key) ?? null,
      originOf: (key) => convsRef.current.find((c) => c.key === key)?.origin,
      refreshSessions: () => void refreshSessions(),
    });
  }
  const writer = writerRef.current;

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
        /** Restore/fork: the catalog selection of the source session (a current record carries it). */
        selection?: ModelSelection | null;
        /** Restore: the session record id, so the persisted task list continues. */
        taskListId?: string;
      },
    ) => {
      const token = ++startTokenRef.current;
      setStarting(true);
      updateConv(convKey, (c) => ({ ...c, error: undefined, errorKind: undefined }));
      try {
        const mode = agentModeRef.current;
        // The model the session starts on: the restored/forked one when given,
        // else the choice the picker made for this conv (null = the default of
        // the settings, resolved by the backend).
        const selection = opts?.selection ?? selectionByConvRef.current.get(convKey) ?? null;
        const info = await agentApi.startSession(
          content,
          undefined,
          opts?.history,
          opts?.model,
          selection,
          mode === "study" ? undefined : mode,
          // A coding session anchors relative paths and bash in the repository.
          mode === "coding" ? codeScopeRef.current?.workdir : undefined,
          opts?.taskListId,
          // An invest session binds to one scope: the read_skill tool reads
          // exactly that instrument's bundle, nothing else.
          mode === "invest" ? (useInvestStore.getState().selectedScope ?? undefined) : undefined,
        );
        // Dropped when it expired: the content changed in the meantime (a new material / a new session), a new start has taken over.
        if (startTokenRef.current !== token) return;
        // The path of the session record: a restore keeps the old file, a new session uses "the scope directory + the session id of the backend". Creative mode is fixed at .bnote/creative/sessions/, so it never mixes with the sessions of a material. A coding session writes into the agent home instead (the repository is not the notebook). The store follows the session kind — coding sessions recorded under `~/.bnote/projects/` must also read and write through the home commands, so `home` is derived from the mode here (no caller passes the flag; deriving it made every coding transcript silently land on a null path).
        const home = opts?.transcriptHome ?? agentModeRef.current === "coding";
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
        // The backend resolved the model; its selection is what the picker
        // shows and what a restore resolves again.
        const resolvedSelection = info.selection ?? selection;
        if (resolvedSelection) selectionByConvRef.current.set(convKey, resolvedSelection);
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
          writer.markMetaWritten(convKey, true);
        } else {
          // Restore: the file already has the metadata (old records have none, the title falls back to the parsing on the list side); a new session: the metadata line is written together with the first message when it reaches the disk, so that an empty session never enters the list.
          writer.markMetaWritten(convKey, Boolean(opts?.transcriptPath));
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
                  selection: resolvedSelection,
                  // The list the backend loaded for this session record (a
                  // restored session shows the plan it was working through).
                  todos: info.todos ?? c.todos,
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
      // The placeholder holds until the entries land: the welcome state must
      // not flash for the turn it takes to read and parse the record. Every
      // exit clears it for this conv only (a newer restore may own the slot).
      setReadingKey(conv.key);
      try {
        const raw = await transcriptIO(conv.transcriptHome === true)
          .read(path)
          .catch(() => null);
        if (restoreTokenRef.current !== token) return;
        const parsed = raw === null ? null : transcriptCache.get(path, raw);
        const lines = parsed?.lines ?? [];
        if (lines.length === 0) {
          showToast("这条会话记录是空的");
          return;
        }
        // The model config snapshot of the session itself: later setting changes do not affect this session, and a restore continues with it.
        const sessionMeta = parsed?.meta ?? null;
        updateConv(conv.key, (c) => ({
          ...c,
          entries: entriesFromLines(lines),
          label: sessionMeta?.title?.trim() ? sessionMeta.title : c.label,
          basedOn: sessionMeta?.basedOn ?? c.basedOn,
          forkAt: sessionMeta?.forkAt ?? c.forkAt,
          titleSource: sessionMeta?.titleSource === "llm" ? "llm" : "first-message",
          model: sessionMeta?.model ?? c.model,
        }));
        transcriptRef.current.set(conv.key, path);
        // The record file already has the metadata (old records have none, the title falls back to the list side); it is not written twice, and the bookkeeping of the other sessions is not cleared either — the round that is still streaming needs it when it closes.
        writer.markMetaWritten(conv.key, true);
        void startSession(conv.key, materialContent, {
          history: historyFromTranscript(lines),
          transcriptPath: path,
          transcriptHome: conv.transcriptHome === true,
          model: sessionMeta?.model,
          taskListId: conv.sessionFileId ?? undefined,
        });
      } finally {
        setReadingKey((key) => (key === conv.key ? null : key));
      }
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
        // The record store follows the session kind (the same rule as
        // startSession): coding records live in the agent home and must read
        // and write through the home IPC, not the vault commands.
        transcriptHome: code !== null,
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
        void launchRestored(focus, token).finally(() => lazyStartingRef.current.delete(focusKey));
      }
    },
    [launchRestored],
  );

  /**
   * Attach to a session that is already live on the Mac (normally one a phone
   * is driving). This deliberately does not call `agent_start_session`: the
   * backend session exists and is the only executor, so the panel becomes a
   * second view over it. The record's lines rebuild the UI; the backend keeps
   * writing the transcript (`origin: "remote"` turns the local writer off).
   */
  const attachRemoteSession = useCallback(
    async (transcriptId: string, token: number): Promise<boolean> => {
      const code = codeScopeRef.current;
      const homeDir = code?.homeDir;
      if (!homeDir) return false;
      try {
        const result = await remoteApi.attachSession(transcriptId);
        if (!result.live || !result.liveId) return false;
        const liveId = result.liveId;
        if (restoreTokenRef.current !== token) return true;
        const path = codeSessionPath(homeDir, transcriptId);
        if (!path) return false;
        const raw = await transcriptIO(true)
          .read(path)
          .catch(() => null);
        if (restoreTokenRef.current !== token) return true;
        const lines = raw === null ? [] : (transcriptCache.get(path, raw)?.lines ?? []);
        const conv: Conv = {
          key: nextConvKey(),
          sessionId: liveId,
          entries: entriesFromLines(lines),
          label: result.title?.trim() || "远程会话",
          parent: null,
          basedOn: "",
          forkAt: 0,
          titleSource: "first-message",
          mcpErrors: [],
          transcriptPath: path,
          transcriptHome: true,
          sessionFileId: transcriptId,
          model: null,
          usage: null,
          todos: [],
          origin: "remote",
        };
        setConvs([conv]);
        turnsRef.current.clear();
        lazyStartingRef.current.clear();
        setActiveKey(conv.key);
        transcriptRef.current.set(conv.key, path);
        writer.markMetaWritten(conv.key, true);
        return true;
      } catch (e) {
        showToast(String(e).replace(/^[A-Z_]+:\s*/, ""));
        return false;
      }
    },
    [showToast, writer],
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
   * The project sidebar's pick inside the open project: the panel is already
   * mounted, so the click is a one-shot request rather than a project reopen.
   * A session already in memory is switched to; one of another family is
   * rebuilt from disk — the same two choices the history drawer makes.
   */
  /** The sidebar's click on a remote row while the project is already open. */
  useEffect(() => {
    if (mode !== "code") return;
    return onRemoteAttachRequest((id) => {
      const existing = convsRef.current.find((c) => c.sessionFileId === id);
      if (existing && existing.origin === "remote") {
        activateConv(existing.key);
        return;
      }
      void attachRemoteSession(id, restoreTokenRef.current).then((ok) => {
        if (!ok) requestSessionRestore(id);
      });
    });
  }, [mode, activateConv, attachRemoteSession]);

  useEffect(() => {
    if (mode !== "code") return;
    return onSessionRestore((id) => {
      const existing = convsRef.current.find((c) => c.sessionFileId === id);
      if (existing) {
        activateConv(existing.key);
        return;
      }
      if (savedSessionsRef.current.some((s) => s.id === id)) {
        void restoreFamily(id, savedSessionsRef.current, "anchor");
      }
    });
  }, [mode, activateConv, restoreFamily]);

  /**
   * The sidebar's "new session": the same restart the history drawer's
   * "＋ 新会话" performs (the nonce forces a fresh conversation instead of
   * restoring the newest one). Separate channel because that action lives
   * inside the panel and the sidebar is a sibling column.
   */
  useEffect(() => {
    if (mode !== "code") return;
    return onNewSessionRequest(() => setRestartNonce((n) => n + 1));
  }, [mode]);

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
        .generateTitle(
          seed,
          conv.model ?? undefined,
          conv.selection ?? null,
          conv.sessionId ?? null,
        )
        .then((raw) => {
          const clean = cleanGeneratedTitle(raw);
          if (!clean) return;
          const label = displayTitle(clean, conv.parent !== null);
          updateConv(convKey, (c) => ({ ...c, label, titleSource: "llm" }));
          const id = conv.sessionFileId;
          if (!id) return;
          // The title rewrite is a read-modify-write of the same record: it
          // queues on the conversation's transcript chain, or it would race a
          // concurrent append and drop the appended line.
          const write = codeWorkdir
            ? () => homeApi.setSessionTitle(codeWorkdir, id, label)
            : relDir
              ? () => agentApi.setSessionTitle(relDir, id, label)
              : null;
          if (write) writer.enqueue(convKey, write, "[agent] failed to write the title");
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
    // An invest session is bound to its scope (read_skill reads exactly that
    // bundle): with no scope selected yet there is nothing to bind, so wait —
    // the identity below changes to a real scope as soon as the layout's
    // initialize lands, and the session starts then. Starting one with
    // `invest_scope: null` froze the tool's scope at None forever (blind
    // test: every read_skill call failed until the user re-entered the mode).
    if (mode === "invest" && !investScope) return;
    const identity =
      mode === "code"
        ? codeSessionIdentity(codeProject?.path ?? null)
        : mode === "invest"
          ? `invest|${investScope ?? "none"}`
          : creativeMode
            ? `creative|${restartNonce}`
            : studyContentKey(materialContent);
    const key = `${mode === "code" ? "d" : mode === "invest" ? "n" : creativeMode ? "c" : "s"}|${identity}|${restartNonce}`;
    if (startedKeyRef.current === key) return;
    startedKeyRef.current = key;
    // A new scope starts outside plan mode (the plan belonged to the previous
    // conversation's session).
    setPlanActive(false);

    const forcedNew = restartKeyRef.current !== null && restartKeyRef.current !== restartNonce;
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
        // A pending pick from the project sidebar wins over the default
        // "restore the newest one": the click named the landing spot. "New
        // session in that project" is the same channel and outranks a restore.
        const startFresh = takePendingCodeNewSession(codeProject.path);
        const remotePick = startFresh ? null : takePendingRemoteAttach(codeProject.path);
        if (remotePick) {
          if (await attachRemoteSession(remotePick, token)) return;
        }
        const picked = startFresh ? null : takePendingCodeSession(codeProject.path);
        if (picked && sessions.some((s) => s.id === picked)) {
          await restoreFamily(picked, sessions, "anchor");
          return;
        }
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
      if (mode === "invest") {
        // An invest session belongs to the scope (stock:<code> /
        // sector:<code>): its transcripts live under the scope's document
        // directory, next to the analysis notes (the same layout the study
        // material directories follow). The backend's sessions-list
        // whitelist accepts `invest/…` (see commands/materials.rs).
        const invest = useInvestStore.getState();
        if (!invest.selectedScope) {
          info = null;
        } else {
          const dir = scopeDocDir(invest.selectedScope);
          info = dir
            ? {
                kind: "pdfs",
                dir: "invest",
                relDir: `invest/${dir}`,
                title: invest.selectedTitle || invest.selectedScope,
              }
            : null;
        }
      } else if (creativeMode) {
        // Creative mode has no material directory: its sessions all land in .bnote/creative/sessions/.
        info = { kind: "pdfs", dir: "creative", relDir: "creative", title: "创作模式" };
      } else {
        info = vault && materialContent ? await ensureMaterial(vault, materialContent) : null;
      }
      if (startTokenRef.current !== token) return;
      materialRef.current = { identity, info };
      setScopeLabel(info ? { title: info.title, detail: info.relDir } : null);
      const sessions = info ? await agentApi.sessionsList(info.relDir).catch(() => []) : [];
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
  }, [
    materialContent,
    creativeMode,
    mode,
    codeProject,
    restartNonce,
    startSession,
    restoreFamily,
    attachRemoteSession,
    investScope,
  ]);

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

  /**
   * The assistant column owns its own placement. Working in it puts it in the
   * middle (mainColumn); that swap is **sticky** — moving the focus to the
   * notes column does not move it back, only a click in the content column or
   * the focus-reading command does. The same state decides what the page-turn
   * key scrolls, so the visible layout and the key target cannot disagree.
   */
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const onFocusIn = () => useAppStore.getState().setMainColumn("agent");
    el.addEventListener("focusin", onFocusIn);
    return () => el.removeEventListener("focusin", onFocusIn);
  }, []);

  // An upward scroll while a reply streams is the user taking over the view:
  // stop following for the rest of the turn. The follow only ever moves the
  // view DOWN (target > scrollTop), so any decrease from the last auto
  // position is the user's — wheel, trackpad, scrollbar drag or a script.
  // The wheel listener additionally catches an upward wheel at scrollTop 0,
  // where no scroll event fires.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (followRef.current && el.scrollTop < (lastFollowPosRef.current ?? 0) - 1) {
        followRef.current = false;
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) followRef.current = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  /**
   * The page-turn command scrolls the column that sits in the middle; the
   * resolver (study/pageTurn.ts) decides whether that is this panel. Register
   * for as long as the panel is mounted — "I can turn" and "I am the middle"
   * are different questions, and only the layout's `mainColumn` answers the
   * second one.
   */
  useEffect(() => {
    const pageBy = (direction: 1 | -1) => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      // Flip around the shade line — the content at the boundary becomes the
      // new top (the PDF flip's contract). The step is measured from the shade
      // element itself, so the composer below the scroller can never leak into
      // the distance: only the visible transcript part is scrolled.
      const shade = scroller.parentElement?.querySelector(".agent-read-shade");
      const lineY = shade
        ? shade.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top
        : scroller.clientHeight * useAppStore.getState().settings.studyPageStep;
      if (direction === -1) followRef.current = false;
      scroller.scrollBy({ top: direction * lineY, behavior: "smooth" });
    };
    setAgentPageTurn({ canFlip: () => true, prev: () => pageBy(-1), next: () => pageBy(1) });
    return () => setAgentPageTurn(null);
  }, []);

  // Scroll to the bottom after switching the session (every session is looked at from its newest message).
  useEffect(() => {
    requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      // Adopt the cap of a turn that may already be streaming: measured from
      // the newest user row, so a switched-to session freezes at the same
      // shade line a fresh send would have.
      turnCapRef.current = measureTurnCap(scroller);
      scroller.scrollTo({ top: scroller.scrollHeight });
    });
  }, [activeKey]);

  // A restored session fills its transcript asynchronously: the effect above
  // ran while the list was empty, so land on the newest entries once they
  // arrive. Without this the reader opens a history at its first message.
  //
  // One rAF scroll is not enough: the rows keep growing after the first
  // layout (fonts, math, code highlighting), and a scroll read at that moment
  // lands short of the tail. The pin follows the content's resizes until the
  // reader scrolls up or the window closes, then it stops for good.
  const landedKeyRef = useRef<string | null>(null);
  const pinStopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => pinStopRef.current?.(), []);
  useEffect(() => {
    const conv = activeConv;
    if (!conv || conv.entries.length === 0) return;
    if (landedKeyRef.current === conv.key) return;
    landedKeyRef.current = conv.key;
    pinStopRef.current?.();
    const scroller = scrollRef.current;
    if (!scroller) return;
    followRef.current = true;
    lastFollowPosRef.current = null;
    turnCapRef.current = measureTurnCap(scroller);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      observer?.disconnect();
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
      pinStopRef.current = null;
    };
    const pin = () => {
      if (stopped) return;
      // Re-validate: a newer restore, a switched conversation, or the reader
      // taking over the view all end the pin.
      if (followRef.current && landedKeyRef.current === conv.key) {
        scroller.scrollTo({ top: scroller.scrollHeight });
        return;
      }
      stop();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(pin);
    if (observer) for (const child of scroller.children) observer.observe(child);
    const raf = requestAnimationFrame(pin);
    const timer = window.setTimeout(stop, 1500);
    pinStopRef.current = stop;
  }, [activeConv]);

  /** Writes the whole prompt (history, completion, cleared after a send). */
  function writeComposer(text: string, caret = text.length) {
    setInput(text);
    composerRef.current?.setText(text, caret);
  }

  /** Moves through the fetched prompt history (index -1 = the empty box). */
  function stepHistory(direction: 1 | -1) {
    const items = historyItemsRef.current;
    if (!items || items.length === 0) return;
    const next = historyIndexRef.current + direction;
    if (next < 0) {
      historyIndexRef.current = -1;
      writeComposer("");
      return;
    }
    if (next >= items.length) {
      historyIndexRef.current = items.length - 1;
      return;
    }
    historyIndexRef.current = next;
    writeComposer(items[next]);
  }

  /** ↑ on an empty box: walk back through the prompts of this project. */
  function historyBack() {
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
  }

  /**
   * The event handler: a backend event goes to the conversation that owns the
   * session, even when it is not the one on screen. The rules live in
   * `streamEvents`; this object only supplies the panel's state and callbacks.
   */
  /**
   * The live subagent cards, keyed by the `Agent` tool call. The panel is the
   * only writer (it owns `convs`); the transcript's rows subscribe, so a child
   * delta wakes that one card instead of the whole conversation.
   */
  const agentCards = useRef(createAgentCards()).current;
  const streamRef = useRef<((sessionId: string, event: AgentEvent) => void) | null>(null);
  if (!streamRef.current) {
    streamRef.current = createStreamHandler({
      convs: () => convsRef.current,
      turns: turnsRef.current,
      sessionIndex: sessionIndexRef.current,
      patchConvs: setConvs,
      updateConv,
      persistTurn: writer.persistTurn,
      clearBusy: (sessionId) => {
        if (busyRef.current !== sessionId) return;
        busyRef.current = null;
        setBusySession(null);
      },
      setApproval,
      setPendingQuestion,
      setPlanActive,
      onTurnClosed: (convKey) => {
        // The first round succeeded: name the session after its own first
        // message (the local fallback title holds the line until then).
        const seed = titleSeedRef.current.get(convKey);
        if (!seed) return;
        titleSeedRef.current.delete(convKey);
        generateTitle(convKey, seed);
      },
      onSubagentStart: (parentSessionId, event) => {
        // The child's own deltas are routed by its session id, so the panel
        // first gives it a conv of its own; the row in the parent's strip and
        // that conv are written in the same update (one owner each).
        const now = Date.now();
        setConvs((prev) => {
          const owner = prev.find((c) => c.sessionId === parentSessionId);
          if (!owner) return prev;
          const childKey = agentConvKey(owner.key, event.agentId);
          const nextRun = newSubagentRun(event, owner.key, now);
          const withRow = prev.map((c) =>
            c.key === owner.key
              ? { ...c, agents: applyStart(c.agents ?? [], event, owner.key, now) }
              : c,
          );
          const existing = withRow.find((c) => c.key === childKey);
          if (existing) {
            // SendMessage resumed an agent that already ran: keep its
            // transcript and flip its row back to running.
            return withRow.map((c) => (c.key === childKey ? { ...c, agent: nextRun } : c));
          }
          const child: Conv = {
            key: childKey,
            sessionId: event.agentId,
            entries: [],
            label: nextRun.label,
            parent: owner.key,
            basedOn: nextRun.label,
            forkAt: 0,
            titleSource: "first-message",
            mcpErrors: [],
            transcriptPath: null,
            sessionFileId: null,
            model: null,
            usage: null,
            todos: [],
            agent: nextRun,
          };
          return [...withRow, child];
        });
      },
      onSubagentEnd: (parentSessionId, event) => {
        const now = Date.now();
        setConvs((prev) => {
          const closed = prev.map((c) =>
            c.agent && c.agent.agentId === event.agentId
              ? { ...c, agent: applyEnd([c.agent], event, now)[0] }
              : c,
          );
          return closed.map((c) =>
            c.sessionId === parentSessionId && c.agents
              ? { ...c, agents: applyEnd(c.agents, event, now) }
              : c,
          );
        });
      },
      afterEvent: (convKey) => {
        // An event of the conversation on screen proves its session is
        // generating. This restores the flag when an edit's rewind raced it:
        // the stopped turn's terminal event may arrive after the panel already
        // marked the replacement turn busy, and clearing it there would leave
        // the box showing Send while a reply streams.
        if (activeKeyRef.current === convKey && turnsRef.current.has(convKey)) {
          const conv = convsRef.current.find((c) => c.key === convKey);
          const sessionId = conv && !conv.agent ? conv.sessionId : null;
          if (sessionId && busyRef.current !== sessionId) {
            busyRef.current = sessionId;
            setBusySession(sessionId);
          }
        }
        // Stream auto-scroll, only for the conversation that is on screen: a
        // background session's reply must never move the view the user reads.
        requestAnimationFrame(() => {
          const scroller = scrollRef.current;
          if (!scroller || !followRef.current || activeKeyRef.current !== convKey) return;
          lastFollowPosRef.current =
            followTranscript(scroller, turnCapRef.current) ?? lastFollowPosRef.current;
        });
      },
      discarding: (convKey) => discardingRef.current.has(convKey),
    });
  }
  const handleAgentEvent = streamRef.current;

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

  /**
   * The shortcut form of typing "/": the slash lands where typing it would, and
   * the completion popup opens right away (a programmatic value write fires no
   * change event, so the trigger is set here instead of waiting for one).
   */
  const openSlashCommands = useCallback(() => {
    const composer = composerRef.current;
    const selection = composer?.selection() ?? { from: 0, to: 0 };
    const next = insertSlashCommand(composer?.text() ?? input, selection.from, selection.to);
    writeComposer(next.text, next.caret);
    setSuggestTrigger(parseSuggestTrigger(next.text, next.caret));
    setSuggestIndex(0);
    // vim: the shortcut writes for the user, so the box must be insert-ready
    // (a programmatic insertion leaves the engine in normal mode).
    composer?.enterInsert();
    composer?.focus();
    // Skill names are typed in Latin letters: the picker wants the English
    // source. This runs after the focus handler, so its intent is the last one
    // that goes out (the focus handler would have asked for Chinese).
    imeOnComposerFocus(true);
    imeBeginSkillSearch();
  }, [input]);

  /** Pick a completion candidate: the trigger word is replaced and the caret lands after the inserted text. */
  const pickSuggestion = (item: SuggestItem) => {
    if (!suggestTrigger) return;
    // Enter/Tab only fills the trigger ("/name " or "@path "), never submits —
    // the user reviews or adds arguments first, then Enter on the composer
    // sends (the submit path routes the built-ins).
    const next = applySuggestion(input, suggestTrigger, item.insert);
    writeComposer(next.text, next.caret);
    setSuggestTrigger(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  /**
   * Splice a quoted block into the box at the caret (the focus-agent chord,
   * pressed over a code selection).
   *
   * The current text and the caret are read from the editor instead of the
   * `input` state: this runs inside the command effect, whose closure is a
   * render behind.
   */
  const insertIntoInput = useCallback((block: string) => {
    const composer = composerRef.current;
    if (!composer) return;
    const text = composer.text();
    const { from, to } = composer.selection();
    const before = text.slice(0, from);
    // The quote is its own paragraph: never glued to whatever the user had
    // already typed in front of the caret.
    const inserted = `${before === "" || before.endsWith("\n") ? "" : "\n"}${block}`;
    const caret = before.length + inserted.length;
    writeComposer(before + inserted + text.slice(to), caret);
    setSuggestTrigger(null);
    composer.enterInsert();
  }, []);

  /** The built-in `/` commands: the set and the wiring of their panel effects. */
  const builtinContext = useMemo(
    () => ({
      compact: async (sessionId: string) => {
        if (busyRef.current === sessionId) return;
        busyRef.current = sessionId;
        setBusySession(sessionId);
        try {
          await agentApi.compact(sessionId);
        } catch (e) {
          busyRef.current = null;
          setBusySession(null);
          showToast(String(e).replace(/^[A-Z_]+:\s*/, ""));
        }
      },
      newSession: () => setRestartNonce((n) => n + 1),
      notice: (convKey: string, text: string) =>
        updateConv(convKey, (c) => ({
          ...c,
          entries: [...c.entries, { role: "notice", text, at: Date.now(), items: null }],
        })),
    }),
    [showToast, updateConv],
  );

  /**
   * The user's own bubble must be visible the moment it is sent. In a long
   * conversation it lands below the fold, and the only other scroll points are
   * the session switch and a stream event — without this the bubble looks like
   * it arrives together with the reply (the first token).
   * The turn's freeze cap is measured now: the reply that starts streaming
   * below this bubble may scroll the view only until that bubble's bottom line
   * reaches the shade line.
   */
  function revealSentBubble() {
    requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      followRef.current = true;
      lastFollowPosRef.current = null;
      turnCapRef.current = measureTurnCap(scroller);
      scroller.scrollTo({ top: scroller.scrollHeight });
    });
  }

  /**
   * Submits the message being edited ("edit and resend").
   *
   * The backend stops a running turn, drops the old prompt and everything it
   * produced from the session history, and opens the next turn with the new
   * text. The panel mirrors that: the rows from the edited message on are
   * dropped, and the record gets a rewind marker before the new user line — so
   * a restore reads the same conversation the live session has.
   */
  async function sendEdited(
    conv: Conv,
    edit: NonNullable<typeof editing>,
    text: string,
    modelText: string,
    images: AgentImage[],
    info: string,
  ) {
    if (!text && images.length === 0) {
      // An empty prompt would leave the model with a turn that says nothing.
      showToast("消息不能为空");
      return;
    }
    // Whatever the stopped turn still emits belongs to the branch being cut:
    // it must land neither in the rows nor in the record.
    discardingRef.current.add(conv.key);
    editSubmittingRef.current = true;
    try {
      const { keptItems } = await agentApi.editUserMessage(info, modelText, images);
      // Re-read the list: the streaming turn may have appended a draft row
      // since the render this click belongs to.
      const live = convsRef.current.find((c) => c.key === conv.key);
      const prefix = rewindPrefix(live?.entries ?? conv.entries, edit.index);
      const at = Date.now();
      writeComposer("");
      setPendingImages([]);
      setEditing(null);
      setSuggestTrigger(null);
      // The stopped turn is dead even if its terminal event has not been
      // handled yet: without a live turn there is nothing left to commit, so a
      // late one cannot draw the discarded reply above the rewritten message.
      turnsRef.current.delete(conv.key);
      busyRef.current = info;
      setBusySession(info);
      updateConv(conv.key, (c) => ({
        ...c,
        error: undefined,
        errorKind: undefined,
        entries: [
          ...prefix,
          {
            role: "user",
            text,
            at,
            images: images.length > 0 ? images : undefined,
            // The backend just rewound to `keptItems`: the new prompt is the
            // entry right after them.
            items: keptItems + 1,
          },
        ],
      }));
      writer.persistRewind(conv.key, rewindKeep(prefix));
      writer.persistUserLine(conv.key, {
        type: "user",
        at,
        text,
        images: images.length > 0 ? images : undefined,
      });
      revealSentBubble();
    } catch (e) {
      // The backend refused before touching the history (no prompt to edit, a
      // turn that would not stop): the old branch is whole, the edit stays open
      // with what the user typed.
      const message = String(e).replace(/^[A-Z_]+:\s*/, "");
      showToast(message);
      updateConv(conv.key, (c) => ({ ...c, error: message, errorKind: "send" }));
    } finally {
      editSubmittingRef.current = false;
      discardingRef.current.delete(conv.key);
    }
  }

  async function send() {
    // Read from the editor, not the mirrored state: the send key runs in the
    // capture phase, and the last keystroke's React state may still be a render
    // behind.
    const text = (composerRef.current?.text() ?? input).trim();
    const conv = activeConv;
    // The next ↑ refetches: this prompt is about to enter the history file.
    historyIndexRef.current = -1;
    historyItemsRef.current = null;
    if (!conv || (!text && pendingImages.length === 0)) return;
    // A subagent's timeline is read-only: the child lives outside the app's
    // session registry, so there is nothing to send to. Its own input arrived
    // from the model's Agent call, and a follow-up goes through SendMessage
    // from the parent agent.
    if (conv.agent) {
      showToast("子代理会话只读,返回主会话继续对话");
      return;
    }
    // The message being edited replaces the last one instead of following it;
    // it is never a panel command, so the builtin branch is skipped for it.
    const editingThis = editing && editing.convKey === conv.key ? editing : null;
    // Built-in panel commands (/compact /clear /help): panel actions, never a
    // message — the model never sees them.
    if (!editingThis) {
      const builtin = parseBuiltinCommand(text);
      if (builtin) {
        writeComposer("");
        await runBuiltinCommand(builtin, conv, builtinContext);
        return;
      }
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
    if (!editingThis && busyRef.current === info) {
      // A turn is still generating. Returning silently here is what reads as
      // "sending does nothing": the backend may be inside a model retry, so
      // the message would disappear without a trace. Say so; the stop button
      // is the exit. Editing is the one send that may arrive now: it stops the
      // turn, because the reply is about to be thrown away.
      showToast("上一条回复还在生成:先停止或等它结束");
      return;
    }
    // `/name args` for a known skill expands to the skill's body (CC's
    // processPromptSlashCommand): the transcript keeps what the user typed,
    // the model sees the command metadata plus the expanded instructions.
    let modelText = text;
    const slash = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text);
    const skillMatch = slash ? skills.find((s) => s.name === slash[1]) : undefined;
    if (skillMatch) {
      try {
        const body = await agentApi.readSkill(
          agentModeRef.current,
          mode === "code" ? (codeProject?.path ?? null) : null,
          skillMatch.name,
        );
        modelText = buildSkillPrompt(body, skillMatch.name, slash?.[2]?.trim() ?? "");
      } catch {
        // The skill body cannot be read (backend gone / removed meanwhile):
        // the trigger text itself still explains the intent to the model.
      }
    }
    const images = pendingImages;
    if (editingThis) {
      // The text in the box replaces the message being edited (the transcript
      // takes the words, the model the skill-expanded form, as with a send).
      await sendEdited(conv, editingThis, text, modelText, images, info);
      return;
    }
    writeComposer("");
    setPendingImages([]);
    busyRef.current = info;
    setBusySession(info);
    const last = conv.entries[conv.entries.length - 1];
    const items = last?.items != null ? last.items + 1 : null;
    const at = Date.now();
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
    revealSentBubble();
    try {
      await agentApi.send(info, modelText, images);
      // The backend accepted the message: the question enters the record now
      // (Claude Code persists the prompt before the loop), so even a turn that
      // never terminates leaves it on disk. A failed send never reaches here.
      writer.persistUserLine(conv.key, {
        type: "user",
        at,
        text,
        images: images.length > 0 ? images : undefined,
      });
    } catch (e) {
      busyRef.current = null;
      setBusySession(null);
      const message = String(e).replace(/^[A-Z_]+:\s*/, "");
      // The backend did not receive this round: the ghost message that was just inserted into the UI is taken back, the content goes back into the input box and the reason stays on the error banner of the session. Otherwise the UI hangs on a message that will never be answered.
      updateConv(conv.key, (c) => ({
        ...c,
        error: message,
        errorKind: "send",
        entries: c.entries.slice(0, -1),
      }));
      writeComposer(text);
      setPendingImages(images);
    }
  }

  function abort() {
    const info = activeConv?.sessionId;
    if (!info) return;
    void agentApi
      .abort(info)
      .then((live) => {
        if (live) return;
        // The backend has no such session (the process restarted — a dev
        // rebuild or a replaced binary): no terminal event can ever arrive,
        // so the panel clears its own busy state. A silent no-op here kept
        // the panel on "generating" forever with a stop button that did
        // nothing — the one state where stop genuinely cannot work.
        if (busyRef.current === info) {
          busyRef.current = null;
          setBusySession(null);
        }
        showToast("会话已失效,已停止等待(重新发送会开启新会话)");
      })
      .catch((e) => showToast(String(e).replace(/^[A-Z_]+:\s*/, "")));
  }

  /**
   * Loads the last user message into the composer to rewrite and resend it.
   *
   * The draft in the box is stashed, not copied: cancel (or leaving the
   * conversation) puts it back. Only the last user message is offered — an
   * older one would take every later turn with it.
   */
  const beginEdit = useCallback(
    (index: number) => {
      const conv = activeConv;
      if (!conv || conv.agent || editSubmittingRef.current) return;
      if (!conv.sessionId) {
        showToast("会话未就绪,不能编辑这条消息");
        return;
      }
      const entry = conv.entries[index];
      if (!entry || entry.role !== "user") return;
      if (editing && editing.convKey === conv.key && editing.index === index) {
        composerRef.current?.focus();
        return;
      }
      // A second target keeps the draft from before the first edit: the stash
      // is always "what the user was writing", never the message being edited.
      const stash =
        editing && editing.convKey === conv.key
          ? editing.stash
          : { text: composerRef.current?.text() ?? "", images: pendingImagesRef.current };
      setEditing({ convKey: conv.key, index, stash });
      setInput(entry.text);
      composerRef.current?.setText(entry.text);
      setPendingImages(entry.images ?? []);
      setSuggestTrigger(null);
      composerRef.current?.focus();
      // A programmatic edit must leave the box ready to type: in vim normal
      // mode the loaded text would be a motion surface, not a prompt.
      composerRef.current?.enterInsert();
    },
    [activeConv, editing, showToast],
  );

  /** Drops the edit and gives the composer its own draft back. */
  function cancelEdit() {
    if (!editing || editSubmittingRef.current) return;
    setEditing(null);
    setInput(editing.stash.text);
    composerRef.current?.setText(editing.stash.text);
    setPendingImages(editing.stash.images);
    composerRef.current?.focus();
  }

  // Leaving the conversation abandons the edit (the stash belongs to that
  // conversation): the draft comes back instead of following the switch.
  useEffect(() => {
    if (!editing || editing.convKey === activeKey || editSubmittingRef.current) return;
    setEditing(null);
    setInput(editing.stash.text);
    composerRef.current?.setText(editing.stash.text);
    setPendingImages(editing.stash.images);
  }, [activeKey, editing]);

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
        selection: src.selection ?? null,
        usage: null,
        todos: [],
      };
      setConvs((prev) => [...prev, conv]);
      setActiveKey(conv.key);
      void startSession(conv.key, materialContent, {
        history: historyFromTranscript(seedLines),
        seedLines,
        model: src.model ?? undefined,
        selection: src.selection ?? null,
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

  // Publish the subagent cards after every conv change: the transcript rows
  // read them through their own subscription (an effect, so the write never
  // happens during a render).
  useEffect(() => {
    agentCards.replace(collectAgentCards(convs));
  }, [convs, agentCards]);

  /**
   * Stop one agent: the command is addressed by (parent session, agent id), so
   * the owner of the run is looked up in the live convs rather than carried on
   * the card.
   */
  const stopAgent = useCallback(
    (run: SubagentRun) => {
      const owner = convsRef.current.find((conv) =>
        conv.agents?.some((agent) => agent.agentId === run.agentId),
      );
      const sessionId = owner?.sessionId;
      if (!sessionId) return;
      void agentApi
        .stopSubagent(sessionId, run.agentId)
        .catch((e) => showToast(String(e).replace(/^[A-Z_]+:\s*/, "")));
    },
    [showToast],
  );

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
      composerRef.current?.focus();
      imeOnComposerFocus(true);
    };
    switch (cmd.kind) {
      case "focus-input":
        // The quote goes in before the focus so the box opens already holding
        // the code (one action: quote + focus).
        if (cmd.insert) insertIntoInput(cmd.insert);
        focusInput();
        break;
      case "slash-command":
        // Pressing it again while the picker is already open must not stack a
        // second slash: it only puts the caret back into the box.
        if (suggestTrigger?.kind === "skill") focusInput();
        else openSlashCommands();
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
  }, [
    agentPanelCommand,
    activeConv,
    parentConv,
    forkFrom,
    historyOpen,
    focusHistory,
    showToast,
    pendingImages,
    activateConv,
    setCreativeMode,
    insertIntoInput,
    openSlashCommands,
    suggestTrigger,
  ]);

  // Once the history drawer is open the focus goes to the list, Tab / Enter work right away.
  useEffect(() => {
    if (!historyOpen || !historyFocusPending.current) return;
    historyFocusPending.current = false;
    focusHistory();
  }, [historyOpen, focusHistory]);

  /**
   * Switches the model / thinking level of the active conversation.
   *
   * A session that is already up swaps on the backend (the next provider round
   * uses it) and the new snapshot is appended to its record, so a restart
   * restores the same model. A conversation that has not started yet only
   * remembers the choice; its start sends it.
   */
  const changeModel = useCallback(
    (selection: ModelSelection) => {
      const key = activeKeyRef.current;
      if (!key) return;
      const conv = convsRef.current.find((c) => c.key === key);
      if (!conv) return;
      // What the chip showed before this pick: a refused swap goes back to it.
      const previous = selectionByConvRef.current.get(key) ?? conv.selection ?? null;
      selectionByConvRef.current.set(key, selection);
      updateConv(key, (c) => ({ ...c, selection }));
      if (!conv.sessionId) return;
      const sessionId = conv.sessionId;
      const seq = (modelSeqRef.current.get(key) ?? 0) + 1;
      modelSeqRef.current.set(key, seq);
      const swap = async () => {
        try {
          const res = await agentApi.setSessionModel(sessionId, selection);
          // A newer pick has been made while this one was in flight: its
          // request owns the chip, the record and the backend from now on.
          if (modelSeqRef.current.get(key) !== seq) return;
          const current = convsRef.current.find((c) => c.key === key);
          if (!current || current.sessionId !== sessionId) return;
          modelByConvRef.current.set(key, res.model);
          selectionByConvRef.current.set(key, res.selection);
          updateConv(key, (c) => ({ ...c, model: res.model, selection: res.selection }));
          writer.persistModelLine(key, res.model);
        } catch (e) {
          // Only the newest pick rolls back; an older failure says nothing about
          // the model the session ended up on.
          if (modelSeqRef.current.get(key) !== seq) return;
          const current = convsRef.current.find((c) => c.key === key);
          if (current && current.sessionId === sessionId) {
            if (previous) selectionByConvRef.current.set(key, previous);
            else selectionByConvRef.current.delete(key);
            updateConv(key, (c) => ({ ...c, selection: previous }));
          }
          showToast(String(e).replace(/^[A-Z_]+:\s*/, ""));
        }
      };
      // Serialised per conversation: the backend applies `set_model` in arrival
      // order, so unordered requests could leave it on an earlier pick.
      const chain = (modelChainRef.current.get(key) ?? Promise.resolve()).then(swap);
      modelChainRef.current.set(key, chain);
    },
    [showToast, updateConv, writer],
  );

  // The footnote shows the model config of **this session**: a setting change
  // does not affect a session that is already open, showing the current
  // settings would lie. Before a session exists the picker offers the saved
  // default (and the choice is what its start will send).
  const activeSelection = useMemo(() => {
    const key = activeConv?.key;
    // The ref is the immediate writer (a swap is reflected before the backend
    // answers); the conv's field is the state that survives a rollback.
    const own = key ? (selectionByConvRef.current.get(key) ?? activeConv?.selection) : undefined;
    return sessionSelection(agentConfig, own, activeConv?.model);
  }, [agentConfig, activeConv?.key, activeConv?.selection, activeConv?.model]);
  const contextLimit =
    activeConv?.model?.contextWindow ??
    resolveSelection(agentConfig, activeSelection)?.model.context_window ??
    0;
  const activeUsage = activeConv?.usage ?? null;

  /** The completion popup is showing: its keys are the popup's (see composerKeys). */
  const suggestOpen = Boolean(suggestTrigger && suggestItems.length > 0);

  // The `/` picker searches skill names with the English source; the moment it
  // closes (Tab pick, Esc, deleting the slash, leaving the box) the composer
  // takes its own source back. Typing "/" by hand and the ⌘/ shortcut both
  // land here, so one rule covers both entry points.
  useEffect(() => {
    if (suggestTrigger?.kind === "skill") imeBeginSkillSearch();
    return () => imeEndSkillSearch();
  }, [suggestTrigger?.kind]);

  function onComposerChange(text: string, caret: number, docChanged: boolean) {
    // A caret move changes no trigger; only a real edit can open or close one.
    if (!docChanged) return;
    setInput(text);
    setSuggestTrigger(parseSuggestTrigger(text, caret));
    setSuggestIndex(0);
  }

  /**
   * The composer's own keys, in the capture phase of its host: the vim
   * engine's own capture sits on the editor element inside, so nothing here
   * has to reach into the engine. Everything not routed is the editor's.
   */
  function onComposerKeyDownCapture(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    const action = composerKeyAction({
      key: e.key,
      shift: e.shiftKey,
      ime: isImeEnter(e.nativeEvent, composingRef.current),
      suggestOpen,
      historyActive: historyIndexRef.current >= 0,
      empty: (composerRef.current?.text() ?? input) === "",
      // In normal/visual mode the arrows are vim's motions, not the history walk.
      edits: !vim || composerRef.current?.mode() === "insert",
    });
    if (action === "pass") return;
    e.preventDefault();
    e.stopPropagation();
    switch (action) {
      case "send":
        void send();
        return;
      case "suggest-next":
        if (suggestItems.length > 0) setSuggestIndex((i) => (i + 1) % suggestItems.length);
        return;
      case "suggest-prev":
        if (suggestItems.length > 0) {
          setSuggestIndex((i) => (i - 1 + suggestItems.length) % suggestItems.length);
        }
        return;
      case "suggest-pick": {
        const item = suggestItems[suggestIndex] ?? suggestItems[0];
        if (item) pickSuggestion(item);
        return;
      }
      case "suggest-close":
        setSuggestTrigger(null);
        return;
      case "history-up":
        historyBack();
        return;
      case "history-down":
        stepHistory(1);
        return;
    }
  }

  function onComposerPasteCapture(e: ReactClipboardEvent<HTMLDivElement>) {
    // Only a clipboard that holds images (screenshots) is taken over: when
    // there is text as well the normal paste wins, so copying text from a web
    // page is never hijacked.
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    const hasText = (e.clipboardData?.getData("text/plain") ?? "") !== "";
    if (files.length === 0 || hasText) return;
    e.preventDefault();
    e.stopPropagation();
    void addImages(files);
  }

  function onComposerBlur() {
    imeSyncToEditor();
    setSuggestTrigger(null);
  }

  return (
    <aside
      className="agent-panel"
      ref={panelRef}
      data-key-region="agent"
      style={{ "--agent-fs": String(agentFontScale) } as React.CSSProperties}
    >
      {/* Study mode has no title bar, the header is the drag area of the window; deep lets the text be dragged too,
          the buttons inside the header are let through by the drag.js of Tauri itself (see AgentHeader). */}
      <AgentHeader
        convs={convs
          // An agent's transcript is reachable from the strip, never from the
          // session switcher: the switcher lists the user's own sessions.
          .filter((c) => !c.agent)
          .map((c) => ({
            key: c.key,
            label: c.label,
            parent: c.parent,
            basedOn: c.basedOn,
          }))}
        activeKey={activeKey}
        onSelect={activateConv}
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
        parentKind={activeConv?.agent ? "agent" : "fork"}
        onBack={() => parentConv && activateConv(parentConv.key)}
        fontScale={agentFontScale}
        onFontStep={(direction) =>
          patchSettings({ agentFontScale: stepAgentFont(agentFontScale, direction) })
        }
        onFontReset={() => patchSettings({ agentFontScale: DEFAULT_AGENT_FONT })}
      />
      {activeConv && activeConv.mcpErrors.length > 0 && (
        // The reason stays visible: a bare "connection failed" left the user
        // re-checking a URL that was right (the transport dropped the session
        // id, so the server rejected every call after initialize).
        <div className="agent-mcp-warn" title={activeConv.mcpErrors.join("\n")}>
          MCP 部分服务器连接失败:{activeConv.mcpErrors[0]}
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
                  selection: activeConv.selection ?? null,
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
      <AgentTranscript
        conversationKey={activeConv?.key ?? "welcome"}
        scrollRef={scrollRef}
        entries={activeConv?.entries ?? []}
        busy={activeBusy}
        reading={readingKey !== null && readingKey === activeConv?.key}
        allowFork={!activeConv?.agent}
        onFork={forkFrom}
        editTarget={editTargetIndex}
        editingIndex={editing && editing.convKey === activeConv?.key ? editing.index : null}
        onEdit={beginEdit}
        agents={agentCards}
        onOpenAgent={activateConv}
        onStopAgent={stopAgent}
        welcome={
          activeConv?.agent ? (
            <div className="agent-welcome">
              <p className="agent-welcome-title">{activeConv.agent.label}</p>
              <p className="agent-hint">
                这是子代理自己的执行过程,完成后报告会回到主会话;按上方的「返回」回到主会话。
              </p>
            </div>
          ) : (
            <AgentWelcome mode={mode} creativeMode={creativeMode} codeProject={codeProject} />
          )
        }
      />
      {/* The session's plan, pinned above the composer; keyed by the session so
          the expand state never carries over to another conversation. */}
      {activeConv && <AgentTodos key={activeConv.key} todos={activeConv.todos} />}

      {/* Tool approval / model question (ZCode's bottom dock): a card stacked
          directly above the composer, not a centered modal. The backend turn
          is parked on the answer and the composer shows stop while busy, so
          the conversation stays readable and scrollable behind the card. */}
      {approval && (
        <AgentApprovalCard
          key={approval.id}
          approval={approval}
          onReply={(allow, feedback) => {
            const pending = approval;
            setApproval(null);
            void agentApi
              .permissionReply(pending.sessionId, pending.id, allow, feedback)
              .catch((e) => showToast(String(e).replace(/^[A-Z_]+:\s*/, "")));
          }}
        />
      )}
      {pendingQuestion && (
        <AgentQuestionCard
          key={pendingQuestion.id}
          pending={pendingQuestion}
          onSubmit={(answer) => {
            const pending = pendingQuestion;
            setPendingQuestion(null);
            void agentApi
              .questionReply(pending.sessionId, pending.id, answer)
              .catch((e) => showToast(String(e).replace(/^[A-Z_]+:\s*/, "")));
          }}
        />
      )}

      <div className="agent-composer">
        {editing && editing.convKey === activeConv?.key && (
          // ZCode's composer edit mode: the box says what it is rewriting, and
          // the only way out is the button (Esc belongs to vim/the editor).
          <div className="agent-edit-bar">
            <span className="agent-edit-bar-label">✎ 正在编辑上一条消息</span>
            <button className="agent-edit-bar-cancel" onClick={cancelEdit}>
              取消
            </button>
          </div>
        )}
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
                  onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <AgentComposer
          controller={composerRef}
          composing={composingRef}
          placeholder={
            activeConv?.agent
              ? "子代理会话只读:选中文字可复制,返回主会话继续对话"
              : mode === "code"
                ? "描述要改什么…(/ 命令、@ 文件)"
                : creativeMode
                  ? "描述要创作的内容…(输入 / 调技能、@ 引用文件,可粘贴截图)"
                  : "询问当前内容…(可直接粘贴截图)"
          }
          readOnly={Boolean(activeConv?.agent)}
          onChange={onComposerChange}
          onBlur={onComposerBlur}
          onKeyDownCapture={onComposerKeyDownCapture}
          onPasteCapture={onComposerPasteCapture}
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
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <AgentPermissionMenu
            permissionMode={permissionMode}
            planActive={planActive}
            onChange={(id) => patchSettings({ agentPermissionMode: id })}
          />
          <AgentMeta
            usage={activeUsage}
            contextLimit={contextLimit}
            modelControl={
              <ModelPicker cfg={agentConfig} selection={activeSelection} onChange={changeModel} />
            }
            // An edit is always sendable: it is what stops the running turn.
            busy={activeBusy && !(editing && editing.convKey === activeConv?.key)}
            sessionId={activeConv?.sessionId ?? null}
            canSend={Boolean(
              !activeConv?.agent &&
              activeConv?.sessionId &&
              (input.trim() !== "" || pendingImages.length > 0),
            )}
            sendTitle={
              activeConv?.agent
                ? "子代理会话只读"
                : activeConv?.sessionId
                  ? "发送(Enter)"
                  : (activeConv?.error ?? "正在连接模型…")
            }
            onSend={() => void send()}
            onStop={abort}
          />
        </div>
      </div>

      {/* The history drawer: the conversations saved under this material, clicking one restores it and continues. */}
      {historyOpen && (
        <AgentHistoryDrawer
          containerRef={historyRef}
          scopeLabel={scopeLabel}
          savedSessions={savedSessions}
          activeSessionFileId={activeConv?.sessionFileId ?? null}
          isCode={mode === "code"}
          onClose={() => setHistoryOpen(false)}
          onNew={() => {
            setHistoryOpen(false);
            setRestartNonce((n) => n + 1);
          }}
          onPick={(id) => {
            setHistoryOpen(false);
            if (id === activeConv?.sessionFileId) return;
            // Already in this family (it is in memory) → switch directly; otherwise the family is rebuilt from it, the main session hangs back as well, only the landing spot is this one.
            const existing = convs.find((c) => c.sessionFileId === id);
            if (existing) activateConv(existing.key);
            else void restoreFamily(id, savedSessions, "anchor");
          }}
        />
      )}
    </aside>
  );
}
