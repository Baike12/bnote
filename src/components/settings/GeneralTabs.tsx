import { useRef, useState, type FocusEvent as ReactFocusEvent } from "react";
import { useAppStore } from "@/state/appStore";
import { inputGuards } from "@/lib/inputGuards";
import { CodeArea } from "@/components/CodeArea";
import { openVault, pickVaultDialog } from "@/app/actions";
import { MAX_PAGE_STEP, MIN_PAGE_STEP, normalizePageStep } from "@/study/reading";
import {
  MAX_TYPEWRITER_POSITION,
  MIN_TYPEWRITER_POSITION,
  normalizeTypewriterPosition,
} from "@/editor/typewriterPosition";
import { SettingsCard, Row, RangeControl, Toggle } from "./primitives";

export function GeneralTab() {
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
        <Row label="仓库名" control={<span className="setting-value">{vaultName}</span>} />
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
        试试在公式里输入 <code>aa</code>、<code>sr</code>、<code>{"//"}</code>（自动展开），或{" "}
        <code>dm</code>、<code>beg</code>、<code>al</code> + Tab。
      </p>
    </div>
  );
}

async function openVaultFlow() {
  const path = await pickVaultDialog();
  if (path) await openVault(path);
}

export function EditorTab() {
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

export function ReadingTab() {
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
        屏幕下方是刚进入的新内容（占可见高度的 {percent}%）；上方是刚读过、 正在移出的内容（占{" "}
        {100 - percent}%），压暗后向边界渐隐，不画分界线，
        两端保留阴影的圆角尖。两层只做视觉分区，不影响选中、批注和点击； 翻页落点会在 2%
        视口内微调，避免边界切在文字行中间。
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

export function CodeLspSettingsCard() {
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
        setError('要是一个对象：{ "typescript": { "command": "..." } }');
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
          <strong>用哪个可执行文件、传什么参数</strong>（本机装了对应服务器就能直接用）。 项目内再放{" "}
          <code>.bnote/lsp.json</code> 可以再盖一层，跟着仓库走、团队共享。
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
          <div className="settings-desc">
            失焦即生效。键名是语言 id（typescript / rust / go / python …）。
          </div>
        )}
      </div>
    </SettingsCard>
  );
}
