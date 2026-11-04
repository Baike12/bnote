import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type FocusEvent as ReactFocusEvent } from "react";
import {
  agentApi,
  translateApi,
  type AgentConfig,
  type SkillInfo,
  type TranslateConfig,
} from "@/lib/tauri";
import { Modal } from "./Modal";
import { allCommands } from "@/commands/registry";
import {
  KEY_REGIONS,
  bindingsForCommand,
  commandBelongs,
  eventToKey,
  formatBinding,
  type KeyRegion,
} from "@/commands/keys";
import {
  clearOverride,
  getKeymapRevision,
  keybindingsFilePath,
  resetAllOverrides,
  setOverride,
  subscribeKeymap,
} from "@/commands/keybindingOverrides";
import { setHotkeyRecording } from "@/commands/globalKeys";
import { useAppStore, type ImeSettings, type QuickAddCommand } from "@/state/appStore";
import { openAccessibilitySettings, useFocusStore } from "@/focus/store";
import { MinutesInput } from "./MinutesInput";
import { isActive, MAX_FOCUS_DURATIONS } from "@/focus/timer";
import type { LatexConfig } from "@/editor/snippets/config";
import { api, type InputSourceInfo, type VaultConfigFile } from "@/lib/tauri";
import { inputGuards } from "@/lib/inputGuards";
import { FolderSuggest } from "@/components/FolderSuggest";
import { CodeArea } from "@/components/CodeArea";
import {
  normalizeTemplateDir,
  templateFiles,
  templateLabel,
} from "@/templates/template";
import { applySettingsToEditor, openVault, pickVaultDialog, reloadSnippetsFromVault } from "@/app/actions";
import { parseVimrc } from "@/editor/vim/vimrc";
import { MAX_PAGE_STEP, MIN_PAGE_STEP, normalizePageStep } from "@/study/reading";
import {
  MAX_TYPEWRITER_POSITION,
  MIN_TYPEWRITER_POSITION,
  normalizeTypewriterPosition,
} from "@/editor/typewriterPosition";

type Tab =
  | "general"
  | "editor"
  | "reading"
  | "focus"
  | "daily"
  | "templates"
  | "hotkeys"
  | "vim"
  | "snippets"
  | "ime"
  | "quickadd"
  | "translate"
  | "agent-model"
  | "agent-mcp"
  | "agent-skills"
  | "agent-instructions";

/** The navigation on the left is grouped by purpose (following the grouped sidebar of the ZCode settings page), rendered in SettingsModal. */
const NAV_GROUPS: { label: string; items: { id: Tab; label: string }[] }[] = [
  {
    label: "常规",
    items: [
      { id: "general", label: "通用" },
      { id: "editor", label: "编辑器" },
      { id: "reading", label: "阅读" },
      { id: "focus", label: "专注" },
    ],
  },
  {
    label: "笔记",
    items: [
      { id: "daily", label: "日记" },
      { id: "templates", label: "模板" },
    ],
  },
  {
    label: "输入与命令",
    items: [
      { id: "hotkeys", label: "快捷键" },
      { id: "vim", label: "Vim" },
      { id: "snippets", label: "公式片段" },
      { id: "ime", label: "输入法" },
      { id: "quickadd", label: "快速添加" },
    ],
  },
  {
    label: "学习",
    items: [{ id: "translate", label: "翻译" }],
  },
  {
    label: "Agent",
    items: [
      { id: "agent-model", label: "模型" },
      { id: "agent-mcp", label: "MCP" },
      { id: "agent-skills", label: "技能" },
      { id: "agent-instructions", label: "AGENTS.md" },
    ],
  },
];

const VIMRC_TEMPLATE = `\" bnote vimrc（加载顺序：全局 → 仓库 .bnote/vimrc）
\" 键序列映射（映射到按键）
imap jj <Esc>

\" 映射到 bnote 命令（命令 id 见快捷键设置页）
nmap <C-s> :w<CR>
nmap <C-b> :Bnote nav.toggle-sidebar<CR>

\" 支持 :w / :wq / :q / :noh 以及 :Bnote <命令id>
`;

const SNIPPETS_TEMPLATE = `// 仓库级 LaTeX 片段（.bnote/snippets.js），保存后立即生效。
// 格式与 obsidian-latex-suite 兼容；导出空数组可禁用全部内置片段。
export default [
  // { trigger: "al", replacement: "\\alpha", options: "mA" },
]
`;

/** The placeholder text of the AGENTS.md input field (a placeholder only, it is not written into the file). */
const AGENTS_MD_TEMPLATE = `<!-- .bnote/AGENTS.md — 学习助手与创作模式的自定义指令。
     保存在当前仓库,随会话启动加载;内置的通用要求(简洁、结论先行、
     组块化)始终生效,这里的指令在其后追加。留空 = 只用通用要求。
     例如:优先用表格对比易混概念;创作时先给提纲再动笔。 -->`;

export function SettingsModal() {
  const open = useAppStore((s) => s.modal === "settings");
  const setModal = useAppStore((s) => s.setModal);
  const [tab, setTab] = useState<Tab>("general");
  if (!open) return null;

  return (
    <Modal open={open} onClose={() => setModal(null)} width={940}>
      <div className="settings">
        <aside className="settings-nav">
          <div className="settings-nav-title">设置</div>
          {NAV_GROUPS.map((group) => (
            <div className="settings-nav-group" key={group.label}>
              <div className="settings-nav-group-label">{group.label}</div>
              {group.items.map((t) => (
                <button
                  key={t.id}
                  className={`settings-nav-item${tab === t.id ? " active" : ""}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </aside>
        <div className="settings-content">
          {tab === "general" && <GeneralTab />}
          {tab === "editor" && <EditorTab />}
          {tab === "reading" && <ReadingTab />}
          {tab === "focus" && <FocusTab />}
          {tab === "daily" && <DailyTab />}
          {tab === "templates" && <TemplatesTab />}
          {tab === "hotkeys" && <HotkeysTab />}
          {tab === "vim" && <VimTab />}
          {tab === "snippets" && <SnippetsTab />}
          {tab === "ime" && <ImeTab />}
          {tab === "quickadd" && <QuickAddTab />}
          {tab === "translate" && <TranslateTab />}
          {tab === "agent-model" && <AgentModelTab />}
          {tab === "agent-mcp" && <AgentMcpTab />}
          {tab === "agent-skills" && <AgentSkillsTab />}
          {tab === "agent-instructions" && <AgentInstructionsTab />}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The two skeleton pieces of the settings page (following ZCode's
// SettingsGroupCard / SettingsRow): grouping into cards plus a row layout
// (label and description on the left, the control on the right).
// ---------------------------------------------------------------------------

function SettingsCard({
  title,
  desc,
  actions,
  children,
}: {
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-card">
      {(title != null || actions != null) && (
        <header className="settings-card-head">
          <div className="settings-card-head-text">
            <div className="settings-card-title">{title}</div>
            {desc && <div className="settings-card-desc">{desc}</div>}
          </div>
          {actions != null && <div className="settings-card-actions">{actions}</div>}
        </header>
      )}
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

function Row({
  label,
  desc,
  control,
}: {
  label: ReactNode;
  desc?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <div className="setting-label">{label}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      {control != null && <div className="setting-control">{control}</div>}
    </div>
  );
}

/**
 * The dropdown of the settings page. The native select of WKWebView paints a
 * system gradient and the stepper arrows, which does not look like the flat
 * inputs of the page; here the native appearance is stripped
 * (-webkit-appearance: none) and the arrow is drawn in CSS, so the closed
 * state looks exactly like a .settings-input. What pops up on a click is
 * still the system menu (better native usability, no second list to build).
 */
function SettingsSelect<T extends string>({
  value,
  onChange,
  children,
}: {
  value: T;
  onChange: (v: T) => void;
  children: ReactNode;
}) {
  return (
    <span className="settings-select-wrap">
      <select
        className="settings-select"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {children}
      </select>
    </span>
  );
}

/** A slider plus a right aligned value (the layout of ZCode's SettingsRangeControl). */
function RangeControl({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <div className="range-control">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="range-value">{format ? format(value) : value}</span>
    </div>
  );
}

function Toggle({
  label,
  desc,
  checked,
  onChange,
  disabled = false,
}: {
  label: ReactNode;
  desc?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row
      // The text is clickable too: a toggle is only a small dot, so users
      // will most likely click the line of text, and a click that does
      // nothing is taken for "broken" instead of "clicked the wrong spot".
      label={
        <button className="toggle-label" disabled={disabled} onClick={() => onChange(!checked)}>
          {label}
        </button>
      }
      desc={desc}
      control={
        <button
          className={`toggle${checked ? " on" : ""}`}
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onChange(!checked)}
        >
          <span className="toggle-knob" />
        </button>
      }
    />
  );
}

function GeneralTab() {
  const vaultPath = useAppStore((s) => s.vaultPath);
  const vaultName = useAppStore((s) => s.vaultName);
  const settings = useAppStore((s) => s.settings);
  return (
    <div className="settings-section">
      <SettingsCard title="仓库">
        <Row
          label="当前仓库"
          desc={vaultPath ?? "未打开"}
          control={
            <button className="btn" onClick={() => void openVaultFlow()}>
              打开其他仓库
            </button>
          }
        />
        <Row
          label="仓库名"
          control={<span className="setting-value">{vaultName}</span>}
        />
      </SettingsCard>
      <SettingsCard title="片段引擎">
        <Toggle
          label="启用 LaTeX 片段"
          desc="输入触发串后按 Tab 展开（如 // → \\frac{}{}），或使用 A 选项的自动片段"
          checked={settings.snippets}
          onChange={(v) => useAppStore.getState().patchSettings({ snippets: v })}
        />
      </SettingsCard>
      <p className="setting-hint">
        试试在公式里输入 <code>aa</code>、<code>sr</code>、<code>{"//"}</code>（自动展开），或 <code>dm</code>、<code>beg</code>、<code>al</code> + Tab。
      </p>
    </div>
  );
}

async function openVaultFlow() {
  const path = await pickVaultDialog();
  if (path) await openVault(path);
}

function EditorTab() {
  const settings = useAppStore((s) => s.settings);
  const patch = useAppStore((s) => s.patchSettings);
  const positionPercent = Math.round(
    normalizeTypewriterPosition(settings.typewriterPosition) * 100,
  );
  return (
    <div className="settings-section">
      <SettingsCard title="编辑行为">
        <Toggle
          label="实时渲染（Live Preview）"
          desc="标题、粗体、公式、代码块等在非编辑区域直接渲染；当前行保持源码"
          checked={settings.livePreview}
          onChange={(v) => patch({ livePreview: v })}
        />
        <Toggle
          label="公式实时预览"
          desc="光标在块公式（$$…$$）内编辑时，保留源码并在下方实时显示渲染结果；行内公式编辑时只显示源码"
          checked={settings.mathPreview}
          onChange={(v) => patch({ mathPreview: v })}
        />
        <Toggle
          label="自动保存"
          desc="停止输入约 0.8 秒后自动保存（Cmd+S 始终可用）"
          checked={settings.autoSave}
          onChange={(v) => patch({ autoSave: v })}
        />
        <Toggle
          label="标题自动编号"
          desc="用 ⌘1–⌘6 设置标题时自动按层级编号（1 / 1.1 / 1.1.2），并重排全文已有编号"
          checked={settings.autoNumberHeadings}
          onChange={(v) => patch({ autoNumberHeadings: v })}
        />
        <Toggle
          label="打字机模式"
          desc="光标所在行始终停在屏幕的固定高度（下方可调）"
          checked={settings.typewriter}
          onChange={(v) => patch({ typewriter: v })}
        />
        <Row
          label="打字机位置"
          desc={`光标行停在屏幕高度的 ${positionPercent}%：50% 垂直居中，越小越靠上（下方留出更多待读内容），越大越靠下。上方留白与下方留白互补，首行和末行也停在同一个高度。`}
          control={
            <RangeControl
              value={positionPercent}
              min={Math.round(MIN_TYPEWRITER_POSITION * 100)}
              max={Math.round(MAX_TYPEWRITER_POSITION * 100)}
              step={1}
              onChange={(v) => patch({ typewriterPosition: v / 100 })}
              format={(v) => `${v}%`}
            />
          }
        />
        <Toggle
          label="Vim 模式"
          desc="原生 vim 键位 + vimrc 配置（见 Vim 标签页）"
          checked={settings.vim}
          onChange={(v) => patch({ vim: v })}
        />
        <Toggle
          label="代码编辑器 Vim 模式"
          desc="代码编辑器里单独开 vim。与笔记的开关分开：两边的手感常常不同，各开各的更贴近真实工作流。快捷键也各归各的代码区/笔记区，互不干扰。"
          checked={settings.codeVim}
          onChange={(v) => patch({ codeVim: v })}
        />
        <Toggle
          label="代码编辑器折行"
          desc="中栏不宽（展开文件树后更窄），长行默认折着看。要按列对齐的文件可以关掉；代码区里按 ⌥Z 临时切换。"
          checked={settings.codeWrap}
          onChange={(v) => patch({ codeWrap: v })}
        />
        <Row
          label="代码块语言"
          desc="「插入代码块」（默认 ⌘⇧C）在开栏预填的语言标识，如 ts、python；留空则插入不带语言的代码块"
          control={
            <input
              className="settings-input"
              value={settings.codeBlockLang}
              onChange={(e) => patch({ codeBlockLang: e.target.value })}
              placeholder="ts"
              {...inputGuards}
            />
          }
        />
      </SettingsCard>
      <CodeLspSettingsCard />
      <SettingsCard title="外观">
        <Row
          label="主题"
          desc="深色 / 浅色整套界面配色（含编辑器语法高亮），立即生效"
          control={
            <>
              <button
                className={`chip${settings.theme === "dark" ? " active" : ""}`}
                onClick={() => patch({ theme: "dark" })}
              >
                深色
              </button>
              <button
                className={`chip${settings.theme === "light" ? " active" : ""}`}
                onClick={() => patch({ theme: "light" })}
              >
                浅色
              </button>
            </>
          }
        />
        <Row
          label="编辑区字号"
          control={
            <RangeControl
              value={settings.fontSize}
              min={12}
              max={28}
              onChange={(v) => patch({ fontSize: v })}
              format={(v) => `${v}px`}
            />
          }
        />
      </SettingsCard>
    </div>
  );
}

function ReadingTab() {
  const step = normalizePageStep(useAppStore((s) => s.settings.studyPageStep));
  const patch = useAppStore((s) => s.patchSettings);
  const percent = Math.round(step * 100);
  return (
    <div className="settings-section">
      <SettingsCard title="学习模式翻页">
        <Row
          label="每次翻页的步长"
          desc={`PageUp / PageDown 及绑定的快捷键，每次移动可见高度的 ${percent}%（默认 50%：翻页后上一屏的下半部分停在屏幕中央，新内容从下半屏进入）。`}
          control={
            <RangeControl
              value={percent}
              min={Math.round(MIN_PAGE_STEP * 100)}
              max={Math.round(MAX_PAGE_STEP * 100)}
              step={5}
              onChange={(v) => patch({ studyPageStep: v / 100 })}
              format={(v) => `${v}%`}
            />
          }
        />
      </SettingsCard>
      <p className="setting-hint">
        屏幕下方是刚进入的新内容（占可见高度的 {percent}%）；上方是刚读过、
        正在移出的内容（占 {100 - percent}%），压暗后向边界渐隐，不画分界线，
        两端保留阴影的圆角尖。两层只做视觉分区，不影响选中、批注和点击；
        翻页落点会在 2% 视口内微调，避免边界切在文字行中间。
      </p>
    </div>
  );
}

/**
 * Focus: the durations the status bar offers plus the explanation and the
 * authorization state of the two locks.
 *
 * The durations live in the timer state of focus/store (part of the timer state,
 * persisted with it) and are not stored a second time in the settings: with two
 * copies they will eventually disagree. Editing the list never touches a running
 * stretch - its length was fixed into `endsAt` when it started.
 *
 * The locks have no switch: starting a focus session means the screen
 * takeover, the hard lock and the timer all take effect, and there is no way
 * out in between. So only the state is shown here, and no control that
 * could interrupt the session is offered.
 */
function FocusTab() {
  const timer = useFocusStore((s) => s.timer);
  const setDurations = useFocusStore((s) => s.setDurations);
  const trusted = useFocusStore((s) => s.trusted);
  const hardLock = useFocusStore((s) => s.hardLock);
  const hardActive = useFocusStore((s) => s.hardActive);
  const pendingHardLock = useFocusStore((s) => s.pendingHardLock);
  const error = useFocusStore((s) => s.error);
  const refreshStatus = useFocusStore((s) => s.refreshStatus);
  const active = isActive(timer);

  // The native state is read once again when this page is opened: the accessibility permission may have just been granted in the system settings.
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const hardText = hardActive
    ? "拦截中"
    : pendingHardLock
      ? "等待授权"
      : hardLock
        ? "已武装(开始专注时拦截)"
        : trusted
          ? "开始专注时自动武装"
          : "未授权";

  return (
    <div className="settings-section">
      <SettingsCard title="番茄钟">
        <Row
          label="可选时长"
          desc="状态栏左下角按这里列出的时长各显示一个可点的按钮"
          control={
            <DurationList
              durations={timer.config.focusDurations}
              onChange={(focusDurations) => setDurations({ focusDurations })}
            />
          }
        />
        <div className="setting-hint">
          {active
            ? "本次专注进行中:不能暂停、不能提前结束。改时长只影响下一段。"
            : "点状态栏左下角的时间开始对应时长的专注。开始后独占屏幕与硬锁同时生效,到点才解锁;最多三个时长,相同的时间只保留一个。"}
        </div>
      </SettingsCard>

      <SettingsCard title="专注锁">
        <Row label="独占屏幕" control={<span className="setting-value">专注期间始终开启</span>} />
        <Row label="硬锁" control={<span className="setting-value">{hardText}</span>} />
        <Row
          label="辅助功能"
          control={
            trusted && !pendingHardLock ? (
              <span className="setting-value">已授权</span>
            ) : (
              <button className="link-btn" onClick={() => void openAccessibilitySettings()}>
                {pendingHardLock ? "等待授权 · 去设置" : "去授权"}
              </button>
            )
          }
        />
        {error && !pendingHardLock && <div className="setting-error">{error}</div>}
      </SettingsCard>
    </div>
  );
}

/**
 * The durations the status bar offers: one input per entry, one to three in
 * total.
 *
 * Every edit commits the whole list: the timer state is the single owner, and
 * `normalizeConfig` drops duplicates and caps the length, so this control cannot
 * produce a list the status bar is unable to render.
 */
function DurationList({
  durations,
  onChange,
}: {
  durations: number[];
  onChange: (durations: number[]) => void;
}) {
  return (
    <div className="setting-durations">
      {durations.map((minutes, index) => (
        <span className="setting-duration" key={index}>
          <MinutesInput
            className="settings-input mono"
            value={minutes}
            onChange={(next) => onChange(durations.map((m, i) => (i === index ? next : m)))}
          />
          {durations.length > 1 && (
            <button
              type="button"
              className="setting-duration-remove"
              title="删除这个时长"
              onClick={() => onChange(durations.filter((_, i) => i !== index))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {durations.length < MAX_FOCUS_DURATIONS && (
        <button
          type="button"
          className="link-btn"
          title="再加一个可选时长"
          onClick={() => onChange([...durations, suggestedDuration(durations)])}
        >
          + 添加
        </button>
      )}
    </div>
  );
}

/** A duration that is not in the list yet, so a new row always yields a new chip. */
function suggestedDuration(durations: number[]): number {
  for (const candidate of [25, 45, 50, 60, 90]) {
    if (!durations.includes(candidate)) return candidate;
  }
  return Math.min(180, Math.max(...durations) + 30);
}

type HotkeyFilter = "all" | "assigned" | "unassigned";

function HotkeysTab() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HotkeyFilter>("all");
  const [region, setRegion] = useState<KeyRegion>("global");
  const [capturing, setCapturing] = useState<string | null>(null);
  const commands = useMemo(() => allCommands(), []);
  const showToast = useAppStore((s) => s.showToast);
  const vaultPath = useAppStore((s) => s.vaultPath);
  // The override table is module state shared by the command layer and the
  // execution layer (it is not React state). Its revision is subscribed to:
  // after unbinding, resetting or an external file change the list is
  // redrawn; before, reading the module variable did not re-render and that
  // is where the "the X does nothing" came from.
  useSyncExternalStore(subscribeKeymap, getKeymapRevision, getKeymapRevision);

  useEffect(() => {
    if (!capturing) return;
    setHotkeyRecording(true);
    const handler = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      const key = eventToKey(e);
      if (!key) return; // lone modifier
      // Only a conflict inside the same region has to be handled: different
      // regions may share the same key, a region binding overrides the
      // generic one.
      const conflict = commands.find(
        (c) =>
          c.id !== capturing &&
          commandBelongs(c.id, region) &&
          bindingsForCommand(c.id, region).includes(key),
      );
      if (conflict) {
        await setOverride(conflict.id, null, region);
        showToast(`与「${conflict.title}」冲突，已移除其原绑定`);
      }
      await setOverride(capturing, key, region);
      setCapturing(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => {
      setHotkeyRecording(false);
      window.removeEventListener("keydown", handler, true);
    };
  }, [capturing, commands, region, showToast]);

  const rows = commands.filter((c) => {
    if (!commandBelongs(c.id, region)) return false;
    if (query && !`${c.category}${c.title}`.toLowerCase().includes(query.toLowerCase())) {
      return false;
    }
    const bound = bindingsForCommand(c.id, region).length > 0;
    if (filter === "assigned") return bound;
    if (filter === "unassigned") return !bound;
    return true;
  });

  const regionInfo = KEY_REGIONS.find((r) => r.id === region);
  const configPath = keybindingsFilePath(vaultPath);

  return (
    <div className="settings-section">
      {/* The region picker comes first: the three focusable regions each have their own set of keybindings. */}
      <div className="chip-row">
        {KEY_REGIONS.map((r) => (
          <button
            key={r.id}
            className={`chip${region === r.id ? " active" : ""}`}
            onClick={() => {
              setRegion(r.id);
              setCapturing(null);
            }}
          >
            {r.label}
          </button>
        ))}
      </div>
      <p className="setting-hint">
        {regionInfo?.hint} 配置文件：{configPath ?? "未打开仓库，暂存到应用配置"}
      </p>
      <input
        className="settings-search"
        placeholder="搜索命令…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        {...inputGuards}
      />
      <div className="chip-row">
        {(
          [
            ["all", "全部"],
            ["assigned", "已分配"],
            ["unassigned", "未分配"],
          ] as [HotkeyFilter, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className={`chip${filter === id ? " active" : ""}`}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
        <span className="spacer" />
        <button
          className="btn btn-ghost"
          onClick={() => {
            void resetAllOverrides().then(() => showToast("已恢复默认快捷键"));
          }}
        >
          全部恢复默认
        </button>
      </div>
      <SettingsCard title={`${regionInfo?.label ?? ""}快捷键（${rows.length}）`}>
        <div className="hotkey-list">
          {rows.map((cmd) => {
            const bindings = bindingsForCommand(cmd.id, region);
            const isCapturing = capturing === cmd.id;
            return (
              <div
                key={cmd.id}
                className={`hotkey-row${isCapturing ? " capturing" : ""}`}
                onClick={() => setCapturing(cmd.id)}
              >
                <span className="hotkey-title">{cmd.title}</span>
                <span className="hotkey-actions">
                  {bindings.length > 0 ? (
                    <button
                      className="hotkey-unbind"
                      title="解绑"
                      onClick={(e) => {
                        e.stopPropagation();
                        void setOverride(cmd.id, null, region);
                      }}
                    >
                      ✕
                    </button>
                  ) : (
                    <span className="hotkey-unbound">未设置</span>
                  )}
                  {bindings.map((b) => (
                    <kbd key={b} className="hotkey-chip">
                      {formatBinding(b)}
                    </kbd>
                  ))}
                  <button
                    className="hotkey-reset"
                    title="恢复默认"
                    onClick={(e) => {
                      e.stopPropagation();
                      void clearOverride(cmd.id, region);
                    }}
                  >
                    ↺
                  </button>
                </span>
                {isCapturing && <span className="hotkey-capture-hint">按下新快捷键…（Esc 取消）</span>}
              </div>
            );
          })}
        </div>
      </SettingsCard>
    </div>
  );
}

function VimTab() {
  const settings = useAppStore((s) => s.settings);
  const patch = useAppStore((s) => s.patchSettings);
  const showToast = useAppStore((s) => s.showToast);
  const [vimrc, setVimrc] = useState<string>(VIMRC_TEMPLATE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api.readVimrc().then((v) => {
      setVimrc(v ?? VIMRC_TEMPLATE);
      setLoaded(true);
    });
  }, []);

  // Validation runs live and an unrecognized line is marked right away,
  // otherwise a mistyped command only fails silently (vim would report
  // E492, here it is only a console warning the user never sees in the
  // app).
  const vimrcErrors = useMemo(() => parseVimrc(vimrc).errors, [vimrc]);

  return (
    <div className="settings-section">
      <SettingsCard title="Vim 模式">
        <Toggle
          label="启用 Vim 模式"
          desc="normal / insert / visual 模式，支持 vimrc 映射与 :w / :wq / :q / :noh / :Bnote <命令id>"
          checked={settings.vim}
          onChange={(v) => patch({ vim: v })}
        />
      </SettingsCard>
      <SettingsCard
        title="全局 vimrc"
        desc={
          <>
            另可在仓库内放置 <code>.bnote/vimrc</code>，其映射会叠加在全局配置之上。
            裸 <code>map</code> / <code>noremap</code> 与 vim 一致，同时作用于 normal 和 visual 模式。
          </>
        }
      >
        <div className="settings-block">
          <textarea
            className="settings-textarea"
            spellCheck={false}
            value={vimrc}
            onChange={(e) => setVimrc(e.target.value)}
            rows={14}
          />
          {vimrcErrors.length > 0 && (
            <div className="setting-errors">
              <p>{vimrcErrors.length} 行未被识别（已跳过，其余配置正常生效）：</p>
              <ul>
                {vimrcErrors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="settings-actions">
            <button
              className="btn"
              disabled={!loaded}
              onClick={() => {
                void api
                  .saveVimrc(vimrc)
                  .then(() => applySettingsToEditor())
                  .then(() =>
                    showToast(
                      vimrcErrors.length > 0
                        ? `vimrc 已保存，${vimrcErrors.length} 行未被识别`
                        : "vimrc 已保存并生效",
                    ),
                  );
              }}
            >
              保存并应用
            </button>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}

function SnippetsTab() {
  const showToast = useAppStore((s) => s.showToast);
  const settings = useAppStore((s) => s.settings);
  const patch = useAppStore((s) => s.patchSettings);
  const [content, setContent] = useState<string>(SNIPPETS_TEMPLATE);
  const [dirtyLocal, setDirtyLocal] = useState(false);
  const patchLatex = (p: Partial<LatexConfig>) =>
    patch({ latex: { ...settings.latex, ...p } });

  useEffect(() => {
    void api.readVaultFile("snippets.js" as VaultConfigFile).then((v) => {
      setContent(v ?? SNIPPETS_TEMPLATE);
    });
  }, []);

  return (
    <div className="settings-section">
      <SettingsCard
        title="仓库级 LaTeX 片段(.bnote/snippets.js)"
        desc={
          <>
            片段格式与 <code>obsidian-latex-suite</code> 兼容：
            <code>{"{ trigger, replacement, options }"}</code>，占位符 <code>$0</code>
            <code>${"{n:默认文本}"}</code>，正则捕获组 <code>{"[[0]]"}</code>，选项
            <code>m/n/M/t/T/c/C</code> + <code>A</code>自动 <code>r</code>正则 <code>w</code>词边界。
          </>
        }
      >
        <div className="settings-block">
          <CodeArea
            value={content}
            searchPlaceholder="搜索片段（trigger / replacement）"
            onChange={(next) => {
              setContent(next);
              setDirtyLocal(true);
            }}
          />
          <div className="settings-actions">
            <button
              className="btn btn-ghost"
              onClick={() =>
                void api
                  .writeVaultFile("snippets.js", "")
                  .then(() => reloadSnippetsFromVault())
                  .then(() => {
                    setContent(SNIPPETS_TEMPLATE);
                    setDirtyLocal(false);
                    showToast("已恢复内置片段");
                  })
              }
            >
              恢复内置片段
            </button>
            <button
              className="btn"
              disabled={!dirtyLocal}
              onClick={() =>
                void api
                  .writeVaultFile("snippets.js", content)
                  .then(() => reloadSnippetsFromVault())
                  .then((outcome) => {
                    setDirtyLocal(false);
                    // The load result is reported faithfully: before, even
                    // when the dynamic import failed and the built-in set
                    // was used, this always claimed "saved and in
                    // effect".
                    if (!outcome) {
                      showToast("片段已保存，但没有打开仓库，无法加载");
                    } else if (outcome.status === "error") {
                      showToast(`片段保存失败: ${outcome.error}`);
                    } else if (outcome.status === "builtin") {
                      showToast("片段已保存，当前使用内置片段");
                    } else {
                      showToast(`片段已保存并生效，共 ${outcome.count} 条`);
                    }
                  })
              }
            >
              保存并应用
            </button>
          </div>
        </div>
      </SettingsCard>
      <SettingsCard
        title="LaTeX Suite 行为"
        desc="以下能力逐项对齐 obsidian-latex-suite，开关名与其设置项同名。"
      >
        <Toggle
          label="自动放大括号"
          desc="括号里出现 \\sum、\\frac 等大符号时，自动改成 \\left(…\\right)（片段展开或自动分数之后判断）"
          checked={settings.latex.autoEnlargeBrackets}
          onChange={(v) => patchLatex({ autoEnlargeBrackets: v })}
        />
        <Toggle
          label="矩阵快捷"
          desc="矩阵环境里 Shift+Tab 插入 &（对齐下一列）、Enter 插入换行符继续下一行；普通 Tab 留给下面的「Tab 跳出括号」"
          checked={settings.latex.matrixShortcuts}
          onChange={(v) => patchLatex({ matrixShortcuts: v })}
        />
        <Toggle
          label="Tab 跳出括号"
          desc="片段与制表位走完后，Tab 把光标从括号里带出来：一次跨一层右括号 / \rangle，已经在公式末尾则跳到行内 $ 之后或块级 $$ 的下一行"
          checked={settings.latex.tabout}
          onChange={(v) => patchLatex({ tabout: v })}
        />
        <Toggle
          label="括号彩色配对"
          desc="公式里的括号按嵌套深度轮转三种颜色（最外层固定第一色）"
          checked={settings.latex.bracketColors}
          onChange={(v) => patchLatex({ bracketColors: v })}
        />
        <Toggle
          label="光标括号高亮"
          desc="光标贴着的括号与它配对的那个一起高亮；光标不在括号上时高亮最内层包围括号"
          checked={settings.latex.highlightCursorBrackets}
          onChange={(v) => patchLatex({ highlightCursorBrackets: v })}
        />
        <Toggle
          label="一次删掉一对 $"
          desc="光标正好夹在两个 $ 之间时按退格，两个 $ 一起删（空公式的常态）"
          checked={settings.latex.autoDeleteDollar}
          onChange={(v) => patchLatex({ autoDeleteDollar: v })}
        />
        <Toggle
          label="行内公式去多余空格"
          desc="在 $…$ 里展开片段后去掉尾部空格，避免 KaTeX 吃掉空格但源码难看"
          checked={settings.latex.removeSnippetWhitespace}
          onChange={(v) => patchLatex({ removeSnippetWhitespace: v })}
        />
        <Row
          label="词边界字符"
          desc={
            <>
              带 <code>w</code> 选项的片段要求触发串前后都是这里的字符；换行写 <code>\n</code>
            </>
          }
          control={
            <input
              className="settings-input mono"
              value={settings.latex.wordDelimiters}
              spellCheck={false}
              onChange={(e) => patchLatex({ wordDelimiters: e.target.value })}
            />
          }
        />
      </SettingsCard>
    </div>
  );
}

function ImeTab() {
  const settings = useAppStore((s) => s.settings);
  const patch = useAppStore((s) => s.patchSettings);
  const [sources, setSources] = useState<InputSourceInfo[] | null>(null);

  useEffect(() => {
    void api
      .listInputSources()
      .then(setSources)
      .catch(() => setSources([]));
  }, []);

  const ime = settings.ime;
  const patchIme = (p: Partial<ImeSettings>) =>
    patch({ ime: { ...ime, ...p } });

  const renderPicker = (key: "insertSource" | "normalSource", label: string, desc: string) => (
    <Row
      label={label}
      desc={desc}
      control={
        <SettingsSelect
          value={ime[key]}
          onChange={(v) => patchIme({ [key]: v })}
        >
          {sources === null && <option value={ime[key]}>{ime[key]}</option>}
          {(sources ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}（{s.id}）
            </option>
          ))}
        </SettingsSelect>
      }
    />
  );

  return (
    <div className="settings-section">
      <SettingsCard title="输入法跟随 Vim 模式">
        <Toggle
          label="启用"
          desc="总开关:跟随 Vim 模式切换(insert 中文 / normal 英文)以及学习助手、批注输入框聚焦切中文都由它控制；打开快速切换器时也切到英文，关闭后还原（仅 macOS）"
          checked={ime.enabled}
          onChange={(v) => patchIme({ enabled: v })}
        />
        <Toggle
          label="中文输入框聚焦切中文"
          desc="聚焦学习助手输入框、PDF 批注框、快速待办弹窗等只写中文的输入框时自动切到上面的 insert 输入法；快速待办关闭（Enter 添加 / Esc 取消）后恢复打开前的输入法。关闭后保持当前输入法"
          checked={ime.chineseFields}
          onChange={(v) => patchIme({ chineseFields: v })}
        />
        {renderPicker("insertSource", "insert 模式输入法", "写中文笔记用的输入法")}
        {renderPicker("normalSource", "normal / visual 模式输入法", "一般选英文键盘（ABC）")}
      </SettingsCard>
      <p className="setting-hint">
        通过系统输入法框架（TIS）在应用内直接切换，无进程启动、不抢焦点，通常 1–5ms；
        macOS 26 上偶发的切换竞态会自动重试，仍失败时回退到 macism 命令行并提示。
      </p>
      <SettingsCard title="免切换场景" desc="这些场景内容是英文，切回中文反而添乱。">
        <Toggle
          label="公式内进入 insert 保持英文"
          desc="光标位于 $…$ 或 $$…$$ 内时不切中文，避免输入法干扰公式输入"
          checked={ime.mathKeepsEnglish}
          onChange={(v) => patchIme({ mathKeepsEnglish: v })}
        />
        <Toggle
          label="代码块内进入 insert 保持英文"
          desc="光标位于 ``` 围栏代码块内时不切中文，代码内容是 ASCII，避免输入法干扰"
          checked={ime.codeKeepsEnglish}
          onChange={(v) => patchIme({ codeKeepsEnglish: v })}
        />
      </SettingsCard>
    </div>
  );
}

/** The template dropdown: the files of the template directory plus "no template". The selected template is kept as an entry even when it is not in the current directory, otherwise switching the directory would silently clear the template an existing command points at. */
function TemplateSelect({
  value,
  files,
  dir,
  onChange,
}: {
  value: string;
  files: string[];
  dir: string;
  onChange: (template: string) => void;
}) {
  return (
    <SettingsSelect value={value} onChange={onChange}>
      <option value="">无模板</option>
      {files.map((file) => (
        <option key={file} value={file}>
          {templateLabel(file, dir)}
        </option>
      ))}
      {value !== "" && !files.includes(value) && (
        <option value={value}>{value}（不在当前模板目录）</option>
      )}
    </SettingsSelect>
  );
}

/** The rules of the template body (the daily note page and the template page share the same wording). */
function TemplateHint() {
  return (
    <p className="setting-hint">
      模板是普通笔记文件，内容会原样写进新文件：<code>{"{{date}}"}</code> 换成当天日期（YYYY-MM-DD），
      <code>{"{{title}}"}</code> 换成新文件名（日记里是日期），其它文字照抄。改完模板文件，下次创建立即生效。
    </p>
  );
}

function QuickAddTab() {
  const quickAdd = useAppStore((s) => s.settings.quickAdd);
  const templatesDir = useAppStore((s) => s.settings.templatesDir);
  const flatFiles = useAppStore((s) => s.flatFiles);
  const patch = useAppStore((s) => s.patchSettings);
  const templates = useMemo(
    () => templateFiles(flatFiles, templatesDir),
    [flatFiles, templatesDir],
  );

  const update = (i: number, p: Partial<QuickAddCommand>) =>
    patch({ quickAdd: quickAdd.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const remove = (i: number) => patch({ quickAdd: quickAdd.filter((_, j) => j !== i) });
  const add = () =>
    patch({ quickAdd: [...quickAdd, { name: "", folder: "", template: "" }] });

  return (
    <div className="settings-section">
      <SettingsCard
        title="快速添加命令"
        desc={
          <>
            触发「快速添加文件」（默认 ⌘⇧A，可在快捷键页修改）后搜索命令，选中并输入文件名即可在目标文件夹创建笔记；
            文件夹不存在时会在仓库根目录自动创建，支持 <code>a/b</code> 子路径。改动即时保存。
          </>
        }
      >
        <div className="settings-block">
          {quickAdd.map((c, i) => (
            <div className="qa-item" key={i}>
              <div className="qa-row">
                <input
                  className="settings-input"
                  placeholder="命令名，如 add bnote file"
                  value={c.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  {...inputGuards}
                />
                <FolderSuggest
                  className="settings-input mono"
                  placeholder="目标文件夹，如 bnote 或 notes/收集箱"
                  value={c.folder}
                  onChange={(folder) => update(i, { folder })}
                />
                <button className="btn btn-ghost qa-remove" title="删除命令" onClick={() => remove(i)}>
                  ✕
                </button>
              </div>
              <div className="qa-row qa-template-row">
                <span className="qa-template-label">模板</span>
                <TemplateSelect
                  value={c.template ?? ""}
                  files={templates}
                  dir={templatesDir}
                  onChange={(template) => update(i, { template })}
                />
              </div>
            </div>
          ))}
          {quickAdd.length === 0 && (
            <div className="qa-empty">还没有命令，点击下方按钮添加一个（如 add bnote file → bnote）。</div>
          )}
          <div className="settings-actions">
            <button className="btn" onClick={add}>
              添加命令
            </button>
          </div>
        </div>
      </SettingsCard>
      {templates.length === 0 && (
        <p className="setting-hint">
          模板下拉是空的：先到「模板」页设置模板目录（模板目录里的笔记才会出现在这里）。
        </p>
      )}
    </div>
  );
}

function DailyTab() {
  const daily = useAppStore((s) => s.settings.daily);
  const templatesDir = useAppStore((s) => s.settings.templatesDir);
  const flatFiles = useAppStore((s) => s.flatFiles);
  const patch = useAppStore((s) => s.patchSettings);
  const templates = useMemo(
    () => templateFiles(flatFiles, templatesDir),
    [flatFiles, templatesDir],
  );

  return (
    <div className="settings-section">
      <SettingsCard
        title="日记模板"
        desc="新建日记时用这份模板生成初始内容（⌘⇧O 打开今日日记、快速待办、项目发送、日记栏四个入口共用）；不选则默认以「# 日期」开篇。"
      >
        <Row
          label="模板文件"
          desc={
            templates.length > 0
              ? "模板来自「模板」页设置的目录。日记的待办区紧跟在首个 H1 之后；模板没有 H1 时待办顶到文件最前。"
              : "还没有可用模板：先到「模板」页设置模板目录并放入模板笔记。"
          }
          control={
            <TemplateSelect
              value={daily.template}
              files={templates}
              dir={templatesDir}
              onChange={(template) => patch({ daily: { ...daily, template } })}
            />
          }
        />
      </SettingsCard>
      <TemplateHint />
    </div>
  );
}

function TemplatesTab() {
  const dir = useAppStore((s) => s.settings.templatesDir);
  const flatFiles = useAppStore((s) => s.flatFiles);
  const patch = useAppStore((s) => s.patchSettings);
  const templates = useMemo(() => templateFiles(flatFiles, dir), [flatFiles, dir]);

  return (
    <div className="settings-section">
      <SettingsCard
        title="模板目录"
        desc="快速添加命令与日记都可以选用这个目录里的文件作为模板（含子目录）。目录不存在时先选择一个已有文件夹。"
      >
        <div className="settings-block">
          <FolderSuggest
            className="settings-input mono"
            placeholder="模板文件夹，如 Templates"
            value={dir}
            onChange={(templatesDir) => patch({ templatesDir })}
          />
          <div className="qa-empty">
            {normalizeTemplateDir(dir)
              ? templates.length > 0
                ? `找到 ${templates.length} 个模板`
                : "目录里还没有笔记文件"
              : "还没有设置模板目录"}
          </div>
        </div>
      </SettingsCard>
      {templates.length > 0 && (
        <SettingsCard title="可用模板">
          <div className="settings-block">
            {templates.map((file) => (
              <div className="setting-value" key={file}>
                {templateLabel(file, dir)}
              </div>
            ))}
          </div>
        </SettingsCard>
      )}
      <TemplateHint />
    </div>
  );
}

function TranslateTab() {
  const showToast = useAppStore((s) => s.showToast);
  const enabled = useAppStore((s) => s.settings.studyTranslate.enabled);
  const patch = useAppStore((s) => s.patchSettings);
  const [cfg, setCfg] = useState<TranslateConfig | null>(null);
  const [extraJson, setExtraJson] = useState("{}");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [dictResult, setDictResult] = useState<string | null>(null);

  useEffect(() => {
    void translateApi
      .getConfig()
      .then((c) => {
        setCfg(c);
        setExtraJson(JSON.stringify(c.extra_body ?? {}, null, 2));
      })
      .catch((e) =>
        setLoadError(String(e).replace(/^[A-Z_]+:\s*/, "")),
      );
  }, []);

  if (!cfg) {
    return (
      <div className="settings-section">
        {loadError ? `翻译配置加载失败：${loadError}` : "加载中…"}
      </div>
    );
  }

  const preset = TRANSLATE_PROTOCOLS[cfg.protocol] ?? TRANSLATE_PROTOCOLS.openai;

  function update(patchCfg: Partial<TranslateConfig>) {
    setCfg((current) => (current ? { ...current, ...patchCfg } : current));
  }

  function changeProtocol(next: string) {
    const nextPreset = TRANSLATE_PROTOCOLS[next] ?? TRANSLATE_PROTOCOLS.openai;
    update({
      protocol: next,
      base_url: nextPreset.base,
      model: cfg!.model || nextPreset.model,
    });
    setTestResult(null);
  }

  function extraBody(): Record<string, unknown> {
    if (!extraJson.trim()) return {};
    const parsed: unknown = JSON.parse(extraJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("额外请求参数必须是 JSON 对象，例如 {}");
    }
    return parsed as Record<string, unknown>;
  }

  async function save() {
    setSaving(true);
    try {
      const extra_body = extraBody();
      await translateApi.saveConfig({ ...cfg!, extra_body });
      showToast("翻译 API 配置已保存");
    } catch (e) {
      showToast(`保存失败：${String(e).replace(/^[A-Z_]+:\s*/, "")}`);
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const extra_body = extraBody();
      const text = await translateApi.test({ ...cfg!, extra_body });
      setTestResult({ ok: true, text });
    } catch (e) {
      setTestResult({
        ok: false,
        text: String(e).replace(/^[A-Z_]+:\s*/, ""),
      });
    } finally {
      setTesting(false);
    }
  }

  async function testDictionary() {
    try {
      const result = await translateApi.selection("ubiquitous");
      if (result.kind === "word") {
        const first = result.entry.translation.split("\n")[0];
        setDictResult(
          `${result.entry.word} /${result.entry.phonetic}/ — ${first}`,
        );
      } else {
        setDictResult("未命中（内置词典未收录该词）");
      }
    } catch (e) {
      setDictResult(`查词失败：${String(e).replace(/^[A-Z_]+:\s*/, "")}`);
    }
  }

  return (
    <div className="settings-section">
      <SettingsCard
        title="学习模式正文选中翻译"
        desc="在 PDF 或网页正文里选中英文后显示译文卡片。单词只查内置词典；选中两个及以上单词才调用模型 API。"
      >
        <Toggle
          label="启用选中翻译"
          desc="关闭后 PDF 和网页都不响应选中。批注工具优先：进入高亮/文字批注后不会触发翻译。"
          checked={enabled}
          onChange={(v) =>
            patch({ studyTranslate: { ...useAppStore.getState().settings.studyTranslate, enabled: v } })
          }
        />
      </SettingsCard>

      <SettingsCard
        title="本地词典"
        desc="内置 ECDICT 常用词 59,137 条，离线查询；单词未收录时只提示，不会自动调用 API。想用模型翻译一个词，请把它和相邻词一起选中。"
        actions={
          <button className="btn" onClick={() => void testDictionary()}>
            测试查词
          </button>
        }
      >
        {dictResult && (
          <p className="setting-hint">{dictResult}</p>
        )}
        <p className="setting-hint">
          数据在编译期压缩进应用（约 1.5MB），首次使用时在内存中解压（约 4.3MB），
          不落盘、不依赖外部文件。
        </p>
      </SettingsCard>

      <SettingsCard
        title="句子翻译 API"
        desc="独立于学习助手配置，保存在 translate.json。请求由 Rust 发起；思考模式默认关闭。"
      >
        <Row
          label="协议"
          desc={preset.thinking}
          control={
            <SettingsSelect<string>
              value={cfg.protocol}
              onChange={changeProtocol}
            >
              {Object.entries(TRANSLATE_PROTOCOLS).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.label}
                </option>
              ))}
            </SettingsSelect>
          }
        />
        <Row
          label="Base URL"
          desc="Ollama 填 http://127.0.0.1:11434（不要带 /v1）"
          control={
            <input
              className="settings-input mono"
              value={cfg.base_url}
              placeholder={preset.base}
              onChange={(e) => update({ base_url: e.target.value })}
            />
          }
        />
        <Row
          label="模型"
          control={
            <input
              className="settings-input"
              value={cfg.model}
              placeholder={preset.model || "模型名"}
              onChange={(e) => update({ model: e.target.value })}
            />
          }
        />
        <Row
          label="API Key"
          desc={cfg.protocol === "ollama" ? "本地 Ollama 忽略此项" : undefined}
          control={
            <input
              className="settings-input mono"
              type="password"
              value={cfg.api_key}
              onChange={(e) => update({ api_key: e.target.value })}
            />
          }
        />
        <Toggle
          label="开启思考模式"
          desc="默认关闭。关闭时按协议发送 think:false / thinking:{type:disabled} / enable_thinking:false；Anthropic 不发 thinking 字段。"
          checked={cfg.thinking}
          onChange={(v) => update({ thinking: v })}
        />
        <Row
          label="超时"
          desc="秒；超时后翻译卡片显示错误，不会重试。"
          control={
            <input
              className="settings-input mono"
              type="number"
              min={1}
              max={120}
              value={Math.round(cfg.timeout_ms / 1000)}
              onChange={(e) =>
                update({
                  timeout_ms:
                    Math.min(120, Math.max(1, Number(e.target.value) || 30)) *
                    1000,
                })
              }
            />
          }
        />
        <Row
          label="额外请求参数"
          desc='可选，JSON 对象。用于自定义网关；不能覆盖 messages/model/stream。'
          control={<span />}
        />
        <div className="settings-block">
          <textarea
            className="settings-textarea mono"
            rows={4}
            value={extraJson}
            onChange={(e) => setExtraJson(e.target.value)}
          />
        </div>
        <div className="settings-actions">
          <button className="btn" disabled={testing} onClick={() => void test()}>
            {testing ? "测试中…" : "测试连接"}
          </button>
          <button
            className="btn primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存翻译 API 配置"}
          </button>
        </div>
        {testResult && (
          <p
            className="setting-hint"
            style={{ color: testResult.ok ? "var(--ok)" : "var(--danger)" }}
          >
            {testResult.ok ? `连接成功：${testResult.text}` : testResult.text}
          </p>
        )}
      </SettingsCard>
    </div>
  );
}

const TRANSLATE_PROTOCOLS: Record<
  string,
  { label: string; base: string; model: string; thinking: string }
> = {
  ollama: {
    label: "Ollama（本地）",
    base: "http://127.0.0.1:11434",
    model: "qwen3:8b",
    thinking: "发送 think:false / think:true；本地服务忽略 API Key。",
  },
  openai: {
    label: "OpenAI 兼容",
    base: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    thinking: "不发送厂商私有思考字段；由模型选择或额外 JSON 控制。",
  },
  deepseek: {
    label: "DeepSeek",
    base: "https://api.deepseek.com",
    model: "deepseek-chat",
    thinking: "发送 thinking:{type:disabled}；开启后发 enabled。",
  },
  glm: {
    label: "智谱 GLM",
    base: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    thinking: "发送 thinking:{type:disabled}；GLM-5.3 / 5.3-FLASH 强制思考，关不掉。",
  },
  qwen: {
    label: "通义千问 Qwen",
    base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    thinking: "发送 enable_thinking:false；开启后发 true。",
  },
  anthropic: {
    label: "Anthropic",
    base: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    thinking: "默认不发 thinking；开启后发 enabled + budget_tokens。",
  },
  custom: {
    label: "自定义 OpenAI 兼容",
    base: "",
    model: "",
    thinking: "思考开关不发字段；用额外请求参数传厂商字段。",
  },
};

/**
 * The config loading and saving shared by the four Agent sub-pages: one
 * agent.json, each page saves the fields it cares about (the whole package
 * is written, the backend normalize is the fallback). An already open
 * session runs with the snapshot it started with, so saving only affects
 * the sessions started afterwards.
 */
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

  const save = async (patch: Partial<AgentConfig>, note: string, showToast: (m: string) => void) => {
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
function AgentModelTab() {
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
            <SettingsSelect
              value={cfg.provider}
              onChange={(v) => update({ provider: v })}
            >
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
              onChange={(e) =>
                update({ context_window: Math.max(0, Number(e.target.value) || 0) })
              }
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
          onClick={() => void save({}, "Agent 配置已保存;新会话生效(已开会话沿用原配置)", showToast)}
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
function AgentMcpTab() {
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
            onClick={() => void save({ mcp_servers: parsed ?? {} }, "MCP 配置已保存;新会话生效", showToast)}
          >
            保存 MCP 配置
          </button>
        </div>
      </SettingsCard>
    </div>
  );
}

/** Agent / skills: the list of the SKILL.md files found on disk plus the extra scan directories. */
function AgentSkillsTab() {
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
function AgentInstructionsTab() {
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
function CodeLspSettingsCard() {
  const settings = useAppStore((s) => s.settings);
  const patch = useAppStore((s) => s.patchSettings);
  const [text, setText] = useState(() => JSON.stringify(settings.codeLspServers ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const apply = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      patch({ codeLspServers: {} });
      setError(null);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError("要是一个对象：{ \"typescript\": { \"command\": \"...\" } }");
        return;
      }
      patch({ codeLspServers: parsed });
      setError(null);
    } catch (e) {
      setError(`JSON 解析失败：${(e as Error).message}`);
    }
  };

  /**
   * It takes effect on blur, but **only when the focus leaves this card**:
   * the CodeArea has its own search field, and clicking between the editor
   * and the search field is a blur as well; that one must not commit the
   * half written JSON and report a bogus error.
   */
  const handleBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && hostRef.current?.contains(next)) return;
    apply();
  };

  return (
    <SettingsCard
      title="代码项目"
      desc={
        <>
          内置默认已经覆盖 TypeScript / Rust / Go / Python 等常见语言。这里改的是
          <strong>用哪个可执行文件、传什么参数</strong>（本机装了对应服务器就能直接用）。
          项目内再放 <code>.bnote/lsp.json</code> 可以再盖一层，跟着仓库走、团队共享。
        </>
      }
    >
      <div className="settings-block" ref={hostRef} onBlur={handleBlur}>
        {/* JSON is code too: it uses the same CodeArea as the "formula
            snippets" (line numbers, line wrapping, search) and not a
            textarea where a bracket can be wrong and the line number is
            invisible. */}
        <CodeArea
          value={text}
          onChange={(value) => {
            setText(value);
            setError(null);
          }}
          height="22vh"
          searchPlaceholder="搜索语言 id 或命令"
        />
        {error ? (
          <div className="settings-error">{error}</div>
        ) : (
          <div className="settings-desc">失焦即生效。键名是语言 id（typescript / rust / go / python …）。</div>
        )}
      </div>
    </SettingsCard>
  );
}
