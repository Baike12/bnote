import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { documentPath } from "@/editor/docPath";
import { useAppStore } from "@/state/appStore";
import {
  applyIntents,
  intentsForRange,
  SYNC_USER_EVENT,
  type DailyDeps,
  type Intent,
} from "./engine";
import { peekLinks } from "./links";
import { isDailyPath } from "./model";
import { runtimeDeps } from "./runtime";

/**
 * 跨文件待办同步的编辑器接入点:一个 updateListener 监听文档事务,做行级
 * diff 提取同步意图(勾选翻转/块内编辑/改名/消失),250ms 防抖合并后执行
 * 镜像与记录。
 *
 * 每键成本纪律:无意图时只付「行解析 + 文本比对」的常量开销(见
 * perf.gate.test.ts 的门禁);链接库尚未加载(启动竞速)时整轮跳过,状态由
 * 下一次真实编辑收敛,不会写错。
 *
 * 多实例:意图记下产生它的 view(`u.view`),执行时按那个 view 自证——页面上
 * 可以同时有笔记编辑器、项目卡片编辑器、日记编辑器,哪个在编辑只能由事务
 * 自己说,不能查全局单例。
 */

const SEND_SUPPRESS_EVENTS = ["input.paste", "input.drop"];

export interface DailySyncOptions {
  /**
   * 允许「编辑一条尚未链接的待办 → 自动复制进今日日记」。普通笔记默认开启;
   * 项目文件传 false:项目待办只有在拖进日记或按发送快捷键时才进日记。
   */
  allowAutoSend?: boolean;
}

export function dailySyncExtension(options: DailySyncOptions = {}): Extension {
  const allowAutoSend = options.allowAutoSend !== false;
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const path = documentPath(u.state);
    if (!path) return;
    const vaultRoot = useAppStore.getState().vaultPath;
    if (!vaultRoot) return;
    const store = peekLinks(vaultRoot);
    if (!store) return; // 尚未加载:本轮不做任何同步(openVault 会触发加载)
    const fileLinks = store.forFile(path);
    const allowSend = allowAutoSend && !isDailyPath(path); // 日记文件自身不产生「发送」(镜像照走)
    if (fileLinks.length === 0 && !allowSend) return;
    const intents: Intent[] = [];
    for (const tr of u.transactions) {
      if (!tr.docChanged) continue;
      if (tr.isUserEvent(SYNC_USER_EVENT)) continue; // 引擎自己写回的事务
      const allowSendTr =
        allowSend && !SEND_SUPPRESS_EVENTS.some((e) => tr.isUserEvent(e));
      tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        intents.push(
          ...intentsForRange(tr.startState.doc, tr.state.doc, fromA, toA, fromB, toB, fileLinks, allowSendTr),
        );
      });
    }
    if (intents.length === 0) return;
    scheduleDailySync(u.view, path, intents);
  });
}

// ---------------------------------------------------------------- 防抖执行

const PENDING_DELAY = 250;
const pending = new Map<
  string,
  { view: EditorView; timer: ReturnType<typeof setTimeout>; intents: Intent[] }
>();

function scheduleDailySync(view: EditorView, path: string, intents: Intent[]): void {
  const cur = pending.get(path);
  if (cur) {
    cur.view = view; // 同一份文件换了实例编辑:以最新的事务来源为准
    cur.intents.push(...intents);
    clearTimeout(cur.timer);
    cur.timer = setTimeout(() => void fireDailySync(path), PENDING_DELAY);
    return;
  }
  const entry = {
    view,
    timer: setTimeout(() => void fireDailySync(path), PENDING_DELAY),
    intents: [...intents],
  };
  pending.set(path, entry);
}

async function fireDailySync(path: string): Promise<void> {
  const entry = pending.get(path);
  pending.delete(path);
  if (!entry) return;
  const view = entry.view;
  // 过期自证:视图还活着、还装着产生意图的那份文件才执行
  if (!view.dom.isConnected || documentPath(view.state) !== path) return;
  const vaultRoot = useAppStore.getState().vaultPath;
  if (!vaultRoot) return;
  const store = peekLinks(vaultRoot);
  if (!store) return;
  const deps: DailyDeps = runtimeDeps();
  try {
    await applyIntents(view, path, entry.intents, deps, store);
  } catch (e) {
    console.warn("daily sync failed", e);
  }
}
