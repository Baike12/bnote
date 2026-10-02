import { api } from "@/lib/tauri";
import { todayStamp } from "@/editor/ops";
import { useAppStore } from "@/state/appStore";
import type { DailyDeps, DailyIO } from "./engine";

/** Tauri 后端的文件 IO;读失败(文件不存在等)折叠为 null。 */
export const tauriIO: DailyIO = {
  async readFile(path) {
    try {
      return await api.readFile(path);
    } catch {
      return null;
    }
  },
  writeFile(path, content) {
    return api.writeFile(path, content);
  },
  async readDir(relPath) {
    try {
      const nodes = await api.readDir(relPath);
      return nodes.filter((n) => n.kind === "file").map((n) => n.name);
    } catch {
      return null; // Daily 目录不存在等:没有上一篇可跟
    }
  },
  async listFiles() {
    try {
      return (await api.listFiles()).files;
    } catch {
      return null;
    }
  },
};

/** 应用运行期的同步依赖:仓库根 / 今天 / toast 实时读取。 */
export function runtimeDeps(): DailyDeps {
  return {
    io: tauriIO,
    vaultRoot: () => useAppStore.getState().vaultPath,
    today: () => todayStamp(),
    toast: (msg) => useAppStore.getState().showToast(msg),
  };
}
