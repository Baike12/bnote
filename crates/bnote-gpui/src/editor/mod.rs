//! Editor modules for the GPUI shell: the vim layer, the live-preview host and
//! the LaTeX-suite snippet host. The parent session owns the wiring into
//! `workspace.rs`.

pub mod preview;
pub mod snippets_host;
pub mod vim;
