/**
 * 模板:一份普通文本文件,创建文件时把内容写进去。
 *
 * 模板目录是仓库相对路径,其中的文件(含子目录)都可以在「快速添加」命令
 * 与「日记」里被选作模板。模板不注册、不缓存:每次创建时按路径读一次,
 * 改完模板文件立即生效。
 *
 * 变量只有两个——`{{date}}`(YYYY-MM-DD)与 `{{title}}`(新文件名,不含扩展名;
 * 日记里是日期)。未知的 `{{…}}` 原样保留:模板里写别的花括号不该被吃掉。
 */

export interface TemplateVars {
  /** 创建当天的日期,YYYY-MM-DD。 */
  date: string;
  /** 新文件名(不含扩展名);日记里就是日期。 */
  title: string;
}

const TEMPLATE_VAR_RE = /\{\{\s*(date|title)\s*\}\}/g;

/** 把模板里的变量替换成实际值;其余文字逐字节照抄。 */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(TEMPLATE_VAR_RE, (_match, key: "date" | "title") => vars[key]);
}

/**
 * 模板目录的规范形:统一 `/`、去首尾空白与斜杠、丢掉 `.` 段。
 * 含 `..`(会跑出仓库)或为空时返回 ""——即「未设置」。
 */
export function normalizeTemplateDir(dir: string): string {
  const parts = dir
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return "";
  return parts.join("/");
}

/**
 * 模板目录下的模板文件(vault 相对路径,按路径排序)。`files` 是仓库里的
 * 笔记文件列表(store.flatFiles);目录未设置或没有文件时返回空数组。
 */
export function templateFiles(files: string[], dir: string): string[] {
  const root = normalizeTemplateDir(dir);
  if (!root) return [];
  const prefix = `${root}/`;
  return files
    .filter((file) => file.startsWith(prefix))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 模板在选项里的显示名:相对模板目录的路径;不在目录下时原样返回。 */
export function templateLabel(file: string, dir: string): string {
  const root = normalizeTemplateDir(dir);
  const prefix = `${root}/`;
  return root && file.startsWith(prefix) ? file.slice(prefix.length) : file;
}
