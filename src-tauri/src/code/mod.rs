//! 代码项目:文件树、语言识别、语言服务器、git。
//!
//! 这一层的边界是**用户显式打开的那个目录**:项目根就是沙箱边界,根内可
//! 读写、根外拒绝(见 [`project::resolve_in`])。代码项目通常不在 vault 里,
//! 所以不能套 vault 那套约束。

pub mod git;
pub mod lang;
pub mod lsp;
pub mod project;
