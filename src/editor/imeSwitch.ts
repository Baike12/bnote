import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { currentVimMode } from "./vim/vim";
import { insideFencedCode, mathRegions } from "./context";
import { getView } from "./api";
import { api } from "@/lib/tauri";
import { useAppStore, type ModalKind, type Settings } from "@/state/appStore";

/**
 * IME follow: switch the macOS input source on vim mode changes —
 * insert → Chinese, normal/visual → English — without leaving insert-time
 * typing on the critical path. The switch itself is an in-process TIS call
 * (~1–5 ms, background thread) and is skipped entirely when the requested
 * source is already active.
 *
 * Mirrors the behavior of the user's patched obsidian-vim-input-auto-switch:
 * entering insert inside a math region keeps the English source (formulas are
 * ASCII, the IME would only get in the way).
 *
 * TIS selection is system-global, so every forced switch is scoped to bnote:
 * the source active before bnote's first forced switch of a focus session is
 * remembered (`baseline`) and restored as soon as the window loses focus, and
 * re-applied (with a fresh baseline) when it regains focus. ASCII-search
 * modals (quick switcher / quick add pick stage) route their switches through
 * the same scope via imeApply()/imeSyncToEditor().
 */

/** What bnote currently wants active — editor vim mode or an open modal. */
let desired: string | null = null;
/** Editor-side dedup: only real vim-mode transitions call imeApply. */
let lastEditorTarget: string | null = null;
/** Source active before bnote's first forced switch of this focus session. */
let baseline: string | null = null;
/** True while bnote is unfocused and baseline has been handed back. */
let suspended = false;
/** 本次聚焦会话里 bnote 是否真的强制切过输入源——blur 时据此决定要不要归还
 *  （推迟中、还没发出去的意图不算「切过」）。 */
let forcedThisSession = false;
/** Focus-session counter — invalidates in-flight baseline captures. */
let focusSeq = 0;

/** At most one setInputSource in flight; a burst of flips collapses into the
 *  one trailing call that matches the final intent. Each switch costs the
 *  backend 1-3 main-thread TIS round trips (and a macism fallback on the
 *  macOS 26 race), so overlapping switches stall the whole UI — exactly what
 *  rapid cursor moves across math boundaries felt like. */
let switching = false;
let queued: string | null = null;
let launchScheduled = false;

/** 把切换推迟到当前任务之后。模式切换那一帧里已经有一轮 DOM 同步 + measure
 *  （见 setup.ts 的光标冲刷），而 TIS 必须占用苹果主线程（ime.rs 的 on_main）
 *  ——先让模式与光标落到位，再去动输入法，不要叠在同一帧里。同一批里的连续
 *  翻转合并成一次：`desired` 是唯一意图来源，定时器只负责把它送出去。 */
function scheduleLaunch(): void {
  if (launchScheduled) return;
  launchScheduled = true;
  setTimeout(() => {
    launchScheduled = false;
    const target = desired;
    if (target === null || suspended) return; // 已交还用户输入法（失焦/挂起）
    if (switching) {
      queued = target;
      return;
    }
    launchSwitch(target);
  }, 0);
}

function launchSwitch(target: string): void {
  switching = true;
  forcedThisSession = true;
  const seq = focusSeq;
  if (baseline === null) {
    void api
      .getCurrentInputSource()
      .then((id) => {
        if (seq === focusSeq && id !== target) baseline = id;
      })
      .catch(() => {});
  }
  // Fire-and-forget: the backend dedups against the live input source,
  // verifies CJK switches and falls back to macism when needed.
  void api
    .setInputSource(target)
    .catch((e) => {
      console.warn("[bnote] set input source failed", e);
      lastEditorTarget = null; // allow retry on the next transition
    })
    .finally(() => {
      switching = false;
      const next = queued;
      queued = null;
      // 挂起（失焦/交还）后不再补发：用户的原始输入源刚被还回去。
      if (next !== null && next !== target && !suspended) launchSwitch(next);
    });
}

/**
 * Force a target input source, remembering what to restore on window blur.
 * No-op when `target` is already what bnote wants (unless suspended by blur).
 */
export function imeApply(target: string): void {
  const { settings } = useAppStore.getState();
  if (!settings.ime.enabled) return;
  if (desired === target && !suspended) return;
  desired = target;
  suspended = false;
  scheduleLaunch();
}

/**
 * 中文写作输入框(批注卡 / agent 对话框)获得焦点:直接切到 insert 源。
 * 这些输入框只写中文,焦点即意图;编辑器的 vim 模式不参与。
 */
export function imeOnChineseFocus(): void {
  const { settings } = useAppStore.getState();
  imeApply(settings.ime.insertSource);
}

/** 预热 TIS：启动后后台枚举一次输入源。TIS 的首次调用要去联系输入法服务
 *  （本机实测 ~90ms）而且必须走苹果主线程（见 ime.rs 的 on_main）——等到用户
 *  第一次切模式才付，就正好落在按键那一帧上。这次枚举同时把 Rust 侧的输入源
 *  引用缓存填好，之后每次切换只剩「读当前源 + select」。 */
export function imeWarmUp(): void {
  const { settings } = useAppStore.getState();
  if (!settings.ime.enabled) return;
  void api.listInputSources().catch(() => {});
}

/** Drop bnote's forced source and restore what the user had before it. */
export function imeYield(): void {
  const restore = baseline;
  desired = null;
  suspended = false;
  queued = null;
  forcedThisSession = false;
  if (restore) void api.setInputSource(restore).catch(() => {});
}

/**
 * 中文写作输入框(批注卡 / agent 对话框)在 DOM 上带的标记。焦点落在带标记
 * 的元素上时,输入源意图归它:imeSyncToEditor 不按编辑器上下文覆盖——否则
 * 聚焦 agent 输入框切到中文后,Cmd-Tab 离开再回来,窗口 focus 会按编辑器的
 * normal 模式把中文切掉,用户直接打出一串英文原码。
 */
const CHINESE_FIELD_ATTR = "data-ime-chinese";

function focusInChineseField(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement as Element | null;
  return typeof active?.hasAttribute === "function" && active.hasAttribute(CHINESE_FIELD_ATTR);
}

/** Switch to whatever the current UI context wants (modal or editor vim mode). */
export function imeSyncToEditor(): void {
  const { settings, modal } = useAppStore.getState();
  if (!settings.ime.enabled) {
    if (desired) imeYield();
    return;
  }
  if (focusInChineseField()) {
    // 意图属于中文写作输入框:imeOnChineseFocus 已切;挂起态(失焦归还过)
    // 下 imeApply 的去重会放行,重发一次中文源。
    imeApply(settings.ime.insertSource);
    return;
  }
  const target = imeDesiredSource(settings, modal);
  if (target) imeApply(target);
  else if (desired) imeYield();
}

/** The input source the current UI context wants, or null for "leave it". */
function imeDesiredSource(settings: Settings, modal: ModalKind): string | null {
  if (modal === "switcher") return settings.ime.normalSource;
  if (modal) return null; // e.g. quick-add naming wants the user's own source
  if (!settings.vim) return null;
  const view = getView();
  if (!view) return null;
  const mode = currentVimMode(view);
  if (!mode) return null;
  if (mode === "insert") {
    if (insertRegionWantsEnglish(settings, view)) return settings.ime.normalSource;
    return settings.ime.insertSource;
  }
  return settings.ime.normalSource;
}

/**
 * insert 模式下光标是否落在「该保持英文」的区域:公式(公式是 ASCII)或
 * 围栏代码块(代码是 ASCII)。imeDesiredSource 与 updateListener 两条路径
 * 共用这一个判定,不许各写一份——区域清单变化时只改这里。
 */
function insertRegionWantsEnglish(settings: Settings, view: EditorView): boolean {
  const head = view.state.selection.main.head;
  if (settings.ime.mathKeepsEnglish && mathRegions(view.state).some((r) => head >= r.from && head <= r.to)) {
    return true;
  }
  if (settings.ime.codeKeepsEnglish && insideFencedCode(view.state, head)) {
    return true;
  }
  return false;
}

/** Window deactivated: hand the user's original source back to the system. */
export function imeOnWindowBlur(): void {
  focusSeq++;
  queued = null;
  // 只有真的强制切过才需要归还。推迟中（意图还没发出去）时不许这里白发一次
  // 主线程 TIS 调用去「切」一个本来就活跃的源——那次调用同样会占住主线程。
  if (forcedThisSession && desired !== null && baseline !== null) {
    void api.setInputSource(baseline).catch(() => {});
  }
  forcedThisSession = false;
  baseline = null;
  suspended = true;
}

/** Window activated: re-apply what bnote wants, with a fresh baseline.
 *  `suspended` stays true until imeApply/imeYield run, so the dedup guard
 *  knows the source must actually be (re)applied after the blur restore. */
export function imeOnWindowFocus(): void {
  focusSeq++;
  if (suspended) baseline = null; // fresh session after a real blur; duplicate focus events keep it
  imeSyncToEditor();
}

export function imeSwitchExtension(): Extension {
  return EditorView.updateListener.of((u) => {
    const view = u.view;
    const { settings } = useAppStore.getState();
    const ime = settings.ime;

    const gated = settings.vim && ime.enabled;
    const mode = gated ? currentVimMode(view) : null;
    if (!gated || !mode) {
      // Reset so re-enabling fires a fresh switch instead of a stale no-op.
      lastEditorTarget = null;
      return;
    }

    let target = mode === "insert" ? ime.insertSource : ime.normalSource;
    if (mode === "insert" && insertRegionWantsEnglish(settings, view)) {
      target = ime.normalSource;
    }

    if (target === lastEditorTarget) return;
    lastEditorTarget = target;
    imeApply(target);
  });
}
