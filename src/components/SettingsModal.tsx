import { useEffect, useMemo, useState, type ReactNode } from "react";
import { agentApi, type AgentConfig } from "@/lib/tauri";
import { Modal } from "./Modal";
import { allCommands } from "@/commands/registry";
import { bindingsForCommand, eventToKey, formatBinding } from "@/commands/keys";
import { clearOverride, resetAllOverrides, setOverride } from "@/commands/keybindingOverrides";
import { setHotkeyRecording } from "@/commands/globalKeys";
import { useAppStore, type ImeSettings, type QuickAddCommand } from "@/state/appStore";
import type { LatexConfig } from "@/editor/snippets/config";
import { api, type InputSourceInfo, type VaultConfigFile } from "@/lib/tauri";
import { inputGuards } from "@/lib/inputGuards";
import { FolderSuggest } from "@/components/FolderSuggest";
import { applySettingsToEditor, openVault, pickVaultDialog, reloadSnippetsFromVault } from "@/app/actions";
import { parseVimrc } from "@/editor/vim/vimrc";
import { MAX_PAGE_STEP, MIN_PAGE_STEP, normalizePageStep } from "@/study/reading";

type Tab =
  | "general"
  | "editor"
  | "reading"
  | "hotkeys"
  | "vim"
  | "snippets"
  | "ime"
  | "quickadd"
  | "agent";

/** 左侧导航按用途分组(参考 ZCode 设置页的分组侧栏),渲染见 SettingsModal。 */
const NAV_GROUPS: { label: string; items: { id: Tab; label: string }[] }[] = [
  {
    label: "常规",
    items: [
      { id: "general", label: "通用" },
      { id: "editor", label: "编辑器" },
      { id: "reading", label: "阅读" },
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
    items: [{ id: "agent", label: "Agent(学习模式)" }],
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

const AGENT_MD_TEMPLATE = `<!-- .bnote/agent.md — 学习助手的自定义指令(类比 AGENTS.md / CLAUDE.md)。
     保存在当前仓库,随会话启动加载;内置的通用要求(简洁、结论先行、
     组块化)始终生效,这里的指令在其后追加。留空 = 只用通用要求。
     例如:优先用表格对比易混概念;回答末尾给一个检验理解的小问题。 -->
`;

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
          {tab === "hotkeys" && <HotkeysTab />}
          {tab === "vim" && <VimTab />}
          {tab === "snippets" && <SnippetsTab />}
          {tab === "ime" && <ImeTab />}
          {tab === "quickadd" && <QuickAddTab />}
          {tab === "agent" && <AgentTab />}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 设置页的两个骨架件(参考 ZCode 的 SettingsGroupCard / SettingsRow):
// 卡片分组 + 行式布局(左侧标签与描述,右侧控件)。
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

/** 滑杆 + 右对齐数值(ZCode 的 SettingsRangeControl 版式)。 */
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
}: {
  label: ReactNode;
  desc?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row
      label={label}
      desc={desc}
      control={
        <button
          className={`toggle${checked ? " on" : ""}`}
          role="switch"
          aria-checked={checked}
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
          desc="光标在公式内编辑时，保留源码并在下方实时显示渲染结果"
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
          desc="光标所在行始终保持屏幕垂直居中"
          checked={settings.typewriter}
          onChange={(v) => patch({ typewriter: v })}
        />
        <Toggle
          label="Vim 模式"
          desc="原生 vim 键位 + vimrc 配置（见 Vim 标签页）"
          checked={settings.vim}
          onChange={(v) => patch({ vim: v })}
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
        屏幕下方是刚进入的新内容（占可见高度的 {percent}%），顶部用一条淡色圆角线
        标出；上方是刚读过、正在移出的内容（占 {100 - percent}%），会轻微压暗。
        两层只做视觉分区，不影响选中、批注和点击；翻页落点会在 2% 视口内微调，
        避免分界线切在文字行中间。
      </p>
    </div>
  );
}

type HotkeyFilter = "all" | "assigned" | "unassigned";

function HotkeysTab() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HotkeyFilter>("all");
  const [capturing, setCapturing] = useState<string | null>(null);
  const commands = useMemo(() => allCommands(), []);
  const showToast = useAppStore((s) => s.showToast);

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
      const conflict = commands.find(
        (c) => c.id !== capturing && bindingsForCommand(c.id).includes(key),
      );
      if (conflict) {
        await setOverride(conflict.id, null);
        showToast(`与「${conflict.title}」冲突，已移除其原绑定`);
      }
      await setOverride(capturing, key);
      setCapturing(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => {
      setHotkeyRecording(false);
      window.removeEventListener("keydown", handler, true);
    };
  }, [capturing, commands, showToast]);

  const rows = commands.filter((c) => {
    if (query && !`${c.category}${c.title}`.toLowerCase().includes(query.toLowerCase())) {
      return false;
    }
    const bound = bindingsForCommand(c.id).length > 0;
    if (filter === "assigned") return bound;
    if (filter === "unassigned") return !bound;
    return true;
  });

  return (
    <div className="settings-section">
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
      <SettingsCard title={`快捷键（${rows.length}）`}>
        <div className="hotkey-list">
          {rows.map((cmd) => {
            const bindings = bindingsForCommand(cmd.id);
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
                        void setOverride(cmd.id, null);
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
                      void clearOverride(cmd.id);
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

  // 实时校验，未识别的行立刻标出来——否则拼错命令只会静默失效（vim 里
  // 会有 E492，这里只在 console 里 warn，用户在应用里看不到）。
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
          <textarea
            className="settings-textarea mono"
            spellCheck={false}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setDirtyLocal(true);
            }}
            rows={16}
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
                    // 装载结果如实反馈：此前即使动态导入失败回退了内置，
                    // 这里也永远提示"已保存并生效"。
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
        <select
          className="settings-select"
          value={ime[key]}
          onChange={(e) => patchIme({ [key]: e.target.value })}
        >
          {sources === null && <option value={ime[key]}>{ime[key]}</option>}
          {(sources ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}（{s.id}）
            </option>
          ))}
        </select>
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
          desc="聚焦学习助手输入框、PDF 批注框等只写中文的输入框时自动切到上面的 insert 输入法；关闭后保持当前输入法"
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

function QuickAddTab() {
  const quickAdd = useAppStore((s) => s.settings.quickAdd);
  const patch = useAppStore((s) => s.patchSettings);

  const update = (i: number, p: Partial<QuickAddCommand>) =>
    patch({ quickAdd: quickAdd.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const remove = (i: number) => patch({ quickAdd: quickAdd.filter((_, j) => j !== i) });
  const add = () => patch({ quickAdd: [...quickAdd, { name: "", folder: "" }] });

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
            <div className="qa-row" key={i}>
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
    </div>
  );
}

function AgentTab() {
  const showToast = useAppStore((s) => s.showToast);
  const vaultName = useAppStore((s) => s.vaultName);
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [mcpJson, setMcpJson] = useState("{}");
  const [mcpDirty, setMcpDirty] = useState(false);
  // 自定义指令 = 仓库的 .bnote/agent.md(类比 AGENTS.md / CLAUDE.md)。
  const [instructions, setInstructions] = useState(AGENT_MD_TEMPLATE);
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void agentApi
      .getConfig()
      .then((c) => {
        setCfg(c);
        setMcpJson(JSON.stringify(c.mcp_servers ?? {}, null, 2));
      })
      .catch((e) => setLoadError(String(e).replace(/^[A-Z_]+:\s*/, "")));
    void api.readVaultFile("agent.md").then((v) => {
      setInstructions(v ?? AGENT_MD_TEMPLATE);
    });
  }, []);

  // 配置读不出来(后端异常/无后端)就如实说,不能永远停在「加载中…」。
  if (!cfg) {
    return (
      <div className="settings-section">
        {loadError ? `Agent 配置加载失败:${loadError}` : "加载中…"}
      </div>
    );
  }

  function update(patch: Partial<AgentConfig>) {
    setCfg({ ...cfg!, ...patch });
  }

  async function save() {
    try {
      let mcp_servers: Record<string, unknown> = {};
      if (mcpDirty) {
        mcp_servers = JSON.parse(mcpJson || "{}");
      } else {
        mcp_servers = cfg!.mcp_servers ?? {};
      }
      await agentApi.saveConfig({ ...cfg!, mcp_servers });
      // The session fixes its provider at creation time, so nudge the study
      // panel to rebuild it — otherwise a freshly entered API key/model would
      // only take effect after leaving and re-entering study mode.
      useAppStore.getState().bumpAgentConfigVersion();
      showToast("Agent 配置已保存并生效");
    } catch (e) {
      showToast(`保存失败: ${String(e)}`);
    }
  }

  return (
    <div className="settings-section">
      <SettingsCard title="模型">
        <Row
          label="协议"
          control={
            <select
              className="settings-select"
              value={cfg.provider}
              onChange={(e) => update({ provider: e.target.value })}
            >
              <option value="anthropic">Anthropic(含兼容代理)</option>
              <option value="openai">OpenAI 兼容(OpenAI/DeepSeek/Grok/Ollama…)</option>
            </select>
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
          desc="模型的最大上下文(tokens),用于学习助手输入框下方显示占用率;按实际模型填写,如 128000、200000、420000"
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

      <SettingsCard
        title="MCP 服务器"
        desc={
          <>
            每个会话启动时连接;stdio 形如{" "}
            <code>{`{ "server": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] } }`}</code>
            , HTTP 形如 <code>{`{ "type": "http", "url": "https://…" }`}</code>。工具以
            mcp__服务器__工具 命名。
          </>
        }
      >
        <div className="settings-block">
          <textarea
            className="settings-textarea mono"
            rows={8}
            value={mcpJson}
            onChange={(e) => {
              setMcpJson(e.target.value);
              setMcpDirty(true);
            }}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="额外 Skill 目录"
        desc="每行一个目录;内置会扫描 应用数据/skills、仓库 .bnote/skills 与 ~/.agents/skills。"
      >
        <div className="settings-block">
          <textarea
            className="settings-textarea mono"
            rows={3}
            value={cfg.skill_dirs.join("\n")}
            onChange={(e) => update({ skill_dirs: e.target.value.split("\n").filter((x) => x.trim()) })}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="自定义指令(仓库 .bnote/agent.md)"
        desc={
          <>
            代码里内置的通用要求(结论先行、直击本质、组块化、控制长度)始终生效,
            这里的指令追加在其后,随会话启动加载——和 ZCode 读 AGENTS.md 同一机制。
            {vaultName ? "" : " (当前没有打开仓库,保存不可用)"}
          </>
        }
      >
        <div className="settings-block">
          <textarea
            className="settings-textarea mono"
            rows={8}
            spellCheck={false}
            value={instructions}
            onChange={(e) => {
              setInstructions(e.target.value);
              setInstructionsDirty(true);
            }}
          />
          <div className="settings-actions">
            <button
              className="btn"
              disabled={!instructionsDirty || !vaultName}
              onClick={() =>
                void api
                  .writeVaultFile("agent.md", instructions)
                  .then(() => {
                    setInstructionsDirty(false);
                    // 会话固化了系统提示词,重启会话才吃到新指令。
                    useAppStore.getState().bumpAgentConfigVersion();
                    showToast("自定义指令已保存,学习助手会话将使用新指令");
                  })
                  .catch((e) => showToast(`保存失败: ${String(e)}`))
              }
            >
              保存并应用到新会话
            </button>
          </div>
        </div>
      </SettingsCard>

      <div className="settings-footer">
        <button className="btn primary" onClick={() => void save()}>
          保存 Agent 配置
        </button>
      </div>
    </div>
  );
}
