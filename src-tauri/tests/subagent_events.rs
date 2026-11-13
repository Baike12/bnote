//! Guard rail: a subagent's lifecycle is announced on the *parent's* channel.
//!
//! The panel routes every `agent-event` by the payload's `sessionId`, and it
//! only knows the conversations the user owns. `Session::emit` stamps
//! `sessionId` with the emitting session's id, so emitting `SubagentStart` /
//! `SubagentEnd` from the child put the child id in that field: the panel
//! dropped both as an unknown session and the agent never appeared — the
//! child's own deltas (which carry its id on purpose) had nowhere to land
//! either, so nothing of a subagent was visible at all.
//!
//! The rule is type-free (both are `&Session`), so it is pinned here: those two
//! events may only be emitted from a handle that is not the child.

use std::fs;
use std::path::Path;

#[test]
fn subagent_lifecycle_events_are_never_emitted_on_the_child_session() {
    let session = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/agent/session.rs");
    let source = fs::read_to_string(&session).expect("read session.rs");

    for child in ["runner_child", "child_for_task", "child"] {
        for event in ["SubagentStart", "SubagentEnd"] {
            let pattern = format!("{child}.emit(AgentEvent::{event}");
            assert!(
                !source.contains(&pattern),
                "`{pattern}` puts the child's session id in the payload; the panel \
                 would drop the event (emit it on the parent instead)"
            );
        }
    }

    // The positive side: both events are still emitted somewhere.
    for event in ["SubagentStart", "SubagentEnd"] {
        assert!(
            source.contains(&format!("AgentEvent::{event}")),
            "{event} is no longer emitted at all"
        );
    }
}
