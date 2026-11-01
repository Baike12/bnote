import { api } from "@/lib/tauri";
import { todayStamp } from "@/editor/ops";
import { useAppStore } from "@/state/appStore";
import { normalizeTemplateDir } from "@/templates/template";
import type { DailyDeps, DailyIO } from "./engine";

/** File IO of the Tauri backend; a failed read (file does not exist and the like) folds into null. */
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
      return null; // the Daily directory does not exist and the like: no previous note to roll over from
    }
  },
};

/** The current daily note template (vault-relative path); null when unset or the path is invalid. */
export function dailyTemplatePath(): string | null {
  const rel = useAppStore.getState().settings.daily?.template ?? "";
  return normalizeTemplateDir(rel) || null;
}

/** Runtime sync dependencies of the app: vault root / today / toast / daily template, read live. */
export function runtimeDeps(): DailyDeps {
  return {
    io: tauriIO,
    vaultRoot: () => useAppStore.getState().vaultPath,
    today: () => todayStamp(),
    toast: (msg) => useAppStore.getState().showToast(msg),
    templatePath: dailyTemplatePath,
  };
}
