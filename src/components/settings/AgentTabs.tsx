import { useCallback, useEffect, useRef, useState } from "react";
import {
  agentApi,
  homeApi,
  type AgentConfig,
  type AgentMode,
  type AgentModePaths,
  type AgentOutputStyle,
  type SkillInfo,
  type SkillSource,
} from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { CodeArea } from "@/components/CodeArea";
import { SettingsCard, Row, SettingsSelect } from "./primitives";

/**
 * The Agent section of the settings, one shape per mode:
 *
 *   coding    模型 | MCP | 技能 | AGENTS.md | 高级
 *   creative  模型 | MCP | 技能 | AGENTS.md
 *   study     模型 | AGENTS.md
 *
 * Every page reads and writes real files: the model and credentials live in
 * `~/.bnote/agent.json` (one key per machine), while the mode's own files live
 * under its root (`<vault>/.bnote/agents/<mode>` by default). Nothing here
 * keeps a second copy of a setting, so what the page shows is what the agent
 * reads.
 */

const MODE_LABEL: Record<AgentMode, string> = {
  coding: "编码",
  creative: "创作",
  study: "学习",
};

const SOURCE_LABEL: Record<SkillSource, string> = {
  vault: "仓库",
  project: "项目",
  home: "家目录",
  custom: "自定义",
};

/** A path as the page shows it: vault-relative when inside the vault, `~` for home. */
function displayPath(path: string, vaultPath: string | null): string {
  if (!path) return "";
  if (vaultPath && path.startsWith(`${vaultPath}/`)) return path.slice(vaultPath.length + 1);
  return path.replace(/^\/Users\/[^/]+\//, "~/");
}

/** The shared model/credential configuration (`~/.bnote/agent.json`). */
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
        if (!cancelled) setLoadError(String(e).replace(/^[A-Z_]+:\s*/, ""));
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
      // Open sessions keep the model snapshot they started with; the panel
      // re-reads "current config" for the footnote and the skill list.
      useAppStore.getState().bumpAgentConfigVersion();
      showToast(note);
    } catch (e) {
      showToast(`保存失败: ${String(e)}`);
    }
  };

  return { cfg, loadError, update, save };
}

/** The mode's resolved paths, re-read after every write (disk is the source of truth). */
function useModePaths(mode: AgentMode, workdir: string | null) {
  const [paths, setPaths] = useState<AgentModePaths | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void homeApi
      .modePaths(mode, workdir)
      .then((next) => {
        if (cancelled) return;
        setPaths(next);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e).replace(/^[A-Z_]+:\s*/, ""));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, workdir, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { paths, error, reload };
}

function AgentLoading({ loadError }: { loadError: string | null }) {
  return (
    <div className="settings-section">
      {loadError ? `Agent 配置加载失败:${loadError}` : "加载中…"}
    </div>
  );
}

/** Agent / model: protocol, model, context window, Base URL, API key. */

export function AgentModelTab({ mode }: { mode: AgentMode }) {
  const showToast = useAppStore((s) => s.showToast);
  const { cfg, loadError, update, save } = useAgentSettings();
  if (!cfg) return <AgentLoading loadError={loadError} />;
  return (
    <div className="settings-section">
      <SettingsCard
        title="模型"
        desc={`${MODE_LABEL[mode]}助手使用的协议、模型与密钥,保存在 ~/.bnote/agent.json,三种模式共用。改动只影响之后新建的会话,已开的会话按创建时的配置继续(面板头部点 ⟳ 开新会话)。`}
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

type McpEntry = Record<string, unknown>;

function mcpTarget(value: McpEntry): string {
  if (typeof value.command === "string") {
    const args = Array.isArray(value.args) ? value.args.map(String) : [];
    return [value.command, ...args].join(" ");
  }
  return typeof value.url === "string" ? value.url : "(配置不完整)";
}

/**
 * Agent / MCP: the mode's own servers, each with an on/off switch. The switch
 * writes `disabledMcpServers` instead of deleting the entry, so disabling a
 * server is reversible. The JSON box edits `mcpServers` only and is merged back
 * into the whole file, so unrelated keys are never clobbered.
 */
export function AgentMcpTab({ mode, workdir }: { mode: AgentMode; workdir: string | null }) {
  const showToast = useAppStore((s) => s.showToast);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const { paths, reload } = useModePaths(mode, workdir);
  const [raw, setRaw] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void homeApi
      .readModeSettings(mode)
      .then((text) => {
        if (cancelled) return;
        setRaw(text);
        setDraft(null);
        setDirty(false);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e).replace(/^[A-Z_]+:\s*/, ""));
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  let file: Record<string, unknown> = {};
  if (raw !== null && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        file = parsed as Record<string, unknown>;
      }
    } catch {
      // A hand-broken file is reported by the advanced page; the MCP list
      // simply shows what can be parsed.
    }
  }
  const servers = (file.mcpServers ?? {}) as Record<string, McpEntry>;
  const disabled = Array.isArray(file.disabledMcpServers)
    ? (file.disabledMcpServers as unknown[]).map(String)
    : [];
  const names = Object.keys(servers).sort();
  const editorText = draft ?? JSON.stringify(servers, null, 2);
  let draftError: string | null = null;
  let draftServers: Record<string, McpEntry> | null = null;
  try {
    const parsed: unknown = JSON.parse(editorText || "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      draftServers = parsed as Record<string, McpEntry>;
    } else {
      draftError = "mcpServers 必须是一个对象";
    }
  } catch {
    draftError = "JSON 尚不合法";
  }

  const write = async (next: Record<string, unknown>, note: string) => {
    const text = `${JSON.stringify(next, null, 2)}\n`;
    try {
      await homeApi.writeModeSettings(mode, text);
      setRaw(text);
      setDraft(null);
      setDirty(false);
      setError(null);
      reload();
      useAppStore.getState().bumpAgentConfigVersion();
      showToast(note);
    } catch (e) {
      setError(String(e).replace(/^[A-Z_]+:\s*/, ""));
    }
  };

  const toggle = (name: string, enabled: boolean) => {
    const nextDisabled = enabled ? disabled.filter((n) => n !== name) : [...disabled, name];
    const next = { ...file };
    if (nextDisabled.length > 0) next.disabledMcpServers = nextDisabled;
    else delete next.disabledMcpServers;
    void write(next, `MCP 服务器「${name}」已${enabled ? "启用" : "停用"};新会话生效`);
  };

  return (
    <div className="settings-section">
      <SettingsCard
        title="MCP 服务器"
        desc={
          <>
            {MODE_LABEL[mode]}模式连接的 MCP 服务器,定义在{" "}
            <code>
              {paths ? displayPath(`${paths.root}/settings.json`, vaultPath) : "settings.json"}
            </code>{" "}
            的 <code>mcpServers</code> 里;三种模式各自独立。开关只记录到{" "}
            <code>disabledMcpServers</code>,不会删除配置。编码模式还会合并代码项目{" "}
            <code>.bnote/settings.json</code> 的 <code>mcpServers</code>
            (见「高级」),这里只编辑本模式的条目。工具以 mcp__服务器__工具
            命名,连接失败会在面板顶部提示。
          </>
        }
      >
        <div className="settings-block">
          {error && <div className="settings-error">{error}</div>}
          {names.length === 0 ? (
            <p className="settings-hint">还没有配置 MCP 服务器。在下方 JSON 里添加。</p>
          ) : (
            <ul className="mcp-list">
              {names.map((name) => {
                const value = servers[name] ?? {};
                const on = !disabled.includes(name);
                return (
                  <li className={`mcp-row${on ? "" : " off"}`} key={name}>
                    <div className="mcp-row-text">
                      <code className="mcp-row-name">{name}</code>
                      <span className="mcp-row-target" title={mcpTarget(value)}>
                        {mcpTarget(value)}
                      </span>
                    </div>
                    <span className="mcp-row-type">{value.type === "http" ? "http" : "stdio"}</span>
                    <button
                      className={`mcp-toggle${on ? " on" : ""}`}
                      role="switch"
                      aria-checked={on}
                      aria-label={`${on ? "停用" : "启用"} ${name}`}
                      title={on ? "停用" : "启用"}
                      onClick={() => toggle(name, !on)}
                    >
                      <span className="mcp-toggle-knob" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="settings-block">
          <div className="settings-block-label">mcpServers</div>
          <textarea
            className="settings-textarea mono"
            rows={8}
            spellCheck={false}
            value={editorText}
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
            }}
          />
          {draftError ? (
            <div className="settings-error">{draftError}</div>
          ) : (
            <div className="settings-hint">
              stdio 形如{" "}
              <code>{'{"name":{"type":"stdio","command":"npx","args":["-y","…"]}}'}</code>
              ,HTTP 形如 <code>{'{"name":{"type":"http","url":"https://…"}}'}</code>。
            </div>
          )}
          <div className="settings-actions">
            <button
              className="btn primary"
              disabled={!dirty || draftError !== null || draftServers === null}
              onClick={() =>
                void write({ ...file, mcpServers: draftServers ?? {} }, "MCP 配置已保存;新会话生效")
              }
            >
              保存 MCP 配置
            </button>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}

/**
 * Agent / skills: grouped by where each skill comes from. Coding scans the
 * vault's mode root, the code project's `.agents/skills` and the shared
 * `~/.agents/skills`; creative reads only its own root (a creative agent must
 * not inherit the coding agent's skills).
 */
export function AgentSkillsTab({ mode, workdir }: { mode: AgentMode; workdir: string | null }) {
  const vaultPath = useAppStore((s) => s.vaultPath);
  const agentConfigVersion = useAppStore((s) => s.agentConfigVersion);
  const { paths, error, reload } = useModePaths(mode, workdir);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void agentApi
      .listSkills(mode, workdir)
      .then((list) => {
        if (cancelled) return;
        setSkills(list);
        setScanError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setSkills([]);
        setScanError(String(e).replace(/^[A-Z_]+:\s*/, ""));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, workdir, agentConfigVersion]);

  const desc =
    mode === "coding"
      ? "每个技能是一个目录下的 SKILL.md(frontmatter 提供 name 与 description)。按仓库、项目、家目录的顺序扫描,同名技能以仓库优先;额外目录写进 settings.json 的 skillDirs。"
      : "每个技能是一个目录下的 SKILL.md(frontmatter 提供 name 与 description)。创作模式只读取本模式的 skills 目录。";

  return (
    <div className="settings-section">
      <SettingsCard
        title="技能"
        desc={desc}
        actions={
          <button
            className="btn btn-ghost"
            onClick={() => {
              reload();
              useAppStore.getState().bumpAgentConfigVersion();
            }}
          >
            重新扫描
          </button>
        }
      >
        <div className="settings-block">
          {(error ?? scanError) && <div className="settings-error">{error ?? scanError}</div>}
          {!paths || skills === null ? (
            <p className="settings-hint">加载中…</p>
          ) : (
            <div className="skill-groups">
              {paths.skillRoots.map((root) => {
                const list = skills.filter((skill) => skill.root === root.path);
                return (
                  <section className="skill-group" key={`${root.source}:${root.path}`}>
                    <header className="skill-group-head">
                      <span className={`skill-source skill-source-${root.source}`}>
                        {SOURCE_LABEL[root.source]}
                      </span>
                      <code className="skill-group-path" title={root.path}>
                        {displayPath(root.path, vaultPath)}
                      </code>
                      <span className="skill-group-count">{list.length}</span>
                    </header>
                    {list.length === 0 ? (
                      <p className="skill-group-empty">未发现技能</p>
                    ) : (
                      <ul className="skill-list">
                        {list.map((skill) => (
                          <li className="skill-row" key={skill.path} title={skill.path}>
                            <code className="skill-name">/{skill.name}</code>
                            <span className="skill-desc">{skill.description || "(无描述)"}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}

const AGENTS_MD_TEMPLATE: Record<AgentMode, string> = {
  coding: `<!-- AGENTS.md — 编码助手的指令,保存在本模式的配置目录。
     编码会话还会读取代码仓库里的 AGENTS.md / CLAUDE.md(从 git 根到项目根),
     这里的指令始终先加载。留空 = 只用内置要求。 -->`,
  creative: `<!-- AGENTS.md — 创作助手的指令,保存在本模式的配置目录。
     创作会话只读取这个文件,不读取仓库里的其他指令。留空 = 只用内置要求。 -->`,
  study: `<!-- AGENTS.md — 学习助手的指令,保存在本模式的配置目录。
     学习会话只读取这个文件。留空 = 只用内置要求。 -->`,
};

/**
 * Agent / AGENTS.md: the mode's instructions file plus its configuration root.
 * The root card lives here because the file's path is the first thing the page
 * has to show; changing the root moves every mode file at once.
 */
export function AgentInstructionsTab({
  mode,
  workdir,
}: {
  mode: AgentMode;
  workdir: string | null;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const vaultPath = useAppStore((s) => s.vaultPath);
  const { paths, error: pathError, reload } = useModePaths(mode, workdir);
  const [text, setText] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rootDraft, setRootDraft] = useState<string | null>(null);

  const root = paths?.root ?? null;
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    void homeApi
      .readModeInstructions(mode)
      .then((value) => {
        if (cancelled) return;
        setText(value ?? "");
        setDirty(false);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setText("");
        setError(String(e).replace(/^[A-Z_]+:\s*/, ""));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, root]);

  const applyRoot = () => {
    const next = rootDraft?.trim() ?? "";
    void homeApi
      .setModeRoot(mode, next || null)
      .then(() => {
        setRootDraft(null);
        reload();
        showToast(next ? "配置目录已切换" : `已恢复默认目录(仓库内 .bnote/agents/${mode})`);
      })
      .catch((e) => setError(String(e).replace(/^[A-Z_]+:\s*/, "")));
  };

  return (
    <div className="settings-section">
      <SettingsCard
        title="AGENTS.md"
        desc={
          mode === "coding"
            ? "编码助手的指令,保存在配置目录的 AGENTS.md;仓库里的 AGENTS.md / CLAUDE.md 会在此之后追加。"
            : mode === "creative"
              ? "创作助手的指令,保存在配置目录的 AGENTS.md;创作模式只读取这个文件。"
              : "学习助手的指令,保存在配置目录的 AGENTS.md;学习模式只读取这个文件。"
        }
      >
        <div className="settings-block">
          <div className="settings-path-current" title={paths?.instructions}>
            <code>{paths ? displayPath(paths.instructions, vaultPath) : "加载中…"}</code>
            <span className="settings-path-state">
              {paths ? (paths.instructionsExists ? "已存在" : "未创建") : ""}
            </span>
          </div>
          {(error ?? pathError) && <div className="settings-error">{error ?? pathError}</div>}
          <textarea
            className="settings-textarea mono"
            rows={12}
            spellCheck={false}
            placeholder={text === null ? "加载中…" : AGENTS_MD_TEMPLATE[mode]}
            value={text ?? ""}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
          />
          <div className="settings-actions">
            <button
              className="btn primary"
              disabled={!dirty || text === null || !root}
              onClick={() =>
                void homeApi
                  .writeModeInstructions(mode, text ?? "")
                  .then(() => {
                    setDirty(false);
                    useAppStore.getState().bumpAgentConfigVersion();
                    reload();
                    showToast("AGENTS.md 已保存;新会话生效");
                  })
                  .catch((e) => setError(String(e).replace(/^[A-Z_]+:\s*/, "")))
              }
            >
              保存并应用到新会话
            </button>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="配置目录"
        desc="本模式的 settings.json、AGENTS.md、skills 与 output-styles 都放在这里;默认随仓库保存,改成任意绝对路径后该模式的文件整体迁到那里(会话记录仍在 ~/.bnote)。"
      >
        <div className="settings-block">
          <div className="settings-path-list">
            <div className="settings-path-item">
              <code>{paths?.root ?? "加载中…"}</code>
              <span className="settings-path-state">
                {paths?.overridePath ? "自定义目录" : "默认目录(仓库内)"}
              </span>
            </div>
            {paths?.overridePath && (
              <div className="settings-path-item">
                <code>{paths.defaultRoot}</code>
                <span className="settings-path-state">默认目录</span>
              </div>
            )}
          </div>
          <div className="settings-root-edit">
            <input
              className="settings-input mono"
              value={rootDraft ?? paths?.overridePath ?? ""}
              placeholder={paths ? `留空用默认:${paths.defaultRoot}` : ""}
              onChange={(e) => setRootDraft(e.target.value)}
            />
            <button className="btn primary" disabled={rootDraft === null} onClick={applyRoot}>
              应用目录
            </button>
            <button
              className="btn btn-ghost"
              disabled={!paths?.overridePath}
              onClick={() => {
                setRootDraft("");
                void homeApi
                  .setModeRoot(mode, null)
                  .then(() => {
                    setRootDraft(null);
                    reload();
                    showToast("已恢复默认配置目录");
                  })
                  .catch((e) => setError(String(e).replace(/^[A-Z_]+:\s*/, "")));
              }}
            >
              恢复默认
            </button>
          </div>
          <div className="settings-hint">
            切换目录只改变之后读取的位置,不会自动搬移已有文件;旧目录保留不动。
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}

/**
 * Agent / advanced (coding only): the mode's whole settings.json, the output
 * style, and the file list with each file's parse state. This is the page for
 * permissions, hooks and env — the parts that do not deserve their own form.
 */
export function AgentAdvancedTab({ mode, workdir }: { mode: AgentMode; workdir: string | null }) {
  const { paths, error: pathError, reload } = useModePaths(mode, workdir);
  const showToast = useAppStore((s) => s.showToast);
  const [styles, setStyles] = useState<AgentOutputStyle[]>([]);
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [styleOpen, setStyleOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setError(null);
    void Promise.all([
      homeApi.outputStyles(mode, workdir).catch(() => []),
      homeApi.readModeSettings(mode).catch(() => ""),
    ]).then(([nextStyles, raw]) => {
      setStyles(nextStyles);
      setText(raw);
      setDirty(false);
      setLoaded(true);
    });
  }, [mode, workdir]);
  useEffect(load, [load]);

  // Click outside / Escape closes the style popover (same discipline as the
  // materials menu).
  useEffect(() => {
    if (!styleOpen) return;
    const onDown = (event: PointerEvent) => {
      const picker = pickerRef.current;
      if (picker && !picker.contains(event.target as Node)) setStyleOpen(false);
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

  const write = (next: string, note: string) => {
    void homeApi
      .writeModeSettings(mode, next)
      .then(() => {
        setText(next);
        setDirty(false);
        setError(null);
        reload();
        load();
        useAppStore.getState().bumpAgentConfigVersion();
        showToast(note);
      })
      .catch((e) => setError(String(e).replace(/^[A-Z_]+:\s*/, "")));
  };

  const applyStyle = (style: AgentOutputStyle) => {
    setStyleOpen(false);
    let parsed: Record<string, unknown> = {};
    if (text.trim()) {
      try {
        const value: unknown = JSON.parse(text);
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
    write(`${JSON.stringify(parsed, null, 2)}\n`, `输出风格已切换:${style.name}`);
  };

  const save = () => {
    setError(null);
    try {
      const parsed: unknown = JSON.parse(text || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError("settings.json 必须是一个对象");
        return;
      }
    } catch (e) {
      setError(`JSON 解析失败:${(e as Error).message}`);
      return;
    }
    write(text, "Agent 设置已保存;下一轮请求生效");
  };

  return (
    <div className="settings-section">
      <SettingsCard
        title="输出风格"
        desc="写进本模式 settings.json 的 outputStyle。风格只改变「怎么回答」,工作规则与权限不变;带 keep-coding-instructions: false 的自定义风格会替换编码指令层。"
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
                            ? "仓库"
                            : "项目"}
                        {style.description ? ` · ${style.description}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="settings-hint">
            自定义风格放在 <code>本模式目录/output-styles/&lt;id&gt;.md</code>,编码模式还会读取{" "}
            <code>&lt;代码项目&gt;/.bnote/output-styles/&lt;id&gt;.md</code>。
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="settings.json(权限 / hooks / 环境)"
        desc="本模式的设置文件。编码模式会用同代码项目下的 .bnote/settings.json 与 settings.local.json 覆盖;数组拼接去重,标量后者胜出。MCP 与技能目录也写在这里。"
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
            <div className="settings-hint">
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
          {pathError && <div className="settings-error">{pathError}</div>}
          {paths ? (
            <ul className="settings-path-list">
              {paths.files.map((file) => (
                <li className="settings-path-item" key={file.path}>
                  <code>{file.path}</code>
                  <span className="settings-path-state">
                    {file.error ? `解析失败:${file.error}` : file.exists ? "已存在" : "未创建"}
                    {file.kind === "project" ? " · 项目" : ""}
                    {file.kind === "local" ? " · 本地" : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="settings-hint">读取失败</div>
          )}
          <div className="settings-hint">
            会话记录、tasks、plans 与记忆仍在 <code>~/.bnote</code>
            (它们属于运行状态,不属于笔记)。
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
