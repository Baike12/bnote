//! Code projects: file tree, language detection, language servers, git.
//!
//! The boundary of this layer is **the directory the user explicitly opened**:
//! the project root is the sandbox boundary — reads and writes inside it are
//! allowed, anything outside is rejected (see [`project::resolve_in`]). Code
//! projects usually live outside the vault, so the vault's constraints do not
//! apply here.

pub mod git;
pub mod lang;
pub mod lsp;
pub mod project;
