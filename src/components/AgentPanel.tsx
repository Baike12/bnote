import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  agentApi,
  type AgentChatItem,
  type AgentEvent,
  type MaterialInfo,
  type SavedSessionMeta,
  type StudyContent,
} from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { imeOnChineseFocus, imeSyncToEditor } from "@/editor/imeSwitch";
import { isImeEnter } from "@/lib/imeEnter";
import { StudyRightTabs } from "./StudyRightTabs";
import { forkLabel } from "@/study/agentFork";
import { ensureMaterial, sessionFilePath } from "@/study/materials";
import {
  historyFromTranscript,
  parseTranscript,
  serializeTranscript,
  type TranscriptLine,
} from "@/study/transcript";
import { isWereadUrl } from "@/study/weread";
import { renderAgentMarkdown } from "@/study/agentMarkdown";
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
}

interface Turn {
  /** Streaming text buffer for the current assistant reply. */
  text: string;
  /** 流式思考过程(纯文本;不进会话历史,只用于展示)。 */
  thinking: string;
  /** 首个 thinking delta 的时间戳(计时用)。 */
  thinkingStart: number | null;
  /** 思考耗时(秒,turn 结束时算好冻结)。 */
  thinkSeconds: number | null;
  tools: ToolRecord[];
  error?: string;
}

interface ChatEntry {
  role: "user" | "assistant";
  text: string;
  /** 写入会话记录用的时间戳。 */
  at: number;
  /** 用户消息带的截图/图片(仅展示;模型侧以后端会话历史为准)。 */
  images?: AgentImage[];
  turn?: Turn;
  /**
   * 后端会话历史里「到本条为止」的前缀条数(含本条)。user = 前一条 + 1;
   * assistant = turn_end / error 事件携带的后端权威计数(见 agentFork.ts)。
   * null = 还未知(出错且拿不到计数)。
   */
  items: number | null;
}

/** 面板内的一条会话:主会话,或从某条消息分叉出的辅助会话。 */
interface Conv {
  key: string;
  sessionId: string | null;
  entries: ChatEntry[];
  label: string;
  /** 分叉来源会话;主会话为 null。 */
  parent: string | null;
  /** 辅助会话的摘要(来源消息首行)。 */
  basedOn: string;
  /**
   * 会话级错误(启动失败 / 发送失败)。持久显示在对话区顶部(照 ZCode 的
   * ChatErrorBanner),直到用户重试或关闭——不再只弹几秒消失的 toast:
   * 用户看到的「发送没有回应」绝大多数就是这种被 toast 吞掉的失败。
   */
  error?: string;
  /** 错误来源:决定「重试」按钮做什么。 */
  errorKind?: "start" | "send";
  /** 启动时后端报告的 MCP 连接失败(空数组 = 全部正常)。 */
  mcpErrors: string[];
  /**
   * 会话记录文件(`<材料目录>/sessions/<id>.jsonl`)。null = 还没有 id
   * (刚启动/启动失败)或浏览器里没有落盘能力。
   */
  transcriptPath: string | null;
  /** 文件名里的会话 id(历史抽屉里高亮当前项)。 */
  sessionFileId: string | null;
  /** 最近一次模型请求的 token 用量(上下文占用 = input + output)。 */
  usage: AgentUsage | null;
}

/** Identity of the material a session is pinned to (url re-open = same key). */
function studyContentKey(content: StudyContent | null): string {
  if (!content) return "none";
  return content.kind === "pdf" ? `pdf:${content.path}` : `url:${content.url}`;
}

function findConvBySession(convs: Conv[], sessionId: string): Conv | undefined {
  return convs.find((c) => c.sessionId === sessionId);
}

let convSeq = 0;
function nextConvKey(): string {
  convSeq += 1;
  return `c${convSeq}`;
}

/** 思考摘要吸底判定距离(ZCode reasoning 同值:离底 2px 内算贴底)。 */
const THINKING_BOTTOM_LOCK_PX = 2;

/** 摘要行:最后一行非空文本(ZCode resolveReasoningStreamingSummary 同逻辑)。 */
export function thinkingSummaryLine(thinking: string): string {
  const lines = thinking.replace(/\r\n?/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = lines[i]?.trim() ?? "";
    if (text) return text;
  }
  return "";
}

/**
 * 思考过程折叠块,行为照搬 ZCode 的 Reasoning(vercel/ai-elements 改造版):
 * 流式时收起,摘要行显示最后一行思考文本并向末尾滚动;完成后标签变
 * 「思考 · 持续了 N 秒」。内容按纯文本展示(不做 markdown 渲染——思考
 * 流式追加,每个 delta 重跑 markdown 解析在长思考下会卡),展开态限高内
 * 滚、默认吸底跟随,用户滚离底部后暂停、滚回底部恢复。
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

  // 流式追加:展开时吸底;收起时把单行摘要视口推到末尾(旧内容左移)。
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

  // 输出边界收起(ZCode autoCollapseKey):turn 结束时若用户没手动展开过,
  // 折叠块回到收起态。用户点开过(interacted)则尊重选择。
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

/** 会话记录行 → 界面消息(恢复会话时用)。 */
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

/** 界面消息 → 会话记录行(分叉时把父会话前缀写进新文件)。 */
function entriesToLines(entries: ChatEntry[]): TranscriptLine[] {
  return entries.map((e): TranscriptLine =>
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

/** 历史会话列表里的时间:今天显示时分,更早显示月/日。 */
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
 * 学习模式右栏「学习助手」页签:围绕当前内容问答。
 *
 * 会话模型:主会话(跟随当前 PDF/网页,内容或配置一变就重开)+ 若干辅助
 * 会话(从任意一条消息「⤷」分叉,后端复制历史前缀,原会话不动)。页签头部
 * 的下拉与 ⌘⇧Y 在会话间切换。
 *
 * 事件按 sessionId 路由:后台会话(非当前显示)的流式回复照常写入各自的
 * entries,切回去时是完整的。
 *
 * 只在页签激活时才建会话:用户只在笔记页签里连续翻 PDF 时,不为每次翻页
 * 连接模型/MCP。
 */
export function AgentPanel() {
  const studyContent = useAppStore((s) => s.studyContent);
  const agentConfigVersion = useAppStore((s) => s.agentConfigVersion);
  const rightTab = useAppStore((s) => s.settings.studyRightTab);
  const agentSwitchSignal = useAppStore((s) => s.agentSwitchSessionSignal);
  const showToast = useAppStore((s) => s.showToast);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [input, setInput] = useState("");
  /** 待发送的图片(粘贴截图 / 文件选择),随消息一起进后端会话历史。 */
  const [pendingImages, setPendingImages] = useState<AgentImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 输入法组词会话(compositionstart/end 记账):Enter 确认候选时不能发送。 */
  const composingRef = useRef(false);
  const [starting, setStarting] = useState(false);
  const [busySession, setBusySession] = useState<string | null>(null);
  /** 已保存的 Agent 配置(模型 / 上下文窗口);会话没建好时脚注也能显示。 */
  const [agentConfig, setAgentConfig] = useState<{ model: string; contextWindow: number } | null>(
    null,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const convsRef = useRef<Conv[]>([]);
  const turnsRef = useRef<Map<string, Turn>>(new Map());
  const busyRef = useRef<string | null>(null);
  /** 已为哪份内容+配置建过主会话(页签未激活时不建)。 */
  const startedKeyRef = useRef<string | null>(null);
  /** 会话启动请求序号:过期回调(内容/配置已变)直接放弃,不盲写。 */
  const startTokenRef = useRef(0);
  /** ⌘⇧Y 的「重新开始主会话」按钮共用同一条启动路径。 */
  const [restartNonce, setRestartNonce] = useState(0);
  /** 本材料的落盘目录(批注 + 会话记录)与保存过的会话列表。 */
  const studyWereadBook = useAppStore((s) => s.studyWereadBook);
  const [materialInfo, setMaterialInfo] = useState<MaterialInfo | null>(null);
  const [savedSessions, setSavedSessions] = useState<SavedSessionMeta[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const materialRef = useRef<{ identity: string; info: MaterialInfo | null } | null>(null);
  /** convKey → 会话记录文件。启动成功/恢复时写入,每轮结束追加。 */
  const transcriptRef = useRef<Map<string, string>>(new Map());
  /** sessionId → { convKey, 记录文件 }:会话切走后(换材料)收尾事件仍要落盘。 */
  const sessionIndexRef = useRef<Map<string, { convKey: string; path: string | null }>>(
    new Map(),
  );
  /** 每轮用户消息先记在这里,和助手回复一起落盘(发送失败就不落)。 */
  const pendingUserRef = useRef<Map<string, TranscriptLine>>(new Map());
  /** 重启键(配置保存 / ⟳):变了就开新会话,而不是恢复最近一条。 */
  const restartKeyRef = useRef<string | null>(null);

  useEffect(() => {
    convsRef.current = convs;
  }, [convs]);

  // 脚注的模型名与上下文窗口来自已保存配置(会话用的就是它)。读取期间配置
  // 又变了一次(保存设置会 bump version)时,旧结果直接丢弃。
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
   * 归属用的材料内容:微信读书的 studyContent 停在中栏入口(书架),真正
   * 在读的书只有页内路由知道——按书归属,不要把所有书的会话混在书架上。
   */
  const materialContent = useMemo<StudyContent | null>(() => {
    if (!studyContent) return null;
    if (studyContent.kind !== "url" || !isWereadUrl(studyContent.url)) return studyContent;
    return studyWereadBook
      ? { kind: "url", url: studyWereadBook.url, title: studyWereadBook.title }
      : studyContent;
  }, [studyContent, studyWereadBook]);

  const activeConv = convs.find((c) => c.key === activeKey) ?? null;
  // sessionId 必须非空才算「生成中」:会话还没建好(或启动失败)时 sessionId
  // 与 busySession 都是 null,相等但不能当成正在流式回复。
  const activeBusy =
    activeConv?.sessionId != null && busySession === activeConv.sessionId;

  const updateConv = useCallback((key: string, patch: (c: Conv) => Conv) => {
    setConvs((prev) => prev.map((c) => (c.key === key ? patch(c) : c)));
  }, []);

  /** 重新拉一遍本材料的会话列表(历史抽屉 + 恢复最近一条)。 */
  const refreshSessions = useCallback(async (): Promise<SavedSessionMeta[]> => {
    const material = materialRef.current;
    if (!material?.info) {
      setSavedSessions([]);
      return [];
    }
    const list = await agentApi.sessionsList(material.info.relDir).catch(() => []);
    // 读盘期间换了材料:结果属于上一份材料,不能写进当前列表。
    if (materialRef.current !== material) return list;
    setSavedSessions(list);
    return list;
  }, []);

  const startSession = useCallback(
    async (
      convKey: string,
      content: StudyContent | null,
      opts?: {
        /** 恢复:还原出的模型侧历史。 */
        history?: AgentChatItem[];
        /** 恢复:继续写这个文件;不传则按新会话建文件。 */
        transcriptPath?: string | null;
        /** 分叉:先把父会话的前缀写进新文件。 */
        seedLines?: TranscriptLine[];
      },
    ) => {
      const token = ++startTokenRef.current;
      setStarting(true);
      updateConv(convKey, (c) => ({ ...c, error: undefined, errorKind: undefined }));
      try {
        const info = await agentApi.startSession(content, undefined, opts?.history);
        // 过期就放弃:期间内容/配置又变了,新一轮启动已经接管。
        if (startTokenRef.current !== token) return;
        // 会话记录路径:恢复用旧文件,新会话用「材料目录 + 后端会话 id」。
        const vault = useAppStore.getState().vaultPath;
        const relDir = materialRef.current?.info?.relDir ?? null;
        const transcriptPath =
          opts?.transcriptPath ??
          (vault && relDir ? sessionFilePath(vault, relDir, info.sessionId) : null);
        const fileName = transcriptPath?.split("/").pop() ?? null;
        const sessionFileId = fileName ? fileName.replace(/\.jsonl$/, "") : null;
        if (transcriptPath) transcriptRef.current.set(convKey, transcriptPath);
        sessionIndexRef.current.set(info.sessionId, { convKey, path: transcriptPath });
        if (transcriptPath && opts?.seedLines && opts.seedLines.length > 0) {
          // 新文件(新会话 id)不存在旧内容,直接写入前缀即可。
          await api
            .writeFile(transcriptPath, serializeTranscript(opts.seedLines))
            .catch((e) => console.warn("[agent] 写分叉前缀失败", e));
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
   * 打开一条保存过的会话:读回记录 → 还原界面消息与模型历史 → 继续对话。
   * 会话记录是唯一来源,后端只是带着历史重新开一条 live 会话。
   */
  const openSavedSession = useCallback(
    async (meta: SavedSessionMeta) => {
      const info = materialRef.current?.info;
      const vault = useAppStore.getState().vaultPath;
      if (!info || !vault) return;
      setHistoryOpen(false);
      const path = sessionFilePath(vault, info.relDir, meta.id);
      const raw = await api.readFile(path).catch(() => null);
      const lines = parseTranscript(raw);
      if (lines.length === 0) {
        showToast("这条会话记录是空的");
        return;
      }
      const conv: Conv = {
        key: nextConvKey(),
        sessionId: null,
        entries: lines.map(entryFromLine),
        label: meta.title,
        parent: null,
        basedOn: "",
        mcpErrors: [],
        transcriptPath: path,
        sessionFileId: meta.id,
        usage: null,
      };
      transcriptRef.current.set(conv.key, path);
      setConvs([conv]);
      setActiveKey(conv.key);
      turnsRef.current.clear();
      void startSession(conv.key, materialContent, {
        history: historyFromTranscript(lines),
        transcriptPath: path,
      });
    },
    [materialContent, showToast, startSession],
  );

  // 主会话生命周期:页签激活后,材料/配置/重启任一变化都重建会话。
  // - 换材料:恢复这份材料最近一条会话(没有才开新的);
  // - 保存配置 / 点 ⟳:强制开一条新会话(旧会话留在历史里);
  // - 页签切走再切回:内容没变就复用活会话。
  useEffect(() => {
    if (rightTab !== "agent") return;
    const identity = studyContentKey(materialContent);
    const key = `${identity}|${agentConfigVersion}|${restartNonce}`;
    if (startedKeyRef.current === key) return;
    startedKeyRef.current = key;

    const restartKey = `${agentConfigVersion}|${restartNonce}`;
    const forcedNew = restartKeyRef.current !== null && restartKeyRef.current !== restartKey;
    restartKeyRef.current = restartKey;

    const token = ++startTokenRef.current;
    void (async () => {
      const vault = useAppStore.getState().vaultPath;
      const info =
        vault && materialContent ? await ensureMaterial(vault, materialContent) : null;
      if (startTokenRef.current !== token) return;
      materialRef.current = { identity, info };
      setMaterialInfo(info);
      const sessions = info
        ? await agentApi.sessionsList(info.relDir).catch(() => [])
        : [];
      if (startTokenRef.current !== token) return;
      setSavedSessions(sessions);

      if (!forcedNew && sessions.length > 0) {
        await openSavedSession(sessions[0]);
        return;
      }
      const conv: Conv = {
        key: nextConvKey(),
        sessionId: null,
        entries: [],
        label: "主会话",
        parent: null,
        basedOn: "",
        mcpErrors: [],
        transcriptPath: null,
        sessionFileId: null,
        usage: null,
      };
      setConvs([conv]);
      setActiveKey(conv.key);
      turnsRef.current.clear();
      void startSession(conv.key, materialContent);
    })();
  }, [
    materialContent,
    agentConfigVersion,
    rightTab,
    restartNonce,
    startSession,
    openSavedSession,
  ]);

  // ⌘⇧Y / 命令:主会话 ↔ 最近一条辅助会话 来回切换。
  useEffect(() => {
    if (agentSwitchSignal === 0) return;
    const list = convsRef.current;
    if (list.length < 2) {
      showToast("还没有辅助会话:悬停消息点「⤷」创建");
      return;
    }
    setActiveKey((prevKey) => {
      const cur = list.find((c) => c.key === prevKey);
      if (cur?.parent) {
        const parent = list.find((c) => c.key === cur.parent);
        return parent ? parent.key : list[0].key;
      }
      return list[list.length - 1].key;
    });
  }, [agentSwitchSignal, showToast]);

  // 切换会话后滚到底(每条会话都从最新消息看起)。
  useEffect(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    });
  }, [activeKey]);

  function ensureTurn(convKey: string): Turn {
    let turn = turnsRef.current.get(convKey);
    if (!turn) {
      turn = { text: "", thinking: "", thinkingStart: null, thinkSeconds: null, tools: [] };
      turnsRef.current.set(convKey, turn);
    }
    return turn;
  }

  /** 把流式草稿(final 与否同形)写进会话;draft 复用同一个 turn 引用。 */
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
   * 把这一轮写进会话记录:用户消息 + 助手回复一起追加(同一条 append,
   * 顺序固定;发送失败时用户消息根本没进过文件)。写失败只记日志,不影响
   * 对话——落盘是记录,不是发送的前置条件。
   */
  function persistTurn(convKey: string, turn: Turn, pathOverride?: string) {
    const path = pathOverride ?? transcriptRef.current.get(convKey);
    if (!path) return;
    const user = pendingUserRef.current.get(convKey);
    pendingUserRef.current.delete(convKey);
    const lines: TranscriptLine[] = [];
    if (user) lines.push(user);
    lines.push({
      type: "assistant",
      at: Date.now(),
      text: turn.text,
      thinking: turn.thinking,
      thinkSeconds: turn.thinkSeconds,
      tools: turn.tools,
      error: turn.error,
    });
    void api
      .appendFile(path, serializeTranscript(lines))
      .then(() => refreshSessions())
      .catch((e) => console.warn("[agent] 写会话记录失败", e));
  }

  function handleAgentEvent(sessionId: string, event: AgentEvent) {
    const conv = findConvBySession(convsRef.current, sessionId);
    if (!conv) {
      // 会话已经不在列表里(换材料/重启后旧会话作废):流式增量无害丢弃,
      // 但**终止事件必须清忙碌标记**——否则面板永远停在「生成中」,下一次
      // 发送会被 busyRef 静默吃掉。这一轮已经生成的内容仍然写进它自己的
      // 会话记录:用户只是切走了材料,答案不该丢。
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
          t.id === event.id ? { ...t, output: event.output, ok: event.ok } : t,
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
      case "turn_end": {
        commitTurn(conv.key, event.items);
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
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen<{ sessionId: string; event: AgentEvent }>("agent-event", (event) => {
      handleAgentEvent(event.payload.sessionId, event.payload.event);
    }).then((un) => {
      off = un;
    });
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 附件进队(粘贴与文件选择共用):超限拒绝并说明,失败 toast 不中断。 */
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

  async function send() {
    const text = input.trim();
    const conv = activeConv;
    if (!conv || (!text && pendingImages.length === 0)) return;
    const info = conv.sessionId;
    if (!info) {
      // 会话还没建好:同样写进持久错误横幅,不只是一闪而过的 toast。
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
    // 用户消息先挂在这轮上,和助手回复一起落盘;发送失败直接丢掉。
    pendingUserRef.current.set(conv.key, {
      type: "user",
      at,
      text,
      images: images.length > 0 ? images : undefined,
    });
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
      // 后端没收到这一轮:把刚插进 UI 的幽灵消息撤回,内容放回输入框,并把
      // 原因留在会话错误横幅上。否则界面里挂着一条永远不会被回答的消息。
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
   * 从第 index 条消息分叉一条辅助会话:复制前缀历史,原会话不动。
   * 分叉出来的会话有自己的记录文件(前缀先写进去),关掉再开也能继续。
   */
  function forkFrom(index: number) {
    const src = activeConv;
    if (!src) return;
    if (!src.sessionId) {
      showToast("会话未就绪,不能分叉");
      return;
    }
    const origin = src.entries[index];
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
      mcpErrors: [],
      transcriptPath: null,
      sessionFileId: null,
      usage: null,
    };
    setConvs((prev) => [...prev, conv]);
    setActiveKey(conv.key);
    void startSession(conv.key, materialContent, {
      history: historyFromTranscript(seedLines),
      seedLines,
    });
  }

  const parentConv = activeConv?.parent
    ? (convs.find((c) => c.key === activeConv.parent) ?? null)
    : null;
  const modelName = agentConfig?.model.trim() ?? "";
  const contextLimit = agentConfig?.contextWindow ?? 0;
  const activeUsage = activeConv?.usage ?? null;
  const usagePct = occupancyPercent(activeUsage, contextLimit);

  return (
    <aside className="agent-panel">
      {/* 学习模式没有标题栏,头部即窗口拖动区;deep 让文字也能拖,
          头部里的按钮由 Tauri 的 drag.js 自行放行。 */}
      <div className="agent-header" data-tauri-drag-region="deep">
        <StudyRightTabs />
        {convs.length > 1 ? (
          <select
            className="agent-conv-select"
            value={activeKey ?? ""}
            title="切换会话(⌘⇧Y)"
            onChange={(e) => setActiveKey(e.target.value)}
          >
            {convs.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="agent-conv-label" title={activeConv?.label}>
            {activeConv?.label ?? "主会话"}
          </span>
        )}
        <span className="spacer" />
        <button
          className={`icon-btn${historyOpen ? " is-active" : ""}`}
          title="历史会话(这份材料保存过的对话)"
          aria-pressed={historyOpen}
          onClick={() => setHistoryOpen((v) => !v)}
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
            <path d="M12 8v4l3 2" />
          </svg>
        </button>
        <button
          className="icon-btn"
          title="新会话(重读 .bnote/agent.md 与配置)"
          onClick={() => {
            setHistoryOpen(false);
            setRestartNonce((n) => n + 1);
          }}
        >
          ⟳
        </button>
      </div>
      {parentConv && (
        <div className="agent-aux-bar">
          <span className="agent-aux-badge">辅助会话</span>
          <span className="agent-aux-based" title={activeConv?.basedOn}>
            基于「{activeConv?.basedOn}」
          </span>
          <button
            className="btn btn-ghost agent-aux-back"
            title="返回上一条会话(⌘⇧Y)"
            onClick={() => parentConv && setActiveKey(parentConv.key)}
          >
            ← {parentConv.label}
          </button>
        </div>
      )}
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
            <p className="agent-welcome-title">问我关于当前 PDF / 网页的问题</p>
            <div className="agent-chips">
              {["总结这篇材料的核心方法", "这篇在解决什么问题?", "帮我梳理知识框架"].map((q) => (
                <button key={q} className="agent-chip" onClick={() => setInput(q)}>
                  {q}
                </button>
              ))}
            </div>
            <p className="agent-hint">悬停任意消息点「⤷」,可以从那里分叉一条辅助会话</p>
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
                {entry.role === "user" ? (
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
                      </details>
                    ))}
                    {entry.turn?.error && (
                      <div className="agent-error">{entry.turn.error}</div>
                    )}
                    <div
                      className="agent-md"
                      dangerouslySetInnerHTML={{ __html: renderAgentMarkdown(entry.text) }}
                    />
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
      <div className="agent-composer">
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
          className="agent-input"
          placeholder="询问当前内容…(可直接粘贴截图)"
          value={input}
          rows={2}
          data-ime-chinese="true"
          onFocus={() => imeOnChineseFocus()}
          onBlur={() => imeSyncToEditor()}
          onChange={(e) => setInput(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onPaste={(e) => {
            // 剪贴板里只有图片(截图)才接管:同时有文本时按普通粘贴走,
            // 不抢用户复制网页文字的场景。
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
            if (e.key !== "Enter" || e.shiftKey) return;
            // 输入法的确认键(中文模式下敲英文字母后回车)不能当发送:
            // 放行给 IME 把字母填进输入框。
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
          <span className="agent-meta" title={usageTitle(activeUsage, contextLimit, modelName)}>
            <span className="agent-meta-model">{modelName || "未配置模型"}</span>
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
      {/* 历史会话抽屉:这份材料下保存过的对话,点一条即恢复并继续。 */}
      {historyOpen && (
        <div className="agent-history" role="dialog" aria-label="历史会话">
          <div className="agent-history-head">
            <div className="agent-history-heading">
              <span className="agent-history-heading-title">历史会话</span>
              <span className="agent-history-heading-sub" title={materialInfo?.relDir}>
                {materialInfo?.title || "本材料"}
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
            <p className="agent-history-empty">这份材料还没有保存过会话</p>
          ) : (
            <ul className="agent-history-list">
              {savedSessions.map((s) => (
                <li key={s.id}>
                  <button
                    className={`agent-history-item${
                      s.id === activeConv?.sessionFileId ? " is-active" : ""
                    }`}
                    title={s.title}
                    onClick={() => void openSavedSession(s)}
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
