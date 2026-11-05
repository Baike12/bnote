//! Cancellation for one agent turn.
//!
//! Two rules the type encodes:
//!
//! 1. **A child observes its parent's abort, never the reverse.** A subagent's
//!    own stop must not end the parent turn, and a parent stop must stop every
//!    child it is waiting on (otherwise the stop button leaves a subagent
//!    running against the same vault).
//! 2. **Abort is sticky within a turn and reset at the start of the next one.**
//!    The previous contract cleared the flag inside the loop, so an abort that
//!    arrived while the final model stream was still running stayed set and the
//!    *next* user message hit the clearing branch and was swallowed. `reset` is
//!    called exactly once, by `send`/`run_wakeup`, before the message enters the
//!    history.
//!
//! Polling (50 ms) instead of a notify keeps the parent → child wake-up free of
//! a shared async primitive: the same cadence the bash tool already uses.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const POLL_INTERVAL: Duration = Duration::from_millis(50);

pub struct Abort {
    flag: AtomicBool,
    parent: Option<Arc<Abort>>,
}

impl Abort {
    pub fn new() -> Arc<Abort> {
        Arc::new(Abort {
            flag: AtomicBool::new(false),
            parent: None,
        })
    }

    /// A turn-scoped child of `self`.
    pub fn child(self: &Arc<Self>) -> Arc<Abort> {
        Arc::new(Abort {
            flag: AtomicBool::new(false),
            parent: Some(self.clone()),
        })
    }

    pub fn abort(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    /// Start of a new turn: only this token, never the parent chain.
    pub fn reset(&self) {
        self.flag.store(false, Ordering::SeqCst);
    }

    pub fn is_aborted(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
            || self
                .parent
                .as_ref()
                .map(|p| p.is_aborted())
                .unwrap_or(false)
    }

    /// Resolves once this token or any ancestor is aborted.
    pub async fn wait(&self) {
        while !self.is_aborted() {
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_child_sees_the_parents_abort_but_not_the_other_way_round() {
        let parent = Abort::new();
        let child = parent.child();
        assert!(!child.is_aborted());
        parent.abort();
        assert!(child.is_aborted(), "the child must observe the parent");
        assert!(parent.is_aborted());
    }

    #[test]
    fn aborting_the_child_leaves_the_parent_running() {
        let parent = Abort::new();
        let child = parent.child();
        child.abort();
        assert!(child.is_aborted());
        assert!(!parent.is_aborted());
    }

    #[test]
    fn reset_only_clears_the_receiving_token() {
        let parent = Abort::new();
        let child = parent.child();
        parent.abort();
        child.reset();
        assert!(parent.is_aborted(), "reset must not clear the parent");
        assert!(
            child.is_aborted(),
            "the parent chain still aborts the child"
        );
    }

    #[tokio::test]
    async fn wait_returns_for_a_parent_abort() {
        let parent = Abort::new();
        let child = parent.child();
        let handle = {
            let child = child.clone();
            tokio::spawn(async move { child.wait().await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        parent.abort();
        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("wait must resolve on a parent abort")
            .expect("task must not panic");
    }
}
