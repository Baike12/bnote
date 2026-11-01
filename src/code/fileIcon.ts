/**
 * File tree icon categories: the file name decides which icon and which
 * language color is used.
 *
 * A pure function (it touches no DOM): the icon component picks the shape
 * from the result, and the gate test locks the mapping directly — adding a
 * language only needs one more line here, no change to the component.
 *
 * The categories are deliberately one step coarser than the languages: a 14px
 * icon cannot show the difference between 20 languages, what is really
 * distinguishable are the shapes "folder / code / config / document / style /
 * markup / image / script", each with a language color on top (TS blue, JS
 * amber, Python blue, Rust orange, …).
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

/** File names that are recognized without an extension (compared in lower case). */
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
 * Extension → category. Languages that share a name share one shape, the
 * color is decided by the language: among the code categories only
 * TS/JS/Python/Rust/Go have a color of their own, the rest all use `code`
 * (the neutral color).
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

/** File name → icon category. Directories are filtered out by the caller (it does not look here). */
export function fileIconKind(name: string): FileIconKind {
  const lower = name.toLowerCase();
  const named = NAMED[lower];
  if (named) return named;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "file";
  return EXT[lower.slice(dot + 1)] ?? "file";
}
