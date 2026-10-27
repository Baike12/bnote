import { api } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import {
  KEY_REGION_IDS,
  applyOverrides,
  bindingEquals,
  defaultBindingsFor,
  flattenOverrides,
  normalizeOverrides,
  regionOfCommand,
  serializeOverrides,
  type BindingMap,
  type BindingValue,
  type KeyRegion,
  type OverrideMap,
} from "./keys";

/**
 * 快捷键覆盖的唯一写入者。
 *
 * 配置跟着仓库走:`<vault>/.bnote/keybindings.json`(与 vimrc / snippets.js
 * 同一个目录),写入走 `write_vault_file` 白名单命令。没有打开仓库时退回旧版
 * 的 `<app_data>/keybindings.json`,保证欢迎页改键也不会丢。
 *
 * 读盘一次性迁移:仓库里还没有 keybindings.json、但应用数据里存着旧版扁平表
 * (命令 → 键位)时,按命令的默认归属分区写进仓库,再把旧文件清空——从此只有
 * 一个来源,不会出现两份配置互相覆盖。
 */

let overrides: OverrideMap = {};
let vaultRoot: string | null = null;
let revision = 0;

const listeners = new Set<() => void>();

export function subscribeKeymap(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/** useSyncExternalStore 的快照:每次覆盖表变化都递增。 */
export function getKeymapRevision(): number {
  return revision;
}

export function keybindingsFilePath(vaultPath: string | null): string | null {
  return vaultPath ? `${vaultPath}/.bnote/keybindings.json` : null;
}

function cloneOverrides(source: OverrideMap): OverrideMap {
  const next: OverrideMap = {};
  for (const region of KEY_REGION_IDS) {
    const map = source[region];
    if (map) next[region] = { ...map };
  }
  return next;
}

function setOverrides(next: OverrideMap): void {
  overrides = next;
  applyOverrides(next);
  notify();
}

function toast(message: string): void {
  useAppStore.getState().showToast(message);
}

function parseFile(text: string | null): OverrideMap | null {
  if (text === null) return null;
  try {
    return normalizeOverrides(JSON.parse(text));
  } catch {
    toast("快捷键配置解析失败,已改用默认键位(文件:.bnote/keybindings.json)");
    return {};
  }
}

/**
 * 写盘串行:连点解绑/改键时两次 IPC 同时发出,完成顺序不保证——排队后
 * 最后一次写完的一定是最后一份内存快照(单一写入者)。
 */
let writeChain: Promise<void> = Promise.resolve();

function persist(): Promise<void> {
  const path = vaultRoot;
  // 快照在入队时取:排在前面的写盘不会把后面的新改动提前写出去。
  const text = path ? serializeOverrides(overrides) : null;
  const flat = path ? null : flattenOverrides(overrides);
  writeChain = writeChain.then(async () => {
    try {
      if (path && text !== null) {
        await api.writeVaultFile("keybindings.json", text);
      } else if (flat) {
        await api.saveKeybindings(flat);
      }
    } catch (e) {
      toast(`保存快捷键失败: ${String(e)}`);
    }
  });
  return writeChain;
}

/**
 * 读取当前仓库的快捷键配置。传 null = 还没开仓库,只读旧版应用配置。
 * 重复调用是安全的(切仓、watcher 触发都会走这里)。
 */
export async function loadKeymap(vaultPath: string | null): Promise<void> {
  vaultRoot = vaultPath;

  if (!vaultPath) {
    const legacy = (await api.loadKeybindings().catch(() => null)) as Record<
      string,
      BindingValue
    > | null;
    setOverrides(normalizeOverrides(legacy));
    return;
  }

  const text = await api.readVaultFile("keybindings.json").catch(() => null);
  const parsed = parseFile(text);
  if (parsed !== null) {
    setOverrides(parsed);
    return;
  }

  // 仓库里还没有配置文件:把旧版应用配置迁进来(一次性)。
  const legacy = (await api.loadKeybindings().catch(() => null)) as Record<
    string,
    BindingValue
  > | null;
  const migrated = normalizeOverrides(legacy);
  setOverrides(migrated);
  if (Object.keys(flattenOverrides(migrated)).length === 0) return;
  try {
    await api.writeVaultFile("keybindings.json", serializeOverrides(migrated));
    // 迁移成功才清旧表:万一写仓库失败,下次启动还能再迁一次。
    await api.saveKeybindings({});
  } catch (e) {
    toast(`迁移快捷键配置失败: ${String(e)}`);
  }
}

/** 重新读当前仓库的配置(外部编辑 / 切仓后)。 */
export async function reloadKeymap(): Promise<void> {
  await loadKeymap(vaultRoot);
}

export async function setOverride(
  id: string,
  value: BindingValue,
  region: KeyRegion = regionOfCommand(id),
): Promise<void> {
  const next = cloneOverrides(overrides);
  // 只动这一个区域:同一条命令在别的区域的绑定保持不变。
  const isDefault = bindingEquals(defaultBindingsFor(id, region), value);
  if (isDefault) {
    if (next[region]) delete next[region][id];
  } else {
    (next[region] ??= {})[id] = value;
  }
  setOverrides(next);
  await persist();
}

/** 删掉一个区域的覆盖(回到内置默认)。不传区域 = 所有区域。 */
export async function clearOverride(id: string, region?: KeyRegion): Promise<void> {
  const next = cloneOverrides(overrides);
  for (const r of region ? [region] : KEY_REGION_IDS) {
    if (next[r]) delete next[r][id];
  }
  setOverrides(next);
  await persist();
}

export async function resetAllOverrides(): Promise<void> {
  setOverrides({});
  await persist();
}

/** 读当前覆盖表(设置页的「已改」标记、测试用)。 */
export function getOverrides(): OverrideMap {
  return overrides;
}

export type { BindingMap, BindingValue, KeyRegion, OverrideMap };
