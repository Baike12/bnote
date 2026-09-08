import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";
import { allCommands } from "@/commands/registry";
import { bindingsForCommand, eventToKey, formatBinding } from "@/commands/keys";
import { clearOverride, resetAllOverrides, setOverride } from "@/commands/keybindingOverrides";
import { setHotkeyRecording } from "@/commands/globalKeys";
import { useAppStore, type ImeSettings, type QuickAddCommand } from "@/state/appStore";
import { api, type InputSourceInfo, type VaultConfigFile } from "@/lib/tauri";
import { inputGuards } from "@/lib/inputGuards";
import { applySettingsToEditor, openVault, pickVaultDialog, reloadSnippetsFromVault } from "@/app/actions";

type Tab = "general" | "editor" | "hotkeys" | "vim" | "snippets" | "ime" | "quickadd";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "通用" },
  { id: "editor", label: "编辑器" },
  { id: "hotkeys", label: "快捷键" },
  { id: "vim", label: "Vim" },
  { id: "snippets", label: "公式片段" },
  { id: "ime", label: "输入法" },
  { id: "quickadd", label: "快速添加" },
];

const VIMRC_TEMPLATE = `\" bnote vimrc（加载顺序：全局 → 仓库 .bnote/vimrc）
\" 键序列映射（映射到按键）
imap jj <Esc>

\" 映射到 bnote 命令（命令 id 见快捷键设置页）
nmap <C-s> :w<CR>
nmap <C-b> :Bnote nav.toggle-sidebar<CR>

\" 支持 :w / :wq / :q / :noh 以及 :Bnote <command-id>
`;

const SNIPPETS_TEMPLATE = `// 仓库级 LaTeX 片段（.bnote/snippets.js），保存后立即生效。
// 格式与 obsidian-latex-suite 兼容；导出空数组可禁用全部内置片段。
export default [
  // { trigger: "al", replacement: "\\alpha", options: "mA" },
]
`;

export function SettingsModal() {
  const open = useAppStore((s) => s.modal === "settings");
  const setModal = useAppStore((s) => s.setModal);
  const [tab, setTab] = useState<Tab>("general");
  if (!open) return null;

  return (
    <Modal open={open} onClose={() => setModal(null)} width={880}>
      <div className="settings">
        <aside className="settings-nav">
          <div className="settings-nav-title">设置</div>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`settings-nav-item${tab === t.id ? " active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </aside>
        <div className="settings-content">
          {tab === "general" && <GeneralTab />}
          {tab === "editor" && <EditorTab />}
          {tab === "hotkeys" && <HotkeysTab />}
          {tab === "vim" && <VimTab />}
          {tab === "snippets" && <SnippetsTab />}
          {tab === "ime" && <ImeTab />}
          {tab === "quickadd" && <QuickAddTab />}
        </div>
      </div>
    </Modal>
  );
}

function GeneralTab() {
  const vaultPath = useAppStore((s) => s.vaultPath);
  const vaultName = useAppStore((s) => s.vaultName);
  const settings = useAppStore((s) => s.settings);
  return (
    <div className="settings-section">
      <h3>仓库</h3>
      <div className="setting-row">
        <div>
          <div className="setting-label">当前仓库</div>
          <div className="setting-desc">{vaultPath ?? "未打开"}</div>
        </div>
        <button className="btn" onClick={() => void openVaultFlow()}>
          打开其他仓库
        </button>
      </div>
      <h3>片段引擎</h3>
      <Toggle
        label="启用 LaTeX 片段"
        desc="输入触发串后按 Tab 展开（如 // → \\frac{}{}），或使用 A 选项的自动片段"
        checked={settings.snippets}
        onChange={(v) => useAppStore.getState().patchSettings({ snippets: v })}
      />
      <p className="setting-hint">
        试试在公式里输入 <code>aa</code>、<code>sr</code>、<code>{"//"}</code>（自动展开），或 <code>dm</code>、<code>beg</code>、<code>al</code> + Tab。
      </p>
      <div className="setting-row">
        <div>
          <div className="setting-label">仓库名</div>
          <div className="setting-desc">{vaultName}</div>
        </div>
      </div>
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
      <h3>编辑行为</h3>
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
      <h3>外观</h3>
      <div className="setting-row">
        <div>
          <div className="setting-label">编辑区字号</div>
          <div className="setting-desc">{settings.fontSize}px</div>
        </div>
        <input
          type="range"
          min={12}
          max={28}
          value={settings.fontSize}
          onChange={(e) => patch({ fontSize: Number(e.target.value) })}
        />
      </div>
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
    <div className="settings-section hotkeys">
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

  return (
    <div className="settings-section">
      <Toggle
        label="启用 Vim 模式"
        desc="normal / insert / visual 模式，支持 vimrc 映射与 :w / :wq / :q / :noh / :Bnote <命令id>"
        checked={settings.vim}
        onChange={(v) => patch({ vim: v })}
      />
      <h3>全局 vimrc</h3>
      <p className="setting-hint">
        另可在仓库内放置 <code>.bnote/vimrc</code>，其映射会叠加在全局配置之上。
      </p>
      <textarea
        className="settings-textarea"
        spellCheck={false}
        value={vimrc}
        onChange={(e) => setVimrc(e.target.value)}
        rows={14}
      />
      <div className="setting-row">
        <span />
        <button
          className="btn"
          disabled={!loaded}
          onClick={() => {
            void api
              .saveVimrc(vimrc)
              .then(() => applySettingsToEditor())
              .then(() => showToast("vimrc 已保存并生效"));
          }}
        >
          保存并应用
        </button>
      </div>
    </div>
  );
}

function SnippetsTab() {
  const showToast = useAppStore((s) => s.showToast);
  const [content, setContent] = useState<string>(SNIPPETS_TEMPLATE);
  const [dirtyLocal, setDirtyLocal] = useState(false);

  useEffect(() => {
    void api.readVaultFile("snippets.js" as VaultConfigFile).then((v) => {
      setContent(v ?? SNIPPETS_TEMPLATE);
    });
  }, []);

  return (
    <div className="settings-section">
      <p className="setting-hint">
        片段格式与 <code>obsidian-latex-suite</code> 兼容：
        <code>{"{ trigger, replacement, options }"}</code>，占位符 <code>$0</code>
        <code>${"{n:默认文本}"}</code>，正则捕获组 <code>{"[[0]]"}</code>，选项
        <code>m/n/M/t/T/c/C</code> + <code>A</code>自动 <code>r</code>正则 <code>w</code>词边界。
      </p>
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
      <div className="setting-row">
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
              .then(() => {
                setDirtyLocal(false);
                showToast("片段已保存并生效");
              })
          }
        >
          保存并应用
        </button>
      </div>
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
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        <div className="setting-desc">{desc}</div>
      </div>
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
    </div>
  );

  return (
    <div className="settings-section">
      <Toggle
        label="输入法跟随 Vim 模式"
        desc="进入 insert 切到中文输入法，回到 normal/visual 切到英文；打开快速切换器时也切到英文，关闭后还原（仅 macOS；需开启 Vim 模式）"
        checked={ime.enabled}
        onChange={(v) => patchIme({ enabled: v })}
      />
      <p className="setting-hint">
        通过系统输入法框架（TIS）在应用内直接切换，无进程启动、不抢焦点，通常 1–5ms；
        macOS 26 上偶发的切换竞态会自动重试，仍失败时回退到 macism 命令行并提示。
      </p>
      {renderPicker("insertSource", "insert 模式输入法", "写中文笔记用的输入法")}
      {renderPicker("normalSource", "normal / visual 模式输入法", "一般选英文键盘（ABC）")}
      <Toggle
        label="公式内进入 insert 保持英文"
        desc="光标位于 $…$ 或 $$…$$ 内时不切中文，避免输入法干扰公式输入"
        checked={ime.mathKeepsEnglish}
        onChange={(v) => patchIme({ mathKeepsEnglish: v })}
      />
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
      <h3>快速添加命令</h3>
      <p className="setting-hint">
        触发「快速添加文件」（默认 ⌘⇧A，可在快捷键页修改）后搜索命令，选中并输入文件名即可在目标文件夹创建笔记；
        文件夹不存在时会在仓库根目录自动创建，支持 <code>a/b</code> 子路径。改动即时保存。
      </p>
      {quickAdd.map((c, i) => (
        <div className="qa-row" key={i}>
          <input
            className="settings-input"
            placeholder="命令名，如 add bnote file"
            value={c.name}
            onChange={(e) => update(i, { name: e.target.value })}
            {...inputGuards}
          />
          <input
            className="settings-input mono"
            placeholder="目标文件夹，如 bnote 或 notes/收集箱"
            value={c.folder}
            onChange={(e) => update(i, { folder: e.target.value })}
            {...inputGuards}
          />
          <button className="btn btn-ghost qa-remove" title="删除命令" onClick={() => remove(i)}>
            ✕
          </button>
        </div>
      ))}
      {quickAdd.length === 0 && (
        <div className="qa-empty">还没有命令，点击下方按钮添加一个（如 add bnote file → bnote）。</div>
      )}
      <div className="setting-row">
        <span />
        <button className="btn" onClick={add}>
          添加命令
        </button>
      </div>
    </div>
  );
}

function Toggle({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      <button
        className={`toggle${checked ? " on" : ""}`}
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}
