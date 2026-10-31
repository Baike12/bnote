import { api } from "@/lib/tauri";
import { todayStamp } from "@/editor/ops";
import { useAppStore } from "@/state/appStore";
import { normalizeTemplateDir } from "@/templates/template";
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
};

/** 当前日记模板(仓库相对路径);未设置或路径非法时为 null。 */
export function dailyTemplatePath(): string | null {
  const rel = useAppStore.getState().settings.daily?.template ?? "";
  return normalizeTemplateDir(rel) || null;
}

/** 应用运行期的同步依赖:仓库根 / 今天 / toast / 日记模板 实时读取。 */
export function runtimeDeps(): DailyDeps {
  return {
    io: tauriIO,
    vaultRoot: () => useAppStore.getState().vaultPath,
    today: () => todayStamp(),
    toast: (msg) => useAppStore.getState().showToast(msg),
    templatePath: dailyTemplatePath,
  };
}
