import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorApi } from "@/editor/api";
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
 */

const RECORD_SUPPRESS_EVENTS = ["input.paste", "input.drop"];

export function dailySyncExtension(): Extension {
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const path = documentPath(u.state);
    if (!path) return;
    const vaultRoot = useAppStore.getState().vaultPath;
    if (!vaultRoot) return;
    const store = peekLinks(vaultRoot);
    if (!store) return; // 尚未加载:本轮不做任何同步(openVault 会触发加载)
    const fileLinks = store.forFile(path);
    const allowRecord = !isDailyPath(path); // 日记文件里勾选不产生「记录」
    if (fileLinks.length === 0 && !allowRecord) return;
    const intents: Intent[] = [];
    for (const tr of u.transactions) {
      if (!tr.docChanged) continue;
      if (tr.isUserEvent(SYNC_USER_EVENT)) continue; // 引擎自己写回的事务
      const allowRecordTr =
        allowRecord && !RECORD_SUPPRESS_EVENTS.some((e) => tr.isUserEvent(e));
      tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        intents.push(
          ...intentsForRange(tr.startState.doc, tr.state.doc, fromA, toA, fromB, toB, fileLinks, allowRecordTr),
        );
      });
    }
    if (intents.length === 0) return;
    scheduleDailySync(path, intents);
  });
}

// ---------------------------------------------------------------- 防抖执行

const PENDING_DELAY = 250;
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; intents: Intent[] }>();

function scheduleDailySync(path: string, intents: Intent[]): void {
  const cur = pending.get(path);
  if (cur) {
    cur.intents.push(...intents);
    clearTimeout(cur.timer);
    cur.timer = setTimeout(() => void fireDailySync(path), PENDING_DELAY);
    return;
  }
  const entry = { timer: setTimeout(() => void fireDailySync(path), PENDING_DELAY), intents: [...intents] };
  pending.set(path, entry);
}

async function fireDailySync(path: string): Promise<void> {
  const entry = pending.get(path);
  pending.delete(path);
  if (!entry) return;
  const view = editorApi.view;
  // 过期自证:视图还活着、还装着产生意图的那份文件才执行
  if (!view || !view.dom.isConnected || documentPath(view.state) !== path) return;
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
