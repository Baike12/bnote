//! Editor modules for the GPUI shell: the vim layer, the live-preview host
//! (with its image loader) and the LaTeX-suite snippet host. The parent
//! session owns the wiring into `workspace.rs`.

pub mod images;
pub mod preview;
pub mod snippets_host;
pub mod vim;
