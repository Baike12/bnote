import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
import { LatexConfig } from "@/editor/snippets/config";
import { api, type InputSourceInfo, type VaultConfigFile } from "@/lib/tauri";
import { inputGuards } from "@/lib/inputGuards";
import { FolderSuggest } from "@/components/FolderSuggest";
import { CodeArea } from "@/components/CodeArea";
import { templateFiles } from "@/templates/template";
import { applySettingsToEditor, reloadSnippetsFromVault } from "@/app/actions";
import { parseVimrc } from "@/editor/vim/vimrc";
import { SettingsCard, Row, SettingsSelect, Toggle } from "./primitives";
import { TemplateSelect } from "./TemplateSelect";

type HotkeyFilter = "all" | "assigned" | "unassigned";

export function HotkeysTab() {
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
                {isCapturing && (
                  <span className="hotkey-capture-hint">按下新快捷键…（Esc 取消）</span>
                )}
              </div>
            );
          })}
        </div>
      </SettingsCard>
    </div>
  );
}

const VIMRC_TEMPLATE = `\" bnote vimrc（加载顺序：全局 → 仓库 .bnote/vimrc）
\" 键序列映射（映射到按键）
imap jj <Esc>

\" 映射到 bnote 命令（命令 id 见快捷键设置页）
nmap <C-s> :w<CR>
nmap <C-b> :Bnote nav.toggle-sidebar<CR>

\" 支持 :w / :wq / :q / :noh 以及 :Bnote <命令id>
`;

export function VimTab() {
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
            另可在仓库内放置 <code>.bnote/vimrc</code>，其映射会叠加在全局配置之上。 裸{" "}
            <code>map</code> / <code>noremap</code> 与 vim 一致，同时作用于 normal 和 visual 模式。
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

const SNIPPETS_TEMPLATE = `// 仓库级 LaTeX 片段（.bnote/snippets.js），保存后立即生效。
// 格式与 obsidian-latex-suite 兼容；导出空数组可禁用全部内置片段。
export default [
  // { trigger: "al", replacement: "\\alpha", options: "mA" },
]
`;

/** The placeholder text of the AGENTS.md input field (a placeholder only, it is not written into the file). */

export function SnippetsTab() {
  const showToast = useAppStore((s) => s.showToast);
  const settings = useAppStore((s) => s.settings);
  const patch = useAppStore((s) => s.patchSettings);
  const [content, setContent] = useState<string>(SNIPPETS_TEMPLATE);
  const [dirtyLocal, setDirtyLocal] = useState(false);
  const patchLatex = (p: Partial<LatexConfig>) => patch({ latex: { ...settings.latex, ...p } });

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
            <code>m/n/M/t/T/c/C</code> + <code>A</code>自动 <code>r</code>正则 <code>w</code>
            词边界。
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

export function ImeTab() {
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
  const patchIme = (p: Partial<ImeSettings>) => patch({ ime: { ...ime, ...p } });

  const renderPicker = (key: "insertSource" | "normalSource", label: string, desc: string) => (
    <Row
      label={label}
      desc={desc}
      control={
        <SettingsSelect value={ime[key]} onChange={(v) => patchIme({ [key]: v })}>
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
        通过系统输入法框架（TIS）在应用内直接切换，无进程启动、不抢焦点，通常 1–5ms； macOS 26
        上偶发的切换竞态会自动重试，仍失败时回退到 macism 命令行并提示。
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

export function QuickAddTab() {
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
  const add = () => patch({ quickAdd: [...quickAdd, { name: "", folder: "", template: "" }] });

  return (
    <div className="settings-section">
      <SettingsCard
        title="快速添加命令"
        desc={
          <>
            触发「快速添加文件」（默认
            ⌘⇧A，可在快捷键页修改）后搜索命令，选中并输入文件名即可在目标文件夹创建笔记；
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
                <button
                  className="btn btn-ghost qa-remove"
                  title="删除命令"
                  onClick={() => remove(i)}
                >
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
            <div className="qa-empty">
              还没有命令，点击下方按钮添加一个（如 add bnote file → bnote）。
            </div>
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
