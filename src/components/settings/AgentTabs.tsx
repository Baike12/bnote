import { useEffect, useRef, useState } from "react";
import {
  agentApi,
  homeApi,
  type AgentConfig,
  type AgentOutputStyle,
  type AgentSettingsPaths,
  type SkillInfo,
} from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { api } from "@/lib/tauri";
import { CodeArea } from "@/components/CodeArea";
import { SettingsCard, Row, SettingsSelect } from "./primitives";

function useAgentSettings() {
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void agentApi
      .getConfig()
      .then((c) => {
        if (!cancelled) setCfg(c);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e).replace(/^[A-Z_]+:\\s*/, ""));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (patch: Partial<AgentConfig>) =>
    setCfg((prev) => (prev ? { ...prev, ...patch } : prev));

  const save = async (
    patch: Partial<AgentConfig>,
    note: string,
    showToast: (m: string) => void,
  ) => {
    if (!cfg) return;
    try {
      await agentApi.saveConfig({ ...cfg, ...patch });
      // The already open sessions are not affected: they run with the model
      // config snapshot they started with, here the panel only reads the
      // "current config" once again (the footnote and the skill list
      // refresh).
      useAppStore.getState().bumpAgentConfigVersion();
      showToast(note);
    } catch (e) {
      showToast(`保存失败: ${String(e)}`);
    }
  };

  return { cfg, loadError, update, save };
}

function AgentLoading({ loadError }: { loadError: string | null }) {
  return (
    <div className="settings-section">
      {loadError ? `Agent 配置加载失败:${loadError}` : "加载中…"}
    </div>
  );
}

/** Agent / model: protocol, model, context window, Base URL, API key. */

export function AgentModelTab() {
  const showToast = useAppStore((s) => s.showToast);
  const { cfg, loadError, update, save } = useAgentSettings();
  if (!cfg) return <AgentLoading loadError={loadError} />;
  return (
    <div className="settings-section">
      <SettingsCard
        title="模型"
        desc="学习助手与创作模式共用;改动只影响之后新建的会话,已开的会话按创建时的配置继续(面板头部点 ⟳ 开新会话)。"
      >
        <Row
          label="协议"
          control={
            <SettingsSelect value={cfg.provider} onChange={(v) => update({ provider: v })}>
              <option value="anthropic">Anthropic(含兼容代理)</option>
              <option value="openai">OpenAI 兼容(OpenAI/DeepSeek/Grok/Ollama…)</option>
            </SettingsSelect>
          }
        />
        <Row
          label="模型"
          control={
            <input
              className="settings-input"
              value={cfg.model}
              placeholder="claude-sonnet-4-5 / deepseek-chat / gpt-4o…"
              onChange={(e) => update({ model: e.target.value })}
            />
          }
        />
        <Row
          label="上下文窗口"
          desc="模型的最大上下文(tokens),用于助手输入框下方显示占用率;按实际模型填写,如 128000、200000、420000"
          control={
            <input
              className="settings-input mono"
              type="number"
              min={1024}
              step={1024}
              value={cfg.context_window}
              onChange={(e) => update({ context_window: Math.max(0, Number(e.target.value) || 0) })}
            />
          }
        />
        <Row
          label="Base URL"
          desc="留空用官方地址"
          control={
            <input
              className="settings-input mono"
              value={cfg.base_url}
              placeholder="https://api.deepseek.com/v1"
              onChange={(e) => update({ base_url: e.target.value })}
            />
          }
        />
        <Row
          label="API Key"
          control={
            <input
              className="settings-input mono"
              type="password"
              value={cfg.api_key}
              onChange={(e) => update({ api_key: e.target.value })}
            />
          }
        />
      </SettingsCard>
      <div className="settings-footer">
        <button
          className="btn primary"
          onClick={() =>
            void save({}, "Agent 配置已保存;新会话生效(已开会话沿用原配置)", showToast)
          }
        >
          保存模型配置
        </button>
      </div>
    </div>
  );
}

/** The current list of the MCP servers (the part of the JSON that can be parsed safely). */

function McpSummary({ servers }: { servers: Record<string, unknown> }) {
  const rows = Object.entries(servers);
  if (rows.length === 0) {
    return <p className="settings-hint">还没有配置 MCP 服务器。</p>;
  }
  return (
    <ul className="mcp-summary">
      {rows.map(([name, value]) => {
        const v = (value ?? {}) as Record<string, unknown>;
        const target =
          typeof v.command === "string"
            ? [v.command, ...(Array.isArray(v.args) ? v.args.map(String) : [])].join(" ")
            : typeof v.url === "string"
              ? v.url
              : "(配置不完整)";
        return (
          <li key={name}>
            <code>{name}</code>
            <span className="mcp-summary-type">{v.type === "http" ? "http" : "stdio"}</span>
            <span className="mcp-summary-target">{target}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Agent / MCP: an overview of the server list plus the JSON editing. */

export function AgentMcpTab() {
  const showToast = useAppStore((s) => s.showToast);
  const { cfg, loadError, save } = useAgentSettings();
  const [mcpJson, setMcpJson] = useState<string | null>(null);
  if (!cfg) return <AgentLoading loadError={loadError} />;
  const json = mcpJson ?? JSON.stringify(cfg.mcp_servers ?? {}, null, 2);
  let parsed: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(json || "{}") as Record<string, unknown>;
  } catch {
    parseError = "JSON 尚不合法(下方清单显示的是上一次合法内容)";
  }
  return (
    <div className="settings-section">
      <SettingsCard
        title="MCP 服务器"
        desc={
          <>
            会话启动时连接(创作模式把工具交给模型;学习模式不注册工具)。stdio 形如{" "}
            <code>{`{ "server": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] } }`}</code>
            ,HTTP 形如 <code>{`{ "server": { "type": "http", "url": "https://…" } }`}</code>。工具以
            mcp__服务器__工具 命名,连接失败会在面板顶部提示。
          </>
        }
      >
        {parsed && <McpSummary servers={parsed} />}
        {parseError && <p className="settings-hint">{parseError}</p>}
        <div className="settings-block">
          <textarea
            className="settings-textarea mono"
            rows={10}
            spellCheck={false}
            value={json}
            onChange={(e) => setMcpJson(e.target.value)}
          />
        </div>
        <div className="settings-actions">
          <button
            className="btn primary"
            disabled={parseError !== null}
            onClick={() =>
              void save({ mcp_servers: parsed ?? {} }, "MCP 配置已保存;新会话生效", showToast)
            }
          >
            保存 MCP 配置
          </button>
        </div>
      </SettingsCard>
    </div>
  );
}

/** Agent / skills: the list of the SKILL.md files found on disk plus the extra scan directories. */

export function AgentSkillsTab() {
  const showToast = useAppStore((s) => s.showToast);
  const { cfg, loadError, update, save } = useAgentSettings();
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [dirsDirty, setDirsDirty] = useState(false);
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
  }, []);
  if (!cfg) return <AgentLoading loadError={loadError} />;
  return (
    <div className="settings-section">
      <SettingsCard
        title="技能"
        desc="每个技能是一个目录下的 SKILL.md(frontmatter 提供 name 与 description)。内置会扫描 应用数据/skills、仓库 .bnote/skills(推荐)与 ~/.agents/skills,外加下面配置的额外目录。创作模式里用 /技能名 调用。"
      >
        {skills === null ? (
          <p className="settings-hint">加载中…</p>
        ) : skills.length === 0 ? (
          <p className="settings-hint">
            还没有发现技能。在仓库里建 <code>.bnote/skills/&lt;技能名&gt;/SKILL.md</code> 即可。
          </p>
        ) : (
          <ul className="skill-summary">
            {skills.map((s) => (
              <li key={s.path}>
                <code>/{s.name}</code>
                <span className="skill-summary-desc">{s.description || "(无描述)"}</span>
                <span className="skill-summary-path" title={s.path}>
                  {s.path}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
      <SettingsCard title="额外扫描目录" desc="每行一个目录,与内置目录合并扫描。">
        <div className="settings-block">
          <textarea
            className="settings-textarea mono"
            rows={3}
            value={cfg.skill_dirs.join("\n")}
            onChange={(e) => {
              update({ skill_dirs: e.target.value.split("\n").filter((x) => x.trim()) });
              setDirsDirty(true);
            }}
          />
        </div>
        <div className="settings-actions">
          <button
            className="btn primary"
            disabled={!dirsDirty}
            onClick={() => {
              void save({}, "技能目录已保存", showToast);
              setDirsDirty(false);
            }}
          >
            保存技能目录
          </button>
        </div>
      </SettingsCard>
    </div>
  );
}

/** Agent / AGENTS.md: the custom instructions of the vault (the legacy .bnote/agent.md is read for compatibility). */

const AGENTS_MD_TEMPLATE = `<!-- .bnote/AGENTS.md — 学习助手与创作模式的自定义指令。
     保存在当前仓库,随会话启动加载;内置的通用要求(简洁、结论先行、
     组块化)始终生效,这里的指令在其后追加。留空 = 只用通用要求。
     例如:优先用表格对比易混概念;创作时先给提纲再动笔。 -->`;

export function AgentInstructionsTab() {
  const showToast = useAppStore((s) => s.showToast);
  const vaultName = useAppStore((s) => s.vaultName);
  const [instructions, setInstructions] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [legacy, setLegacy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .readVaultFile("AGENTS.md")
      .then((v) => {
        if (cancelled) return;
        if (v !== null) {
          setInstructions(v);
        } else {
          // The legacy file name is read to make the migration easy, only AGENTS.md is written when saving.
          void api.readVaultFile("agent.md").then((old) => {
            if (cancelled) return;
            if (old !== null && old.trim()) {
              setInstructions(old);
              setLegacy(true);
            }
            setLoaded(true);
          });
          return;
        }
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="settings-section">
      <SettingsCard
        title="AGENTS.md(仓库自定义指令)"
        desc={
          <>
            保存为仓库的 <code>.bnote/AGENTS.md</code>,学习助手与创作模式的会话启动时加载;
            内置通用要求(结论先行、直击本质、组块化)始终生效,这里的指令追加在其后。
            {legacy && " 检测到旧版 .bnote/agent.md,内容已载入;保存后运行时将优先读 AGENTS.md。"}
            {vaultName ? "" : " (当前没有打开仓库,保存不可用)"}
          </>
        }
      >
        <div className="settings-block">
          <textarea
            className="settings-textarea mono"
            rows={12}
            spellCheck={false}
            placeholder={loaded ? AGENTS_MD_TEMPLATE : "加载中…"}
            value={instructions}
            onChange={(e) => {
              setInstructions(e.target.value);
              setDirty(true);
            }}
          />
          <div className="settings-actions">
            <button
              className="btn primary"
              disabled={!dirty || !vaultName}
              onClick={() =>
                void api
                  .writeVaultFile("AGENTS.md", instructions)
                  .then(() => {
                    setDirty(false);
                    setLegacy(false);
                    // A session has frozen the system prompt, only a restarted session picks up the new instructions.
                    useAppStore.getState().bumpAgentConfigVersion();
                    showToast("AGENTS.md 已保存;新会话生效");
                  })
                  .catch((e) => showToast(`保存失败: ${String(e)}`))
              }
            >
              保存并应用到新会话
            </button>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}

/**
 * Agent settings: the layers Claude Code calls `settings.json`.
 *
 * The output style is chosen here (a title button + popover, never a native
 * `<select>`), and the whole user-level file can be edited as JSON — that is
 * where permissions (allow / ask / deny), hooks, env and the extra
 * directories live. The three consulted files are listed with their parse
 * state so a broken file is visible instead of silently disabling rules.
 */

export function AgentSettingsTab() {
  const showToast = useAppStore((s) => s.showToast);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const codeProject = useAppStore((s) => s.codeProject);
  // Coding settings belong to the repository; without one the vault is the
  // project (study / creative sessions).
  const project = codeProject?.path ?? vaultPath;
  const [paths, setPaths] = useState<AgentSettingsPaths | null>(null);
  const [styles, setStyles] = useState<AgentOutputStyle[]>([]);
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [styleOpen, setStyleOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const load = () => {
    setError(null);
    void Promise.all([
      homeApi.settingsPaths(project).catch(() => null),
      homeApi.outputStyles(project).catch(() => []),
      homeApi.readSettings().catch(() => null),
    ]).then(([nextPaths, nextStyles, raw]) => {
      setPaths(nextPaths);
      setStyles(nextStyles);
      setText(raw ?? "");
      setDirty(false);
      setLoaded(true);
    });
  };
  useEffect(load, [project]);

  // Click outside / Escape closes the style popover (same discipline as the
  // materials menu).
  useEffect(() => {
    if (!styleOpen) return;
    const onDown = (event: PointerEvent) => {
      const root = pickerRef.current;
      if (root && !root.contains(event.target as Node)) setStyleOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setStyleOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [styleOpen]);

  const selectedId = (() => {
    if (!text.trim()) return "default";
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const value = parsed.outputStyle;
      return typeof value === "string" && value.trim() ? value : "default";
    } catch {
      return "default";
    }
  })();
  const selectedStyle =
    styles.find((style) => style.id.toLowerCase() === selectedId.toLowerCase()) ?? null;

  const applyStyle = (style: AgentOutputStyle) => {
    setStyleOpen(false);
    let parsed: Record<string, unknown> = {};
    if (text.trim()) {
      try {
        const value = JSON.parse(text) as unknown;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          setError("settings.json 必须是一个对象");
          return;
        }
        parsed = value as Record<string, unknown>;
      } catch (e) {
        setError(`settings.json 不是合法 JSON:${(e as Error).message}`);
        return;
      }
    }
    parsed.outputStyle = style.id;
    const next = `${JSON.stringify(parsed, null, 2)}\n`;
    void homeApi
      .writeSettings(next)
      .then(() => {
        setText(next);
        setDirty(false);
        setError(null);
        showToast(`输出风格已切换:${style.name}`);
        load();
      })
      .catch((e) => setError(String(e).replace(/^[A-Z_]+:\s*/, "")));
  };

  const save = () => {
    setError(null);
    try {
      const parsed = JSON.parse(text || "{}") as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError("settings.json 必须是一个对象");
        return;
      }
    } catch (e) {
      setError(`JSON 解析失败:${(e as Error).message}`);
      return;
    }
    void homeApi
      .writeSettings(text)
      .then(() => {
        setDirty(false);
        useAppStore.getState().bumpAgentConfigVersion();
        showToast("Agent 设置已保存;下一轮请求生效");
        load();
      })
      .catch((e) => setError(String(e).replace(/^[A-Z_]+:\s*/, "")));
  };

  return (
    <div className="settings-section">
      <SettingsCard
        title="输出风格"
        desc="写进 ~/.bnote/settings.json 的 outputStyle。风格只改变「怎么回答」,工作规则与权限不变;带 keep-coding-instructions: false 的自定义风格会替换编码指令层。"
      >
        <div className="settings-block">
          <div className="study-history" ref={pickerRef}>
            <button
              className={`content-title-btn${styleOpen ? " open" : ""}`}
              title="选择输出风格"
              aria-expanded={styleOpen}
              onClick={() => setStyleOpen(!styleOpen)}
            >
              <span className="content-title">{selectedStyle?.name ?? selectedId}</span>
              <span className="content-history-caret">▾</span>
            </button>
            {styleOpen && (
              <div className="study-history-pop" role="dialog" aria-label="输出风格">
                <div className="study-history-list">
                  {styles.map((style) => (
                    <button
                      key={style.id}
                      className="study-history-item"
                      onClick={() => applyStyle(style)}
                      title={style.description || style.id}
                    >
                      <span className="study-history-title">
                        {style.name}
                        {style.id === selectedId ? "  ✓" : ""}
                      </span>
                      <span className="study-history-sub">
                        {style.source === "builtin"
                          ? "内置"
                          : style.source === "user"
                            ? "用户"
                            : "项目"}
                        {style.description ? ` · ${style.description}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="settings-desc">
            自定义风格放在 <code>~/.bnote/output-styles/&lt;id&gt;.md</code> 或{" "}
            <code>&lt;项目&gt;/.bnote/output-styles/&lt;id&gt;.md</code>。
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="settings.json(权限 / hooks / 环境)"
        desc="用户级设置。项目级会用同目录的 settings.json 与 settings.local.json 覆盖;数组拼接去重,标量后者胜出。"
      >
        <div className="settings-block">
          <CodeArea
            value={text}
            onChange={(next) => {
              setText(next);
              setDirty(true);
              setError(null);
            }}
            height="30vh"
            searchPlaceholder="搜索键名"
          />
          {error ? (
            <div className="settings-error">{error}</div>
          ) : (
            <div className="settings-desc">
              {loaded ? "保存前校验 JSON;权限示例:" : "加载中…"}{" "}
              <code>{'{"permissions":{"deny":["Bash(git push:*)"]}}'}</code>
            </div>
          )}
          <div className="settings-actions">
            <button className="btn primary" disabled={!dirty || !loaded} onClick={save}>
              保存并应用
            </button>
            <button className="btn btn-ghost" disabled={!loaded} onClick={load}>
              重新载入
            </button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="设置文件"
        desc="按顺序合并,后者覆盖前者;解析失败的文件会被跳过并在这里标出。"
      >
        <div className="settings-block">
          {paths ? (
            <ul className="settings-path-list">
              {paths.files.map((file) => (
                <li key={file.path} className="settings-path-item">
                  <code>{file.path}</code>
                  <span className="settings-path-state">
                    {file.error ? `解析失败:${file.error}` : file.exists ? "已存在" : "未创建"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="settings-desc">读取失败</div>
          )}
          <div className="settings-desc">
            Agent 家目录:<code>{paths?.home ?? "~/.bnote"}</code>
            (会话记录、tasks、plans、记忆、技能与输出风格都在这里)
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}

/**
 * The global configuration of the language servers.
 *
 * The built-in defaults already cover the common languages (ts / rust / go
 * / python), so it works out of the box as long as the matching server is
 * installed on this machine. What is changed here is "which executable is
 * used and which arguments it gets", for example whether TypeScript uses
 * tsserver or typescript-language-server.
 *
 * A project can also put a `.bnote/lsp.json` on top of it (it travels with
 * the vault and is shared by the team):
 *
 * ```json
 * { "languages": { "go": { "command": "/opt/homebrew/bin/gopls" } },
 *   "disabled": ["python"] }
 * ```
 */
