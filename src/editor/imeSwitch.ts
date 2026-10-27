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

/** 焦点落定后核对输入源的一次性定时器(见 scheduleFocusVerify)。 */
let focusVerifyTimer: ReturnType<typeof setTimeout> | null = null;
/** 核对代数:新意图 / 离开输入框 / 交还都会作废在途的核对回调。 */
let focusVerifySeq = 0;
/** 焦点切换完成到上下文输入源恢复之间隔一个 run loop,120ms 足够落定。 */
const FOCUS_VERIFY_DELAY_MS = 120;

function cancelFocusVerify(): void {
  focusVerifySeq++;
  if (focusVerifyTimer !== null) {
    clearTimeout(focusVerifyTimer);
    focusVerifyTimer = null;
  }
}

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
  cancelFocusVerify();
  desired = target;
  suspended = false;
  scheduleLaunch();
}

/**
 * 中文写作输入框(批注卡 / agent 对话框)获得焦点:直接切到 insert 源。
 * 这些输入框只写中文,焦点即意图;编辑器的 vim 模式不参与。
 *
 * `force` = 用户显式进入输入框(鼠标点击 / 快捷键聚焦):用户在框里用
 * Ctrl+Space 切回英文后再点进来,`desired` 仍停在中文,普通去重会认为
 * 「已经是中文」而什么都不做。强制路径绕过这层去重,重新下发一次意图;
 * Rust 侧 `tis::select` 对「已经在目标源」本身就是 cheap no-op,不会重复
 * 触发 CJK 验证链。
 */
export function imeOnChineseFocus(force = false): void {
  const { settings } = useAppStore.getState();
  if (!settings.ime.enabled || !settings.ime.chineseFields) return;
  if (!force) {
    imeApply(settings.ime.insertSource);
    return;
  }
  desired = settings.ime.insertSource;
  suspended = false;
  // 排队中的旧意图(失焦归还、上一个输入框)作废:用户刚显式进了输入框,
  // 中文是最终意图。在途调用落定后由 launchSwitch 的收尾补发。
  queued = null;
  scheduleLaunch();
  scheduleFocusVerify(settings.ime.insertSource);
}

/**
 * 焦点落定后核对一次系统输入源。
 *
 * 系统开着「按上下文记忆输入源」(`TextInputGlobalPropertyPerContextInput = 1`)
 * 时,新的文本上下文激活后 AppKit 会把输入源恢复成这个上下文记住的源。
 * 切换发生在焦点切换过程中时会被这次恢复盖掉——表现就是 Sogou 图标闪一下
 * 又回到英文。等焦点稳定后再读一次系统源,与意图不一致就补发一次(只补
 * 一次,不循环);期间离开输入框或意图变化,核对自动作废。
 */
function scheduleFocusVerify(target: string): void {
  cancelFocusVerify();
  const seq = focusVerifySeq;
  focusVerifyTimer = setTimeout(() => {
    focusVerifyTimer = null;
    if (seq !== focusVerifySeq) return;
    const { settings } = useAppStore.getState();
    if (!settings.ime.enabled || !settings.ime.chineseFields) return;
    if (desired !== target || suspended || !focusInChineseField()) return;
    void api
      .getCurrentInputSource()
      .then((current) => {
        if (seq !== focusVerifySeq) return;
        if (desired !== target || suspended || !focusInChineseField()) return;
        if (current === target) return;
        desired = target;
        queued = null;
        scheduleLaunch();
      })
      .catch(() => {});
  }, FOCUS_VERIFY_DELAY_MS);
}

/**
 * 临时中文输入作用域:一个弹窗的生命周期(快速待办)。
 *
 * 打开时**先读用户此刻的输入源、再切中文**——先切后读会把中文源误当成
 * 「原来的」。关闭时按唯一意图通道把原源交还(在途的中文切换会被收尾那次
 * 覆盖,不会出现「归还之后又被晚到的切换打成中文」)。捕获还没返回就关闭
 * 的,等它返回时自己收尾,不留下半截状态。
 */
interface TransientScope {
  /** 打开那一刻用户用的源(捕获未返回时为 null)。 */
  source: string | null;
  /** 捕获未返回就关闭了。 */
  closed: boolean;
  /** 真的发出过中文切换意图——没发过就不必再去「还」一次。 */
  applied: boolean;
}

let transient: TransientScope | null = null;

export function imeBeginTransientChinese(): void {
  const { settings } = useAppStore.getState();
  if (!settings.ime.enabled || !settings.ime.chineseFields) return;
  if (transient) return; // 同一作用域重复进入(重渲染)不覆盖原始源
  const scope: TransientScope = { source: null, closed: false, applied: false };
  transient = scope;
  const start = () => {
    scope.applied = true;
    imeApply(settings.ime.insertSource);
  };
  void api
    .getCurrentInputSource()
    .then((id) => {
      if (transient !== scope) return;
      scope.source = id;
      if (scope.closed) {
        transient = null;
        if (scope.applied) restoreSource(id);
        return;
      }
      start();
    })
    .catch(() => {
      if (transient !== scope || scope.closed) return;
      start();
    });
}

export function imeEndTransientChinese(): void {
  const scope = transient;
  if (!scope) return;
  if (scope.source === null) {
    scope.closed = true; // 捕获未返回:由 begin 的回调收尾
    return;
  }
  transient = null;
  if (scope.applied) restoreSource(scope.source);
}

/** 把用户的原始源交还:走唯一意图通道,排队中的中文切换被这一次覆盖。 */
function restoreSource(source: string): void {
  cancelFocusVerify();
  desired = source;
  suspended = false;
  queued = null;
  scheduleLaunch();
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
  cancelFocusVerify();
  desired = null;
  suspended = false;
  queued = null;
  forcedThisSession = false;
  transient = null; // 交还控制权:不再替任何弹窗记着「原来的源」
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
    // 下 imeApply 的去重会放行,重发一次中文源。窗口重新激活也走这里,
    // 同样要核对一次(上下文恢复可能在激活后把源盖掉)。
    const target = settings.ime.insertSource;
    imeApply(target);
    scheduleFocusVerify(target);
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
  cancelFocusVerify();
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
