import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import katex from "katex";
import {
  agentApi,
  type AgentEvent,
  type SessionInfo,
  type StudyContent,
} from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";

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
  turn?: Turn;
}

/**
 * Study-mode left column: chat with the agent about the current content.
 * Events stream over the `agent-event` Tauri channel.
 */
export function AgentPanel() {
  const studyContent = useAppStore((s) => s.studyContent);
  const agentConfigVersion = useAppStore((s) => s.agentConfigVersion);
  const showToast = useAppStore((s) => s.showToast);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SessionInfo | null>(null);
  const turnRef = useRef<Turn | null>(null);
  const busyRef = useRef(false);

  const startSession = useCallback(
    async (content: StudyContent | null) => {
      setStarting(true);
      setSessionError(null);
      try {
        const info = await agentApi.startSession(content);
        sessionRef.current = info;
        setSession(info);
        setEntries([]);
        turnRef.current = null;
      } catch (e) {
        // Keep the failure on screen: without it the send button looks alive
        // but does nothing (no session ⇒ send() used to return silently).
        sessionRef.current = null;
        setSession(null);
        setSessionError(String(e).replace(/^[A-Z_]+:\s*/, ""));
        showToast(String(e).replace(/^[A-Z_]+:\s*/, ""));
      } finally {
        setStarting(false);
      }
    },
    [showToast],
  );

  // (Re)open the session when the study content changes, or after the agent
  // config is saved (a session pins the provider it was created with).
  useEffect(() => {
    void startSession(studyContent);
  }, [studyContent, agentConfigVersion, startSession]);

  // Stream events; append into the live turn.
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen<{ sessionId: string; event: AgentEvent }>("agent-event", (event) => {
      const info = sessionRef.current;
      if (!info || event.payload.sessionId !== info.sessionId) return;
      handleAgentEvent(event.payload.event);
    }).then((un) => {
      off = un;
    });
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function ensureTurn(): Turn {
    if (!turnRef.current) {
      turnRef.current = { text: "", tools: [] };
    }
    return turnRef.current;
  }

  /** Finalizes the streaming turn: the draft entry is replaced in place (it
   *  used to be appended a second time, so every reply showed up twice). */
  function commitTurn() {
    const turn = turnRef.current;
    if (!turn) return;
    turnRef.current = null;
    setEntries((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      const done: ChatEntry = { role: "assistant", text: turn.text, turn };
      if (last && last.role === "assistant" && last.turn === turn) {
        next[next.length - 1] = done;
      } else {
        next.push(done);
      }
      return next;
    });
  }

  function handleAgentEvent(event: AgentEvent) {
    switch (event.type) {
      case "text_delta": {
        const turn = ensureTurn();
        turn.text += event.text;
        setEntries((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          const draft: ChatEntry = {
            role: "assistant",
            text: turn.text,
            turn,
          };
          if (last && last.role === "assistant" && last.turn === turn) {
            next[next.length - 1] = draft;
          } else {
            next.push(draft);
          }
          return next;
        });
        break;
      }
      case "tool_start": {
        const turn = ensureTurn();
        turn.tools = [
          ...turn.tools,
          { id: event.id, name: event.name, input: event.input },
        ];
        setEntries((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          const draft: ChatEntry = { role: "assistant", text: turn.text, turn };
          if (last && last.role === "assistant" && last.turn === turn) {
            next[next.length - 1] = draft;
          } else {
            next.push(draft);
          }
          return next;
        });
        break;
      }
      case "tool_end": {
        const turn = turnRef.current;
        if (!turn) break;
        turn.tools = turn.tools.map((t) =>
          t.id === event.id ? { ...t, output: event.output, ok: event.ok } : t,
        );
        setEntries((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.role === "assistant" && last.turn === turn) {
            next[next.length - 1] = { role: "assistant", text: turn.text, turn };
          }
          return next;
        });
        break;
      }
      case "turn_end": {
        commitTurn();
        busyRef.current = false;
        setBusy(false);
        break;
      }
      case "error": {
        const turn = turnRef.current;
        if (turn) {
          turn.error = event.message;
          commitTurn();
        } else {
          setEntries((prev) => [
            ...prev,
            {
              role: "assistant",
              text: "",
              turn: { text: "", tools: [], error: event.message },
            },
          ]);
        }
        busyRef.current = false;
        setBusy(false);
        break;
      }
    }
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    });
  }

  async function send() {
    const text = input.trim();
    if (!text || busyRef.current) return;
    const info = sessionRef.current;
    if (!info) {
      // Never drop the message silently: tell the user why nothing happened.
      showToast(
        sessionError
          ? `会话未就绪:${sessionError}`
          : "会话未就绪,请稍候重试或重新开始会话",
      );
      return;
    }
    setInput("");
    busyRef.current = true;
    setBusy(true);
    setEntries((prev) => [...prev, { role: "user", text }]);
    try {
      await agentApi.send(info.sessionId, text);
    } catch (e) {
      busyRef.current = false;
      setBusy(false);
      showToast(String(e).replace(/^[A-Z_]+:\s*/, ""));
    }
  }

  function abort() {
    const info = sessionRef.current;
    if (info) void agentApi.abort(info.sessionId);
  }

  const rendered = useMemo(
    () => (text: string) => renderAgentMarkdown(text),
    [],
  );

  return (
    <aside className="agent-panel">
      {/* 学习模式没有标题栏,头部即窗口拖动区;deep 让标题文字也能拖,
          头部里的按钮由 Tauri 的 drag.js 自行放行。 */}
      <div className="agent-header" data-tauri-drag-region="deep">
        <span className="agent-title">学习助手</span>
        <span className="spacer" />
        <button
          className="icon-btn"
          title="重新开始会话"
          onClick={() => void startSession(studyContent)}
        >
          ⟳
        </button>
      </div>
      {session && session.mcpErrors.length > 0 && (
        <div className="agent-mcp-warn" title={session.mcpErrors.join("\n")}>
          MCP 部分服务器连接失败
        </div>
      )}
      {starting && <div className="agent-status">正在连接模型…</div>}
      {!starting && sessionError && (
        <div className="agent-status fail">
          <span className="agent-status-text" title={sessionError}>
            会话未就绪:{sessionError}
          </span>
          <button
            className="btn btn-ghost agent-status-retry"
            onClick={() => void startSession(studyContent)}
          >
            重试
          </button>
        </div>
      )}
      <div className="agent-scroll" ref={scrollRef}>
        {entries.length === 0 && (
          <div className="agent-welcome">
            <p>问我关于当前内容的问题。</p>
            <p className="agent-hint">
              例如:「总结这篇论文的核心方法」「第 3 节的公式在讲什么?」「把要点整理进我的笔记」。
            </p>
          </div>
        )}
        {entries.map((entry, i) =>
          entry.role === "user" ? (
            <div className="agent-msg agent-msg-user" key={i}>
              {entry.text}
            </div>
          ) : (
            <div className="agent-msg agent-msg-assistant" key={i}>
              {entry.turn?.tools.map((tool) => (
                <details className="agent-tool" key={tool.id}>
                  <summary className={tool.ok === false ? "fail" : ""}>
                    {tool.ok === undefined ? "⏳" : tool.ok ? "🔧" : "⚠️"}{" "}
                    {tool.name}
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
                dangerouslySetInnerHTML={{ __html: rendered(entry.text) }}
              />
            </div>
          ),
        )}
      </div>
      <div className="agent-input-row">
        <textarea
          className="agent-input"
          placeholder="询问当前内容…(Enter 发送,Shift+Enter 换行)"
          value={input}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <button className="btn agent-send" onClick={abort}>
            停止
          </button>
        ) : (
          <button
            className="btn agent-send"
            onClick={() => void send()}
            disabled={!session}
            title={session ? "发送(Enter)" : sessionError ?? "正在连接模型…"}
          >
            发送
          </button>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Mini markdown renderer: escapes HTML, renders code fences, $math$, bold,
// links and lists — enough for agent answers without a heavy dependency.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      output: "html",
    });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

function renderInline(text: string): string {
  // inline math first ($...$), then bold, code, links
  const parts: string[] = [];
  const mathRe = /\$([^$\n]+)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = mathRe.exec(text))) {
    parts.push(inlinePlain(text.slice(last, m.index)));
    parts.push(renderMath(m[1], false));
    last = m.index + m[0].length;
  }
  parts.push(inlinePlain(text.slice(last)));
  return parts.join("");
}

function inlinePlain(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  return out;
}

export function renderAgentMarkdown(text: string): string {
  if (!text) return "";
  const blocks: string[] = [];
  // split fenced code
  const fenceRe = /```(\w*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) {
    blocks.push(...splitMathBlocks(text.slice(last, m.index)));
    blocks.push(`<pre class="agent-code"><code>${escapeHtml(m[2])}</code></pre>`);
    last = m.index + m[0].length;
  }
  blocks.push(...splitMathBlocks(text.slice(last)));
  return blocks
    .map((b) => (b.startsWith("<") ? b : `<p>${b}</p>`))
    .join("");
}

function splitMathBlocks(text: string): string[] {
  const out: string[] = [];
  const blockRe = /\$\$([\s\S]+?)\$\$/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text))) {
    out.push(renderInline(text.slice(last, m.index)));
    out.push(renderMath(m[1], true));
    last = m.index + m[0].length;
  }
  out.push(renderInline(text.slice(last)));
  return out.filter((s) => s.trim().length > 0 || s.includes("katex"));
}
