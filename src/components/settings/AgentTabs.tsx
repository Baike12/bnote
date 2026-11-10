import { useCallback, useEffect, useRef, useState } from "react";
import {
  agentApi,
  homeApi,
  type AgentConfig,
  type AgentMode,
  type AgentModePaths,
  type AgentOutputStyle,
  type ModelSelection,
  type SkillInfo,
  type SkillSource,
} from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { CodeArea } from "@/components/CodeArea";
import { formatPatch, levelLabel } from "@/components/agent/modelSelection";
import {
  fromDraft,
  newModel,
  newProvider,
  toDraft,
  type CatalogDraft,
  type LevelDraft,
  type ModelDraft,
  type ProviderDraft,
} from "./agentCatalogDraft";
import { SettingsCard, Row, SettingsSelect } from "./primitives";

/**
 * The Agent section of the settings, one shape per mode:
 *
 *   coding    模型 | MCP | 技能 | AGENTS.md | 高级
 *   creative  模型 | MCP | 技能 | AGENTS.md
 *   study     模型 | AGENTS.md
 *
 * Every page reads and writes real files: the model and credentials live in
 * the home's `agent.json` (the open vault's `.bnote`, else `~/.bnote`), while
 * the mode's own files live under its root (`<vault>/.bnote/agents/<mode>` by
 * default). Nothing here
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

/** A provider/model/level picker (three selects): the default model and the subagent rows. */
function SelectionControl({
  draft,
  value,
  onChange,
  inheritLabel,
}: {
  draft: CatalogDraft;
  value: ModelSelection | null;
  onChange: (value: ModelSelection | null) => void;
  /** When set, the empty provider option means it (inherits the parent session). */
  inheritLabel?: string;
}) {
  const provider = draft.providers.find((p) => p.id === value?.provider_id) ?? null;
  const model = provider?.models.find((m) => m.id === value?.model_id) ?? null;
  const levels = model?.thinking ?? [];
  const lastLevel = levels.length > 0 ? (levels[levels.length - 1]?.id ?? "") : "";
  const level = levels.some((l) => l.id === value?.thinking)
    ? (value?.thinking ?? "")
    : model?.default_thinking || lastLevel;
  const pickModel = (providerId: string, modelId: string) => {
    const nextProvider = draft.providers.find((p) => p.id === providerId);
    const nextModel = nextProvider?.models.find((m) => m.id === modelId);
    if (!nextProvider || !nextModel) {
      onChange(null);
      return;
    }
    const thinking = nextModel.thinking.some((l) => l.id === value?.thinking)
      ? (value?.thinking ?? "")
      : nextModel.default_thinking || nextModel.thinking[nextModel.thinking.length - 1]?.id || "";
    onChange({ provider_id: providerId, model_id: modelId, thinking });
  };
  return (
    <span className="agent-selection">
      <SettingsSelect<string>
        value={value?.provider_id ?? ""}
        onChange={(id) => {
          if (!id) {
            onChange(null);
            return;
          }
          const next = draft.providers.find((p) => p.id === id)?.models[0];
          if (next) pickModel(id, next.id);
        }}
      >
        {inheritLabel && <option value="">{inheritLabel}</option>}
        {draft.providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name || p.id || "未命名供应商"}
          </option>
        ))}
      </SettingsSelect>
      <SettingsSelect<string>
        value={value?.model_id ?? ""}
        onChange={(id) => {
          if (value && id) pickModel(value.provider_id, id);
        }}
      >
        {!provider && <option value="">—</option>}
        {provider?.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name || m.id || "未命名模型"}
          </option>
        ))}
      </SettingsSelect>
      <SettingsSelect<string>
        value={level}
        onChange={(id) => {
          if (value) onChange({ ...value, thinking: id });
        }}
      >
        {levels.length === 0 && <option value="">—</option>}
        {levels.map((l) => (
          <option key={l.id} value={l.id}>
            {levelLabel(l.id)}
          </option>
        ))}
      </SettingsSelect>
    </span>
  );
}

/** One model of a provider: identity, limits, capabilities and its thinking levels. */
function ModelEditor({
  provider,
  model,
  onPatch,
  onRemove,
}: {
  provider: ProviderDraft;
  model: ModelDraft;
  onPatch: (patch: Partial<ModelDraft>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [filling, setFilling] = useState(false);
  const fillDefaults = async () => {
    setFilling(true);
    try {
      const levels = await agentApi.defaultLevels(
        provider.protocol,
        model.id,
        provider.base_url,
        model.max_tokens,
      );
      onPatch({
        thinking: levels.map((level) => ({
          id: level.id,
          text: formatPatch(level.patch),
        })),
        default_thinking: model.default_thinking || levels[levels.length - 1]?.id || "",
      });
    } catch (e) {
      console.warn("[settings] default levels", e);
    } finally {
      setFilling(false);
    }
  };
  const patchLevel = (index: number, patch: Partial<LevelDraft>) =>
    onPatch({
      thinking: model.thinking.map((level, i) => (i === index ? { ...level, ...patch } : level)),
    });
  const moveLevel = (index: number, delta: number) => {
    const next = [...model.thinking];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    onPatch({ thinking: next });
  };
  return (
    <div className="agent-model-row">
      <div className="agent-model-row-head">
        <button className="agent-model-row-toggle" onClick={() => setOpen((v) => !v)}>
          <span className="agent-model-row-name">{model.name || model.id || "未命名模型"}</span>
          <span className="agent-model-row-meta">
            {model.vision ? "视觉 · " : ""}
            {levelLabel(
              model.default_thinking || model.thinking[model.thinking.length - 1]?.id || "",
            ) || "无档位"}
          </span>
          <span className={`agent-model-row-caret${open ? " is-open" : ""}`}>›</span>
        </button>
        <button className="btn btn-ghost small" onClick={onRemove} title="删除模型">
          删除
        </button>
      </div>
      {open && (
        <div className="agent-model-row-body">
          <Row
            label="模型 ID"
            desc="请求里的 model 字段,例如 deepseek-chat、claude-sonnet-5"
            control={
              <input
                className="settings-input mono"
                value={model.id}
                onChange={(e) => onPatch({ id: e.target.value })}
              />
            }
          />
          <Row
            label="显示名"
            desc="只用于界面显示,留空等于模型 ID"
            control={
              <input
                className="settings-input"
                value={model.name}
                onChange={(e) => onPatch({ name: e.target.value })}
              />
            }
          />
          <Row
            label="上下文窗口"
            desc="tokens,用于输入框下方的占用率与自动压缩"
            control={
              <input
                className="settings-input mono"
                type="number"
                min={1024}
                step={1024}
                value={model.context_window}
                onChange={(e) =>
                  onPatch({ context_window: Math.max(0, Number(e.target.value) || 0) })
                }
              />
            }
          />
          <Row
            label="最大输出"
            desc="单次回复的输出上限(tokens),被截断时本轮会先提升再续写"
            control={
              <input
                className="settings-input mono"
                type="number"
                min={1024}
                step={1024}
                value={model.max_tokens}
                onChange={(e) => onPatch({ max_tokens: Math.max(0, Number(e.target.value) || 0) })}
              />
            }
          />
          <Row
            label="视觉"
            desc="模型接受图片输入(输入框底部给模型挂「视觉」标签)"
            control={
              <input
                type="checkbox"
                checked={model.vision}
                onChange={(e) => onPatch({ vision: e.target.checked })}
              />
            }
          />
          <Row
            label="默认档位"
            desc="选中这个模型时用的思考强度"
            control={
              <SettingsSelect<string>
                value={model.default_thinking}
                onChange={(id) => onPatch({ default_thinking: id })}
              >
                {model.thinking.length === 0 && <option value="">—</option>}
                {model.thinking.map((l) => (
                  <option key={l.id} value={l.id}>
                    {levelLabel(l.id)}
                  </option>
                ))}
              </SettingsSelect>
            }
          />
          <div className="agent-levels">
            <div className="agent-levels-head">
              <span>思考档位</span>
              <span className="agent-levels-actions">
                <button
                  className="btn btn-ghost small"
                  onClick={() => void fillDefaults()}
                  disabled={filling}
                >
                  填入协议默认映射
                </button>
                <button
                  className="btn btn-ghost small"
                  onClick={() =>
                    onPatch({
                      thinking: [
                        ...model.thinking,
                        { id: `level-${model.thinking.length + 1}`, text: "{}" },
                      ],
                    })
                  }
                >
                  添加档位
                </button>
              </span>
            </div>
            <div className="agent-levels-desc">
              每档一个 JSON 对象(RFC 7396):保存时合并进请求体,值为 null 表示删除该字段。例如{" "}
              <code>{'{"thinking":{"type":"enabled","budget_tokens":8192}}'}</code>
            </div>
            {model.thinking.length === 0 && (
              <div className="agent-levels-empty">
                还没有档位:保存后按协议自动生成,或点「填入协议默认映射」。
              </div>
            )}
            {model.thinking.map((level, index) => (
              <div className="agent-level-row" key={`${level.id}-${index}`}>
                <input
                  className="settings-input agent-level-id"
                  value={level.id}
                  placeholder="档位名(off/low/medium/high/max)"
                  onChange={(e) => patchLevel(index, { id: e.target.value })}
                />
                <textarea
                  className="settings-input mono agent-level-patch"
                  rows={2}
                  value={level.text}
                  onChange={(e) => patchLevel(index, { text: e.target.value })}
                />
                <span className="agent-level-actions">
                  <button
                    className="btn btn-ghost small"
                    onClick={() => moveLevel(index, -1)}
                    title="上移"
                  >
                    ↑
                  </button>
                  <button
                    className="btn btn-ghost small"
                    onClick={() => moveLevel(index, 1)}
                    title="下移"
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn-ghost small"
                    onClick={() =>
                      onPatch({ thinking: model.thinking.filter((_, i) => i !== index) })
                    }
                    title="删除档位"
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** One provider: endpoint + key + its models. */
function ProviderEditor({
  provider,
  onPatch,
  onRemove,
}: {
  provider: ProviderDraft;
  onPatch: (patch: Partial<ProviderDraft>) => void;
  onRemove: () => void;
}) {
  const patchModel = (index: number, patch: Partial<ModelDraft>) =>
    onPatch({ models: provider.models.map((m, i) => (i === index ? { ...m, ...patch } : m)) });
  return (
    <div className="agent-provider-card">
      <div className="agent-provider-card-head">
        <input
          className="settings-input agent-provider-name"
          value={provider.name}
          placeholder="供应商名称"
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <SettingsSelect<string>
          value={provider.protocol}
          onChange={(protocol) => onPatch({ protocol })}
        >
          <option value="anthropic">Anthropic(含兼容代理)</option>
          <option value="openai">OpenAI 兼容(OpenAI/DeepSeek/GLM/Qwen/Ollama…)</option>
        </SettingsSelect>
        <button className="btn btn-ghost small" onClick={onRemove} title="删除供应商">
          删除
        </button>
      </div>
      <Row
        label="Base URL"
        desc="留空用官方地址;兼容网关填到 /v1 一级"
        control={
          <input
            className="settings-input mono"
            value={provider.base_url}
            placeholder="https://api.deepseek.com/v1"
            onChange={(e) => onPatch({ base_url: e.target.value })}
          />
        }
      />
      <Row
        label="API Key"
        desc="只保存在本地 agent.json,不写进会话记录"
        control={
          <input
            className="settings-input mono"
            type="password"
            value={provider.api_key}
            onChange={(e) => onPatch({ api_key: e.target.value })}
          />
        }
      />
      <div className="agent-provider-models">
        <div className="agent-provider-models-head">
          <span>模型</span>
          <button
            className="btn btn-ghost small"
            onClick={() =>
              onPatch({ models: [...provider.models, newModel(provider.models.length)] })
            }
          >
            添加模型
          </button>
        </div>
        {provider.models.map((model, index) => (
          <ModelEditor
            key={`${model.id}-${index}`}
            provider={provider}
            model={model}
            onPatch={(patch) => patchModel(index, patch)}
            onRemove={() => onPatch({ models: provider.models.filter((_, i) => i !== index) })}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Agent / model: the catalog — several suppliers, each with several models,
 * each model with its own thinking levels (a JSON patch per level).
 *
 * The page edits a draft: patch text is kept as text until the save converts
 * and validates it, so a half-typed mapping never reaches the agent. The
 * default model is what a new session picks; an open session switches from
 * the composer's model chip.
 */
export function AgentModelTab({ mode }: { mode: AgentMode }) {
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CatalogDraft | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [subagents, setSubagents] = useState<{ id: string; name: string; description: string }[]>(
    [],
  );
  const showToast = useAppStore((s) => s.showToast);
  const bump = useAppStore((s) => s.bumpAgentConfigVersion);

  useEffect(() => {
    let cancelled = false;
    void agentApi
      .getConfig()
      .then((c) => {
        if (cancelled) return;
        setCfg(c);
        setDraft(toDraft(c));
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e).replace(/^[A-Z_]+:\s*/, ""));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void agentApi
      .listSubagents()
      .then((list) => {
        if (!cancelled) setSubagents(list);
      })
      .catch(() => {
        if (!cancelled) setSubagents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!draft || !cfg) return <AgentLoading loadError={loadError} />;

  const edit = (patch: Partial<CatalogDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const editProvider = (index: number, patch: Partial<ProviderDraft>) =>
    edit({
      providers: draft.providers.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    });
  const removeProvider = (index: number) =>
    edit({ providers: draft.providers.filter((_, i) => i !== index) });
  const editSubagent = (id: string | null, value: ModelSelection | null) => {
    if (id === null) {
      edit({ subagent_models: { ...draft.subagent_models, default: value } });
      return;
    }
    const by_definition = { ...draft.subagent_models.by_definition };
    if (value) by_definition[id] = value;
    else delete by_definition[id];
    edit({ subagent_models: { ...draft.subagent_models, by_definition } });
  };

  const save = async () => {
    const result = fromDraft(draft);
    if (!result.ok) {
      setErrors(result.errors);
      showToast("有未通过校验的档位映射,没有保存");
      return;
    }
    setErrors([]);
    try {
      await agentApi.saveConfig({ ...cfg, ...result.parts });
      bump();
      showToast("模型配置已保存;已开的会话不受影响,可在输入框底部切换");
    } catch (e) {
      showToast(`保存失败: ${String(e)}`);
    }
  };

  return (
    <div className="settings-section">
      <SettingsCard
        title="供应商"
        desc={`${MODE_LABEL[mode]}助手可用的模型目录,保存在笔记库的 .bnote/agent.json(未打开笔记库时退回 ~/.bnote),三种模式共用。每个供应商有自己的协议与密钥,每个模型有自己的上下文窗口、输出上限与思考档位。`}
        actions={
          <button
            className="btn btn-ghost small"
            onClick={() =>
              edit({ providers: [...draft.providers, newProvider(draft.providers.length)] })
            }
          >
            添加供应商
          </button>
        }
      >
        {draft.providers.length === 0 && (
          <div className="settings-empty">还没有供应商:点右上角「添加供应商」开始。</div>
        )}
        {draft.providers.map((provider, index) => (
          <ProviderEditor
            key={`${provider.id}-${index}`}
            provider={provider}
            onPatch={(patch) => editProvider(index, patch)}
            onRemove={() => removeProvider(index)}
          />
        ))}
      </SettingsCard>

      <SettingsCard
        title="默认模型"
        desc="新会话使用这个模型与思考强度;已开的会话用自己的,可在输入框底部的模型切换里改。"
      >
        <Row
          label="默认模型"
          desc="供应商 / 模型 / 思考强度"
          control={
            <SelectionControl
              draft={draft}
              value={draft.default_selection}
              onChange={(value) => edit({ default_selection: value })}
            />
          }
        />
      </SettingsCard>

      <SettingsCard
        title="子代理"
        desc="子代理默认继承主会话的模型。这里可以给全局或某个子代理单独指定:调用时显式给的 model 优先于它。"
      >
        <Row
          label="默认子代理模型"
          desc="继承主会话 = 子代理与主会话用同一个模型"
          control={
            <SelectionControl
              draft={draft}
              value={draft.subagent_models.default}
              inheritLabel="继承主会话"
              onChange={(value) => editSubagent(null, value)}
            />
          }
        />
        {subagents.map((agent) => (
          <Row
            key={agent.id}
            label={agent.name}
            desc={agent.description}
            control={
              <SelectionControl
                draft={draft}
                value={draft.subagent_models.by_definition[agent.id] ?? null}
                inheritLabel="继承默认"
                onChange={(value) => editSubagent(agent.id, value)}
              />
            }
          />
        ))}
      </SettingsCard>

      {errors.length > 0 && (
        <div className="settings-errors">
          {errors.map((error) => (
            <div key={error}>{error}</div>
          ))}
        </div>
      )}
      <div className="settings-footer">
        <button className="btn primary" onClick={() => void save()}>
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
              ,HTTP 形如{" "}
              <code>{'{"name":{"type":"http","url":"https://…","timeoutsMs":60000}}'}</code>
              (timeoutsMs 是单次请求超时,默认 60000)。
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
        desc="本模式的 settings.json、AGENTS.md、skills 与 output-styles 都放在这里;默认随仓库保存,改成任意绝对路径后该模式的文件整体迁到那里(会话记录仍在 .bnote)。"
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
            会话记录、tasks、plans 与记忆仍在笔记库的 <code>.bnote</code>
            (它们属于运行状态,不属于笔记)。
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
