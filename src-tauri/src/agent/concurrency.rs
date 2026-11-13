//! The ceiling on concurrently *running* subagents, one gate per session.
//!
//! The tool scheduler already runs a batch of concurrency-safe calls in
//! parallel (see `Session::execute_calls`), so N `Agent` calls in one message
//! start together. This gate is the second half of that contract: the user
//! picks a number (settings → 子代理并发), and calls beyond it wait here
//! instead of all hitting the gateway at once.
//!
//! The limit is read on every acquire and can be raised or lowered at runtime
//! (a settings save pushes it into the open sessions). Lowering takes effect as
//! running slots return: the gate never kills work that already started, it
//! only stops admitting new work above the new ceiling.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

/// What a fresh install starts with. codex's `[agents]` default is 4 (its V2
/// subagent limiter is 3 + root); CC's tool batch is 10. Four keeps a typical
/// provider's rate limit comfortable while still making "spawn three agents"
/// feel parallel.
pub const DEFAULT_LIMIT: usize = 4;
/// The settings page clamps to this: more than ten concurrent model streams is
/// noise, not parallelism anyone can read.
pub const MAX_LIMIT: usize = 10;

pub struct AgentGate {
    limit: AtomicUsize,
    active: AtomicUsize,
    notify: Notify,
}

impl AgentGate {
    pub fn new(limit: usize) -> Arc<AgentGate> {
        Arc::new(AgentGate {
            limit: AtomicUsize::new(clamp_limit(limit)),
            active: AtomicUsize::new(0),
            notify: Notify::new(),
        })
    }

    pub fn limit(&self) -> usize {
        self.limit.load(Ordering::SeqCst)
    }

    pub fn active(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }

    /// Replaces the ceiling. Waiters are woken so a raise is felt at once; a
    /// lower ceiling simply stops admitting until the active count drops.
    pub fn set_limit(&self, limit: usize) {
        self.limit.store(clamp_limit(limit), Ordering::SeqCst);
        // `notify_one` also leaves a permit for a waiter that has not been
        // polled yet (the loop below checks before sleeping, so this only
        // closes the gap between the check and the registration).
        self.notify.notify_waiters();
        self.notify.notify_one();
    }

    /// Waits for a slot and returns the guard that releases it.
    pub async fn acquire(self: &Arc<Self>) -> AgentSlot {
        loop {
            let notified = self.notify.notified();
            if let Some(slot) = self.try_acquire() {
                return slot;
            }
            notified.await;
        }
    }

    fn try_acquire(self: &Arc<Self>) -> Option<AgentSlot> {
        loop {
            let limit = self.limit.load(Ordering::SeqCst);
            let active = self.active.load(Ordering::SeqCst);
            if active >= limit {
                return None;
            }
            if self
                .active
                .compare_exchange(active, active + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return Some(AgentSlot {
                    gate: Arc::clone(self),
                });
            }
            // Another waiter took the slot: re-read the limit and retry.
        }
    }
}

fn clamp_limit(limit: usize) -> usize {
    limit.clamp(1, MAX_LIMIT)
}

/// One running subagent's slot. Dropping it (normal return, abort, panic) frees
/// the slot and wakes one waiter.
pub struct AgentSlot {
    gate: Arc<AgentGate>,
}

impl Drop for AgentSlot {
    fn drop(&mut self) {
        self.gate.active.fetch_sub(1, Ordering::SeqCst);
        self.gate.notify.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn the_limit_is_clamped_into_the_settings_range() {
        assert_eq!(AgentGate::new(0).limit(), 1);
        assert_eq!(AgentGate::new(99).limit(), MAX_LIMIT);
        assert_eq!(AgentGate::new(DEFAULT_LIMIT).limit(), DEFAULT_LIMIT);
    }

    #[tokio::test]
    async fn calls_beyond_the_limit_wait_for_a_slot_and_then_run() {
        let gate = AgentGate::new(2);
        let a = gate.acquire().await;
        let b = gate.acquire().await;
        assert_eq!(gate.active(), 2);

        // The third caller must not get through while both slots are held.
        let third = tokio::spawn({
            let gate = gate.clone();
            async move {
                let slot = gate.acquire().await;
                gate.active()
            }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!third.is_finished(), "第三个调用必须排队等槽位");

        drop(a);
        let active_when_third_ran = tokio::time::timeout(Duration::from_secs(2), third)
            .await
            .expect("释放槽位后排队者必须被唤醒")
            .expect("join");
        assert_eq!(active_when_third_ran, 2, "排队者拿到的是一个真实槽位");
        drop(b);
    }

    #[tokio::test]
    async fn raising_the_limit_admits_waiters_without_a_release() {
        let gate = AgentGate::new(1);
        let held = gate.acquire().await;
        let waiting = tokio::spawn({
            let gate = gate.clone();
            async move {
                let _slot = gate.acquire().await;
            }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiting.is_finished());

        gate.set_limit(2);
        tokio::time::timeout(Duration::from_secs(2), waiting)
            .await
            .expect("提高上限要立刻放行")
            .expect("join");
        drop(held);
    }

    #[tokio::test]
    async fn lowering_the_limit_stops_admitting_new_work_until_slots_return() {
        let gate = AgentGate::new(3);
        let a = gate.acquire().await;
        let b = gate.acquire().await;
        let c = gate.acquire().await;
        assert_eq!(gate.active(), 3);

        gate.set_limit(1);
        let next = tokio::spawn({
            let gate = gate.clone();
            async move {
                let _slot = gate.acquire().await;
            }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !next.is_finished(),
            "缩容后 active(3) 仍高于新上限(1),不得再放行"
        );

        drop(a);
        drop(b);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!next.is_finished(), "active=1 仍等于上限，不能超过");

        drop(c);
        tokio::time::timeout(Duration::from_secs(2), next)
            .await
            .expect("降到上限以下后要放行")
            .expect("join");
    }
}
