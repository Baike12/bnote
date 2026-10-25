import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  agentApi,
  type AgentEvent,
  type AgentForkSpec,
  type StudyContent,
} from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { StudyRightTabs } from "./StudyRightTabs";
import { forkCutoff, forkLabel } from "@/study/agentFork";
import { renderAgentMarkdown } from "@/study/agentMarkdown";
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
  tools: ToolRecord[];
  error?: string;
}

interface ChatEntry {
  role: "user" | "assistant";
  text: string;
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
  /** 会话启动失败的可见原因。 */
  error?: string;
  /** 启动时后端报告的 MCP 连接失败(空数组 = 全部正常)。 */
  mcpErrors: string[];
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

function cloneEntry(e: ChatEntry): ChatEntry {
  return {
    ...e,
    images: e.images?.map((img) => ({ ...img })),
    turn: e.turn ? { ...e.turn, tools: e.turn.tools.map((t) => ({ ...t })) } : undefined,
  };
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
  const [starting, setStarting] = useState(false);
  const [busySession, setBusySession] = useState<string | null>(null);
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

  useEffect(() => {
    convsRef.current = convs;
  }, [convs]);

  const activeConv = convs.find((c) => c.key === activeKey) ?? null;
  // sessionId 必须非空才算「生成中」:会话还没建好(或启动失败)时 sessionId
  // 与 busySession 都是 null,相等但不能当成正在流式回复。
  const activeBusy =
    activeConv?.sessionId != null && busySession === activeConv.sessionId;

  const updateConv = useCallback((key: string, patch: (c: Conv) => Conv) => {
    setConvs((prev) => prev.map((c) => (c.key === key ? patch(c) : c)));
  }, []);

  const startSession = useCallback(
    async (convKey: string, content: StudyContent | null, fork?: AgentForkSpec) => {
      const token = ++startTokenRef.current;
      setStarting(true);
      updateConv(convKey, (c) => ({ ...c, error: undefined }));
      try {
        const info = await agentApi.startSession(content, fork);
        // 过期就放弃:期间内容/配置又变了,新一轮启动已经接管。
        if (startTokenRef.current !== token) return;
        setConvs((prev) =>
          prev.map((c) =>
            c.key === convKey
              ? { ...c, sessionId: info.sessionId, mcpErrors: info.mcpErrors }
              : c,
          ),
        );
      } catch (e) {
        if (startTokenRef.current !== token) return;
        const msg = String(e).replace(/^[A-Z_]+:\s*/, "");
        updateConv(convKey, (c) => ({ ...c, error: msg }));
        showToast(msg);
      } finally {
        if (startTokenRef.current === token) setStarting(false);
      }
    },
    [showToast, updateConv],
  );

  // 主会话生命周期:页签激活后,内容/配置/重启任一变化都开一条全新主会话
  // (辅助会话随之作废)。页签不活跃时不建会话,也不重置已建记录——切回来
  // 内容没变就复用活会话。
  useEffect(() => {
    if (rightTab !== "agent") return;
    const key = `${studyContentKey(studyContent)}|${agentConfigVersion}|${restartNonce}`;
    if (startedKeyRef.current === key) return;
    startedKeyRef.current = key;
    const conv: Conv = {
      key: nextConvKey(),
      sessionId: null,
      entries: [],
      label: "主会话",
      parent: null,
      basedOn: "",
      mcpErrors: [],
    };
    setConvs([conv]);
    setActiveKey(conv.key);
    turnsRef.current.clear();
    void startSession(conv.key, studyContent);
  }, [studyContent, agentConfigVersion, rightTab, restartNonce, startSession]);

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
      turn = { text: "", tools: [] };
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
    turnsRef.current.delete(convKey);
    writeEntries(convKey, turn, true, items);
  }

  function handleAgentEvent(sessionId: string, event: AgentEvent) {
    const conv = findConvBySession(convsRef.current, sessionId);
    if (!conv) return;
    switch (event.type) {
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
                items: event.items > 0 ? event.items : null,
                turn: { text: "", tools: [], error: event.message },
              },
            ],
          }));
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
      // Never drop the message silently: tell the user why nothing happened.
      showToast(
        conv.error
          ? `会话未就绪:${conv.error}`
          : "会话未就绪,请稍候重试或重新开始会话",
      );
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
    updateConv(conv.key, (c) => ({
      ...c,
      entries: [
        ...c.entries,
        { role: "user", text, images: images.length > 0 ? images : undefined, items },
      ],
    }));
    try {
      await agentApi.send(info, text, images);
    } catch (e) {
      busyRef.current = null;
      setBusySession(null);
      showToast(String(e).replace(/^[A-Z_]+:\s*/, ""));
    }
  }

  function abort() {
    const info = activeConv?.sessionId;
    if (info) void agentApi.abort(info);
  }

  /** 从第 index 条消息分叉一条辅助会话:复制前缀历史,原会话不动。 */
  function forkFrom(index: number) {
    const src = activeConv;
    if (!src) return;
    if (!src.sessionId) {
      showToast("会话未就绪,不能分叉");
      return;
    }
    const cutoff = forkCutoff(src.entries, index);
    const origin = src.entries[index];
    const label = origin.text.trim() || (origin.images?.length ? "[图片]" : "");
    const conv: Conv = {
      key: nextConvKey(),
      sessionId: null,
      entries: src.entries.slice(0, index + 1).map(cloneEntry),
      label: `↳ ${forkLabel(label)}`,
      parent: src.key,
      basedOn: forkLabel(label, 40),
      mcpErrors: [],
    };
    setConvs((prev) => [...prev, conv]);
    setActiveKey(conv.key);
    void startSession(conv.key, studyContent, { from: src.sessionId, items: cutoff });
  }

  const parentConv = activeConv?.parent
    ? (convs.find((c) => c.key === activeConv.parent) ?? null)
    : null;

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
          <span className="agent-conv-label">主会话</span>
        )}
        <span className="spacer" />
        <button
          className="icon-btn"
          title="重新开始主会话(重读 .bnote/agent.md 与配置)"
          onClick={() => setRestartNonce((n) => n + 1)}
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
        <div className="agent-status fail">
          <span className="agent-status-text" title={activeConv.error}>
            会话未就绪:{activeConv.error}
          </span>
          <button
            className="btn btn-ghost agent-status-retry"
            onClick={() => void startSession(activeConv.key, studyContent)}
          >
            重试
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
          onChange={(e) => setInput(e.target.value)}
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
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
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
          <span className="agent-composer-hint">Enter 发送 · Shift+Enter 换行 · 可粘贴截图</span>
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
    </aside>
  );
}
