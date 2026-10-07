# Third-party notices

bnote-gpui itself is MIT (see `LICENSE` at the repo root). Two embedded pieces
are not, and both travel with the shipped app.

## KaTeX fonts (SIL Open Font License 1.1)

The 20 `KaTeX_*.ttf` faces embedded by `ratex-katex-fonts` — the ones formulas
paint with after `editor::tex::register_fonts` — are unmodified binaries from
the [KaTeX](https://github.com/KaTeX/KaTeX) project, licensed under the SIL
Open Font License 1.1, **not** MIT.

- `docs/third-party/KaTeX-fonts-NOTICE.txt` — copyright holders, Reserved Font
  Names, and the notice from the font metadata.
- `docs/third-party/SIL-OFL-1.1.txt` — the full licence text.

`scripts/make-app.sh` copies both into `bnote-gpui.app/Contents/Resources/`, so
a distributed bundle satisfies the OFL attribution requirement on its own.

## RaTeX (MIT)

The typesetting engine (`ratex-parser` / `ratex-layout` / `ratex-font` /
`ratex-types` / `ratex-katex-fonts`, pinned in `crates/bnote-gpui/Cargo.toml`)
is [RaTeX](https://github.com/erweixin/RaTeX), MIT-licensed.
