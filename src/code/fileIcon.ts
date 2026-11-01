/**
 * 文件树图标分类:按文件名决定用哪个图标与哪种语言色。
 *
 * 纯函数(不碰 DOM):图标组件按这里的结果挑形状,门禁直接锁映射——
 * 加一种语言只需要在这里加一行,不用改组件。
 *
 * 分类比语言粗一档是故意的:14px 的图标画不出 20 种语言的差异,真正可辨
 * 的是「文件夹 / 代码 / 配置 / 文档 / 样式 / 标记 / 图片 / 脚本」这几种形状,
 * 再叠上语言色(TS 蓝、JS 琥珀、Python 蓝、Rust 橙…)。
 */

export type FileIconKind =
  | "ts"
  | "js"
  | "py"
  | "rs"
  | "go"
  | "code"
  | "data"
  | "doc"
  | "style"
  | "markup"
  | "image"
  | "shell"
  | "file";

/** 没有扩展名也要认的文件名(小写比较)。 */
const NAMED: Record<string, FileIconKind> = {
  dockerfile: "code",
  makefile: "code",
  cmakelists: "code",
  rakefile: "code",
  gemfile: "code",
  procfile: "code",
  ".gitignore": "data",
  ".gitattributes": "data",
  ".gitmodules": "data",
  ".editorconfig": "data",
  ".env": "data",
  ".npmrc": "data",
  ".nvmrc": "data",
  ".prettierrc": "data",
  ".eslintrc": "data",
  ".babelrc": "data",
  "tsconfig": "data",
  "jsconfig": "data",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".zshrc": "shell",
  ".zprofile": "shell",
  ".profile": "shell",
  ".vimrc": "data",
};

/**
 * 扩展名 → 分类。同名语言共用一种形状,颜色由语言决定:
 * 代码类只有 TS/JS/Python/Rust/Go 有专属色,其余统一走 `code`(中性色)。
 */
const EXT: Record<string, FileIconKind> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "py",
  pyi: "py",
  pyw: "py",
  rs: "rs",
  go: "go",
  "c": "code",
  h: "code",
  cpp: "code",
  cc: "code",
  cxx: "code",
  "hpp": "code",
  hh: "code",
  hxx: "code",
  m: "code",
  mm: "code",
  cs: "code",
  java: "code",
  kt: "code",
  kts: "code",
  swift: "code",
  rb: "code",
  php: "code",
  lua: "code",
  sql: "code",
  scala: "code",
  dart: "code",
  zig: "code",
  ex: "code",
  exs: "code",
  erl: "code",
  hrl: "code",
  hs: "code",
  clj: "code",
  cljs: "code",
  pl: "code",
  pm: "code",
  "r": "code",
  jl: "code",
  nim: "code",
  v: "code",
  sv: "code",
  vhd: "code",
  asm: "code",
  json: "data",
  jsonc: "data",
  json5: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  ini: "data",
  cfg: "data",
  conf: "data",
  env: "data",
  properties: "data",
  lock: "data",
  plist: "data",
  md: "doc",
  mdx: "doc",
  markdown: "doc",
  txt: "doc",
  rst: "doc",
  adoc: "doc",
  org: "doc",
  tex: "doc",
  bib: "doc",
  pdf: "doc",
  doc: "doc",
  docx: "doc",
  rtf: "doc",
  css: "style",
  scss: "style",
  sass: "style",
  less: "style",
  styl: "style",
  html: "markup",
  htm: "markup",
  xhtml: "markup",
  xml: "markup",
  vue: "markup",
  svelte: "markup",
  astro: "markup",
  hbs: "markup",
  ejs: "markup",
  pug: "markup",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  icns: "image",
  tif: "image",
  tiff: "image",
  avif: "image",
  heic: "image",
  svg: "image",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "shell",
  psm1: "shell",
  bat: "shell",
  cmd: "shell",
  ksh: "shell",
};

/** 文件名 → 图标分类。目录由调用方先判掉(它不看这里)。 */
export function fileIconKind(name: string): FileIconKind {
  const lower = name.toLowerCase();
  const named = NAMED[lower];
  if (named) return named;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "file";
  return EXT[lower.slice(dot + 1)] ?? "file";
}
