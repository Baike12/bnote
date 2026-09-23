import { type RawSnippet } from "./default-snippets";
import { builtinSnippets, reloadSnippets } from "./engine";

/**
 * 片段来源的单一所有者：哪一份片段处于加载状态（内置 or 仓库 snippets.js）。
 * 设置应用（applySettingsToEditor）只允许通过 applySnippetsEnabled 翻开关，
 * 不许碰来源——否则每次打开文件/改设置都会把用户片段打回内置（真实回归）。
 * 来源的写入只走 applySnippetSource / SnippetLoader。
 */
let currentRaws: RawSnippet[] | null = null;

/** 当前加载的用户片段；null 表示使用内置。 */
export function currentUserSnippets(): RawSnippet[] | null {
  return currentRaws;
}

/** 替换片段来源（含编译）。enabled 一并生效。 */
export function applySnippetSource(raws: RawSnippet[] | null, enabled: boolean): void {
  currentRaws = raws;
  reloadSnippets(raws, enabled);
}

/** 只翻转启用开关，保留已加载的来源。设置应用统一走这里。 */
export function applySnippetsEnabled(enabled: boolean): void {
  reloadSnippets(currentRaws, enabled);
}

export interface SnippetLoadOutcome {
  /** user=用户片段已生效；builtin=回退内置；error=加载失败(已在编辑器侧回退内置) */
  status: "user" | "builtin" | "error";
  /** 实际生效的条数：user 为导出条数，builtin 为内置条数 */
  count: number;
  error?: string;
}

function builtinOutcome(): SnippetLoadOutcome {
  return { status: "builtin", count: builtinSnippets.list.length };
}

/** 校验动态导入的模块形状：默认导出的数组，或裸数组(mod.exports 风格)。 */
export function normalizeSnippetExport(mod: unknown): RawSnippet[] {
  const data = (mod as { default?: unknown } | null)?.default ?? mod;
  if (!Array.isArray(data)) {
    throw new Error("snippets.js 必须 default 导出片段数组(export default [...])");
  }
  return data as RawSnippet[];
}

/** Blob URL 动态导入：src 以 ESM 执行，片段文件可以是任意 JS。 */
export async function importSnippetModule(src: string): Promise<RawSnippet[]> {
  const blob = new Blob([src], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const mod = await import(/* @vite-ignore */ url);
    return normalizeSnippetExport(mod);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 带内容缓存的片段装载器。仓库事件每 300ms 防抖一次、任何文件改动都会
 * 触发 reload——同内容重复导入(编译 130+ 片段)必须被拦掉；来源未变而
 * 开关变化时只翻开关，同样不重编译。
 */
export class SnippetLoader {
  private lastSrc: string | null = null;
  private lastEnabled = true;
  private lastOutcome: SnippetLoadOutcome;

  constructor(private readonly importer: (src: string) => Promise<RawSnippet[]>) {
    this.lastOutcome = builtinOutcome();
  }

  /** 名字取 load 而不是 apply：`apply(null, …)` 会撞上 eslint 的 prefer-spread。 */
  async load(src: string | null, enabled: boolean): Promise<SnippetLoadOutcome> {
    if (src === this.lastSrc) {
      if (enabled !== this.lastEnabled) {
        this.lastEnabled = enabled;
        applySnippetsEnabled(enabled);
      }
      return this.lastOutcome;
    }
    this.lastSrc = src;
    this.lastEnabled = enabled;
    if (!src) {
      applySnippetSource(null, enabled);
      this.lastOutcome = builtinOutcome();
      return this.lastOutcome;
    }
    try {
      const raws = await this.importer(src);
      applySnippetSource(raws, enabled);
      this.lastOutcome = { status: "user", count: raws.length };
    } catch (e) {
      // 语法错误/导出形状不对/CSP 拦截都落在这里：编辑器立即回退内置，
      // 错误交给调用方展示（用户文件改动时 toast，不吞进 console）。
      applySnippetSource(null, enabled);
      this.lastOutcome = { status: "error", count: 0, error: String(e) };
    }
    return this.lastOutcome;
  }
}

export const snippetLoader = new SnippetLoader(importSnippetModule);
