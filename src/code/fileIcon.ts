/**
 * File tree icons: the file name decides which Material icon is shown.
 *
 * The icon set is the one ZCode ships (`public/material-icons`, the same
 * Material Icon Theme assets): one colored SVG per file type, resolved by file
 * name first and by extension second. The files are looked up by their exact
 * asset name, so an extension that is not in the alias table still gets its own
 * icon when the theme has one (`zig` → `zig.svg`), and only an unknown name
 * falls back to the generic document icon.
 *
 * A pure module (no DOM): the component decides how to paint the result, and
 * the tests lock the name resolution directly.
 */

/** The icon every unresolved name uses. */
export const DEFAULT_FILE_ICON = "document";

/**
 * Full file names (lower case) that map to a specific icon, with the
 * no-extension stem also tried — `vitest.config.ts` resolves through
 * `vitest.config` and then `vitest`.
 */
const FILE_NAME_ICONS: Record<string, string> = {
  ".editorconfig": "editorconfig",
  ".env": "settings",
  ".gitattributes": "git",
  ".gitignore": "git",
  ".npmrc": "npm",
  ".nvmrc": "nodejs_alt",
  ".prettierrc": "prettier",
  ".yarnrc": "yarn",
  // Shell dotfiles are absent from ZCode's table; bnote drew a shell icon for
  // them before the port and keeps one.
  ".bashrc": "console",
  ".bash_profile": "console",
  ".zshrc": "console",
  ".zprofile": "console",
  ".profile": "console",
  ".vimrc": "vim",
  "babel.config": "babel",
  bun: "lock",
  "bun.lock": "lock",
  cargo: "rust",
  "cargo.lock": "lock",
  dockerfile: "docker",
  eslint: "eslint",
  "eslint.config": "eslint",
  gemfile: "gemfile",
  jest: "jest",
  "jest.config": "jest",
  makefile: "makefile",
  "package-lock": "lock",
  "pnpm-lock": "lock",
  readme: "readme",
  tsconfig: "tsconfig",
  vitest: "vitest",
  "vitest.config": "vitest",
  yarn: "yarn",
};

/**
 * Extension → asset name. Only the extensions whose asset name differs from
 * the extension itself live here; everything else is looked up by extension.
 */
const EXTENSION_ICONS: Record<string, string> = {
  backup: "document",
  bash: "console",
  cjs: "javascript",
  cts: "typescript",
  css: "css",
  doc: "word",
  docx: "word",
  go: "go",
  html: "html",
  java: "java",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  jsx: "react",
  json: "json",
  jsonl: "json",
  mjs: "javascript",
  md: "markdown",
  m4a: "audio",
  m4v: "video",
  flac: "audio",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  ogg: "audio",
  opus: "audio",
  mts: "typescript",
  pdf: "pdf",
  php: "php",
  png: "image",
  pptx: "powerpoint",
  py: "python",
  responses: "json",
  rs: "rust",
  sb: "storybook",
  sql: "database",
  sh: "console",
  snap: "snapcraft",
  svg: "svg",
  toml: "toml",
  ts: "typescript",
  tsx: "react_ts",
  txt: "document",
  wav: "audio",
  weba: "audio",
  webm: "video",
  xlsx: "table",
  yaml: "yaml",
  yml: "yaml",
  zsh: "console",
};

/** File name → Material icon name. Directories never reach this: the caller draws them itself. */
export function fileIconName(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");

  // The full name and then every shorter stem is a candidate: `.env.local`
  // still resolves through `.env`, and `tsconfig.base.json` through
  // `tsconfig.base` → `tsconfig`.
  for (let candidate = lower; ;) {
    const named = FILE_NAME_ICONS[candidate];
    if (named) return named;
    const next = candidate.lastIndexOf(".");
    if (next < 0) break;
    candidate = candidate.slice(0, next);
  }

  if (dot === -1) return DEFAULT_FILE_ICON;
  const extension = lower.slice(dot + 1);
  if (!extension) return DEFAULT_FILE_ICON;
  return EXTENSION_ICONS[extension] ?? extension;
}

/** The asset URL of a file's icon; the component falls back to the document icon when it 404s. */
export function fileIconSrc(name: string): string {
  return `${import.meta.env.BASE_URL}material-icons/${fileIconName(name)}.svg`;
}

export const DEFAULT_FILE_ICON_SRC = `${import.meta.env.BASE_URL}material-icons/${DEFAULT_FILE_ICON}.svg`;
