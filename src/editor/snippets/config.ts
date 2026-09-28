/**
 * latex-suite 的 `wordDelimiters` 默认值:`"., +-\n\t:;!?\\/{}[]()=~$"`。
 * 逗号串里的 `\n` 是字面两字符,使用时还原成真换行(见 engine 的 isWordBoundary)。
 */
export const LATEX_SUITE_WORD_DELIMITERS = "., +-\n\t:;!?\\/{}[]()=~$";

/**
 * LaTeX Suite 的设置项,逐项对应 obsidian-latex-suite 的同名设置(见
 * obsidian-vim-input-auto-switch/manifest.json 里 id=obsidian-latex-suite 的
 * 那份插件,源码路径记在 AGENTS.md)。默认值取插件的默认值,也正是用户
 * data.json 里的取值;字段名照插件命名,便于和插件源码逐条对照。
 *
 * 这里是模块级可变状态(与 `snippetStore` 同款):持久化在应用设置里,
 * applySettingsToEditor 时灌进来;编辑器扩展直接读它,免去在扩展里穿 store。
 * 本模块刻意不 import 任何东西——appStore 要引用它的类型与默认值,不能被
 * 拖进编辑器依赖图。
 */
export interface LatexConfig {
  /** 括号内出现触发词时自动升级成 \left…\right(自动分数后无条件跑一次) */
  autoEnlargeBrackets: boolean;
  /** 放大触发词,子串匹配(插件 autoEnlargeBracketsTriggers) */
  autoEnlargeTriggers: string[];
  /** 矩阵环境里 Shift+Tab 插 ` & `、Enter 插 ` \\` 换行(插件 matrixShortcutsEnabled) */
  matrixShortcuts: boolean;
  /** 矩阵环境名(插件 matrixShortcutsEnvNames) */
  matrixEnvs: string[];
  /** Tab 走完片段后跳出括号/公式块(插件 taboutEnabled) */
  tabout: boolean;
  /** 括号彩色配对(插件 colorPairedBracketsEnabled) */
  bracketColors: boolean;
  /** 光标处括号与配对括号高亮(插件 highlightCursorBracketsEnabled) */
  highlightCursorBrackets: boolean;
  /** 光标夹在两个 $ 之间按 Backspace 一次删掉两个(插件 autoDelete$) */
  autoDeleteDollar: boolean;
  /** 行内公式里展开片段后去掉多余空格(插件 removeSnippetWhitespace) */
  removeSnippetWhitespace: boolean;
  /** `w`(词边界)片段的分隔符集合(插件 wordDelimiters,逗号串里的 \n 是字面两字符) */
  wordDelimiters: string;
}

export const DEFAULT_LATEX_CONFIG: LatexConfig = {
  autoEnlargeBrackets: true,
  autoEnlargeTriggers: ["sum", "int", "frac", "prod", "bigcup", "bigcap"],
  matrixShortcuts: true,
  matrixEnvs: [
    "pmatrix",
    "cases",
    "align",
    "bmatrix",
    "Bmatrix",
    "vmatrix",
    "Vmatrix",
    "array",
    "matrix",
  ],
  bracketColors: true,
  highlightCursorBrackets: true,
  autoDeleteDollar: true,
  removeSnippetWhitespace: true,
  tabout: true,
  wordDelimiters: LATEX_SUITE_WORD_DELIMITERS,
};

let current: LatexConfig = { ...DEFAULT_LATEX_CONFIG };

/** 当前设置(编辑器扩展在读键时调用,不要缓存到闭包里)。 */
export function latexConfig(): LatexConfig {
  return current;
}

export function configureLatexSuite(patch: Partial<LatexConfig>): void {
  current = { ...current, ...patch };
}

/** 恢复默认(测试与「恢复内置」用)。 */
export function resetLatexConfig(): void {
  current = { ...DEFAULT_LATEX_CONFIG };
}
