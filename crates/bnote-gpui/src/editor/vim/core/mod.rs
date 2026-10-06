//! Pure vim core: zero gpui imports. Text is abstracted behind [`doc::VimText`]
//! so the whole engine runs against a `String`-backed test double.

pub mod doc;
pub mod exec;
pub mod key;
pub mod motion;
pub mod object;
pub mod ops;
pub mod state;

#[allow(unused_imports)] // re-exported for adapters/benches
pub use doc::VimText;
// `feed` is what the engine's own tests drive; the shell goes through
// `feed_apply`, which also writes the planned mode back into the state.
#[allow(unused_imports)]
pub use exec::{feed, feed_apply};
pub use ops::{HostContext, HostIntent, Outcome};
pub use key::Key;
pub use motion::Viewport;
pub use ops::{CursorPlan, Execution};
pub use state::{Mode, VimState};
