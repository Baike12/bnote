import { useCallback, useEffect, useState } from "react";
import {
  agentApi,
  type AgentDefinition,
  type DefinitionListItem,
  type DefError,
  type PromptSegment,
} from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import {
  effectiveTools,
  idFromName,
  sortDefinitions,
  TOOLS_CATALOG,
  toolChecks,
  defaultDefinition,
  toggleTool,
} from "@/agent/definitions";
import { CodeArea } from "./CodeArea";

/**
 * The agent-definitions page: one editor over `.bnote/agents/<id>.md`.
 *
 * The form edits the typed definition (the Rust struct mirrored in
 * lib/tauri.ts); serialization to the on-disk YAML frontmatter happens on the
 * backend through the canonical writer, so the page never hand-builds the
 * file format. Built-ins are listed for inspection — saving one writes a user
 * file that overrides it, which the hint says out loud.
 */

const NumberInput = ({
  value,
  onChange,
  min,
  max,
  step,
  width,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
}) => (
  <input
    className="settings-input"
    type="number"
    value={Number.isFinite(value) ? value : 0}
    min={min}
    max={max}
    step={step ?? 1}
    style={width ? { width } : undefined}
    onChange={(e) => {
      const n = Number(e.target.value);
      if (Number.isFinite(n)) onChange(n);
    }}
  />
);

export function AgentDefinitionsTab() {
  const vaultPath = useAppStore((s) => s.vaultPath);
  const showToast = useAppStore((s) => s.showToast);
  const [list, setList] = useState<DefinitionListItem[]>([]);
  const [errors, setErrors] = useState<DefError[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [def, setDef] = useState<AgentDefinition | null>(null);
  const [source, setSource] = useState<"builtin" | "user">("builtin");
  const [file, setFile] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<PromptSegment[] | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const refresh = useCallback(
    async (preferId?: string) => {
      try {
        const res = await agentApi.listDefinitions();
        setList(sortDefinitions(res.definitions));
        setErrors(res.errors);
        setSelectedId((cur) => {
          const next = preferId ?? cur ?? res.definitions[0]?.id ?? null;
          return res.definitions.some((d) => d.id === next) || next === null ? next : (res.definitions[0]?.id ?? null);
        });
      } catch (e) {
        showToast(String(e).replace(/^[A-Z_]+:\s*/, ""));
      }
    },
    [showToast],
  );

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the selected definition's full form (from its file or the builtin).
  useEffect(() => {
    if (!selectedId) {
      setDef(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    void agentApi
      .getDefinition(selectedId)
      .then((detail) => {
        if (cancelled) return;
        setDef(detail.definition);
        setSource(detail.source);
        setFile(detail.file);
      })
      .catch((e) => {
        if (cancelled) return;
        showToast(String(e).replace(/^[A-Z_]+:\s*/, ""));
        setDef(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, showToast]);

  const patch = (p: Partial<AgentDefinition>) => {
    setDef((cur) => (cur ? { ...cur, ...p } : cur));
  };

  async function save() {
    if (!def) return;
    setSaving(true);
    try {
      const path = await agentApi.saveDefinition(def);
      showToast(`已保存:${path}`);
      setPreview(null);
      await refresh(def.id);
    } catch (e) {
      showToast(String(e).replace(/^[A-Z_]+:\s*/, ""));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!def) return;
    if (source !== "user") {
      showToast("内置定义没有可删除的文件");
      return;
    }
    try {
      await agentApi.deleteDefinition(def.id);
      showToast(`已删除 ${def.id}`);
      setSelectedId(null);
      await refresh();
    } catch (e) {
      showToast(String(e).replace(/^[A-Z_]+:\s*/, ""));
    }
  }

  async function runPreview() {
    if (!def) return;
    setPreviewBusy(true);
    try {
      // Preview with the coding workdir when one is plausible? No — the
      // preview runs against the vault only; file layers that live in a code
      // project show as not-loaded with a hint.
      setPreview(await agentApi.assemblePreview(def));
    } catch (e) {
      showToast(String(e).replace(/^[A-Z_]+:\s*/, ""));
    } finally {
      setPreviewBusy(false);
    }
  }

  function newDefinition() {
    const id = idFromName(
      "新 agent",
      new Set(list.map((d) => d.id)),
    );
    const fresh = defaultDefinition(id);
    setDef(fresh);
    setSource("user");
    setFile(null);
    setSelectedId(id);
    setPreview(null);
  }

  const checks = def ? toolChecks(def) : null;
  const overridden = source === "user" && list.some((d) => d.id === def?.id && d.source === "builtin");

  return (
    <div className="agent-defs">
      <div className="agent-defs-list">
        <div className="agent-defs-list-head">
          <span>Agent 定义</span>
          <button className="btn btn-ghost" onClick={newDefinition} title="新建一个用户定义">
            ＋ 新建
          </button>
        </div>
        <ul>
          {list.map((d) => (
            <li key={d.id}>
              <button
                className={`agent-defs-item${d.id === selectedId ? " active" : ""}`}
                onClick={() => setSelectedId(d.id)}
                title={d.description}
              >
                <span className="agent-defs-item-name">{d.name || d.id}</span>
                <span className="agent-defs-item-tag">{d.source === "builtin" ? "内置" : "自定义"}</span>
              </button>
            </li>
          ))}
        </ul>
        {errors.length > 0 && (
          <div className="agent-defs-errors" title={errors.map((e) => `${e.id}: ${e.message}`).join("\n")}>
            {errors.length} 个定义文件解析失败
          </div>
        )}
        {!vaultPath && <p className="setting-desc">未打开仓库:只能查看内置定义,不能保存。</p>}
      </div>
      <div className="agent-defs-editor">
        {def ? (
          <>
            <div className="settings-card">
              <header className="settings-card-head">
                <div className="settings-card-head-text">
                  <div className="settings-card-title">
                    {def.name || def.id}
                    <span className="agent-defs-id"> · {def.id}</span>
                  </div>
                  <div className="settings-card-desc">
                    {source === "builtin"
                      ? "内置定义(只读展示;保存会生成同名用户文件并覆盖内置)"
                      : `自定义定义${file ? ` · ${file}` : ""}${overridden ? " · 正在覆盖内置同名定义" : ""}`}
                  </div>
                </div>
                <div className="settings-card-actions">
                  <button className="btn btn-ghost" onClick={() => void runPreview()} disabled={previewBusy}>
                    {previewBusy ? "装配中…" : "预览装配"}
                  </button>
                  {source === "user" && (
                    <button className="btn btn-ghost" onClick={() => void remove()}>
                      删除
                    </button>
                  )}
                  <button className="btn" onClick={() => void save()} disabled={saving || !vaultPath}>
                    {saving ? "保存中…" : "保存"}
                  </button>
                </div>
              </header>
              <div className="settings-card-body">
                <div className="setting-row">
                  <div className="setting-row-text">
                    <div className="setting-label">显示名 / 描述</div>
                    <div className="setting-desc">描述进入定义列表与子代理选择提示。</div>
                  </div>
                  <div className="setting-control agent-defs-col">
                    <input
                      className="settings-input"
                      value={def.name}
                      placeholder="显示名"
                      onChange={(e) => patch({ name: e.target.value })}
                    />
                    <input
                      className="settings-input"
                      value={def.description}
                      placeholder="一句话描述这个 agent 干什么"
                      onChange={(e) => patch({ description: e.target.value })}
                    />
                  </div>
                </div>
                <div className="setting-row">
                  <div className="setting-row-text">
                    <div className="setting-label">模型覆盖</div>
                    <div className="setting-desc">留空 = 用设置里的全局模型;max_tokens / 轮数 0 = 默认。</div>
                  </div>
                  <div className="setting-control agent-defs-col">
                    <input
                      className="settings-input"
                      value={def.model}
                      placeholder="模型名(留空用全局)"
                      onChange={(e) => patch({ model: e.target.value })}
                    />
                    <div className="agent-defs-inline">
                      <label className="setting-desc">max_tokens</label>
                      <NumberInput value={def.max_tokens} min={0} onChange={(v) => patch({ max_tokens: v })} />
                      <label className="setting-desc">max_turns</label>
                      <NumberInput value={def.max_turns} min={0} max={100} onChange={(v) => patch({ max_turns: v })} />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="settings-card">
              <header className="settings-card-head">
                <div className="settings-card-head-text">
                  <div className="settings-card-title">工具</div>
                  <div className="settings-card-desc">
                    勾选 = 注册给模型的工具白名单;未改动时用默认集。
                    {checks && !checks.explicit && <strong> 当前:默认集。</strong>}
                  </div>
                </div>
              </header>
              <div className="settings-card-body">
                <div className="agent-defs-tools">
                  {TOOLS_CATALOG.map((t) => (
                    <label key={t.name} className="agent-defs-tool" title={t.name}>
                      <input
                        type="checkbox"
                        checked={checks?.on.has(t.name) ?? false}
                        onChange={(e) => def && setDef(toggleTool(def, t.name, e.target.checked))}
                      />
                      {t.label}
                    </label>
                  ))}
                </div>
                <div className="setting-row">
                  <div className="setting-row-text">
                    <div className="setting-label">权限覆盖(deny)</div>
                    <div className="setting-desc">deny 直接把工具从会话里摘掉,优先于白名单。</div>
                  </div>
                  <div className="setting-control agent-defs-col">
                    {effectiveTools({ tools: def.tools, permissions: {} })
                      .filter((t) => t !== "mcp")
                      .map((t) => (
                        <label key={t} className="agent-defs-tool">
                          <input
                            type="checkbox"
                            checked={def.permissions[t] === "deny"}
                            onChange={(e) => {
                              const next = { ...def.permissions };
                              if (e.target.checked) next[t] = "deny";
                              else delete next[t];
                              patch({ permissions: next });
                            }}
                          />
                          禁用 {t}
                        </label>
                      ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="settings-card">
              <header className="settings-card-head">
                <div className="settings-card-head-text">
                  <div className="settings-card-title">能力</div>
                </div>
              </header>
              <div className="settings-card-body">
                <div className="setting-row">
                  <div className="setting-row-text">
                    <div className="setting-label">上下文压缩</div>
                    <div className="setting-desc">占用超过 context_window × 阈值时,自动把历史替换成摘要。</div>
                  </div>
                  <div className="setting-control agent-defs-inline">
                    <input
                      type="checkbox"
                      checked={def.compaction.enabled}
                      onChange={(e) => patch({ compaction: { ...def.compaction, enabled: e.target.checked } })}
                    />
                    <NumberInput
                      value={def.compaction.threshold}
                      min={0.3}
                      max={1}
                      step={0.05}
                      width={72}
                      onChange={(v) => patch({ compaction: { ...def.compaction, threshold: v } })}
                    />
                  </div>
                </div>
                <div className="setting-row">
                  <div className="setting-row-text">
                    <div className="setting-label">子代理白名单</div>
                    <div className="setting-desc">逗号分隔的定义 id;空 = 允许全部(explore / coding / …)。</div>
                  </div>
                  <div className="setting-control">
                    <input
                      className="settings-input"
                      value={def.subagents.join(", ")}
                      placeholder="如 explore, reviewer"
                      onChange={(e) =>
                        patch({
                          subagents: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="settings-card">
              <header className="settings-card-head">
                <div className="settings-card-head-text">
                  <div className="settings-card-title">Prompt 分层</div>
                  <div className="settings-card-desc">
                    正文是第一层(order 10);这里追加从文件加载的层(相对代码项目根,回退仓库根),每轮动态重读。
                  </div>
                </div>
                <div className="settings-card-actions">
                  <button
                    className="btn btn-ghost"
                    onClick={() => patch({ prompt_layers: [...def.prompt_layers, { file: "AGENTS.md", order: 50 }] })}
                  >
                    ＋ 加一层
                  </button>
                </div>
              </header>
              <div className="settings-card-body">
                {def.prompt_layers.length === 0 && <p className="setting-desc">暂无文件层。</p>}
                {def.prompt_layers.map((layer, i) => (
                  <div className="agent-defs-inline" key={i}>
                    <input
                      className="settings-input"
                      value={layer.file}
                      placeholder="文件相对路径"
                      onChange={(e) => {
                        const next = [...def.prompt_layers];
                        next[i] = { ...layer, file: e.target.value };
                        patch({ prompt_layers: next });
                      }}
                    />
                    <NumberInput
                      value={layer.order}
                      width={72}
                      onChange={(v) => {
                        const next = [...def.prompt_layers];
                        next[i] = { ...layer, order: v };
                        patch({ prompt_layers: next });
                      }}
                    />
                    <button
                      className="btn btn-ghost"
                      onClick={() =>
                        patch({ prompt_layers: def.prompt_layers.filter((_, j) => j !== i) })
                      }
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <div className="agent-defs-body">
                  <div className="setting-label">正文(system prompt 主体)</div>
                  <CodeArea
                    value={def.body}
                    onChange={(v) => patch({ body: v })}
                    height={260}
                  />
                </div>
              </div>
            </div>

            {preview && (
              <div className="settings-card">
                <header className="settings-card-head">
                  <div className="settings-card-head-text">
                    <div className="settings-card-title">装配预览</div>
                    <div className="settings-card-desc">
                      按最终顺序展示各段;dynamic 的段每轮重读,未加载的文件层会标注。
                    </div>
                  </div>
                </header>
                <div className="settings-card-body">
                  {preview.map((seg) => (
                    <details key={`${seg.order}-${seg.name}`} className="agent-defs-seg">
                      <summary>
                        <span className="agent-defs-seg-order">#{seg.order}</span>
                        <span className="agent-defs-seg-name">{seg.name}</span>
                        {seg.dynamic && <span className="agent-defs-item-tag">dynamic</span>}
                        {!seg.loaded && <span className="agent-defs-item-tag fail">未加载</span>}
                      </summary>
                      <pre className="agent-defs-seg-body">{seg.content || "(空)"}</pre>
                    </details>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="setting-desc">选择左侧的定义,或点「新建」。</p>
        )}
      </div>
    </div>
  );
}
