//! Per-session event fan-out for remote clients.
//!
//! `Session::emit` already pushes to the desktop through Tauri; the phone has
//! no Tauri, so every event is also appended here. Sequence allocation, ring
//! insertion and the broadcast happen under one lock, which is what makes
//! `resume { afterEventSeq }` safe: a subscriber can never observe seq 2
//! before seq 1.

use std::collections::VecDeque;
use std::sync::Mutex;

use tokio::sync::broadcast;

use crate::agent::types::AgentEvent;

pub const RING: usize = 2000;
const TURN_TEXT_CAP: usize = 256 << 10;

#[derive(Debug, Clone)]
pub struct EventRecord {
    /// The live session that produced the event (a subagent has its own id;
    /// the transport wrapper routes by it).
    pub session_id: String,
    /// Sequence in the root session's stream.
    pub seq: u64,
    pub event: AgentEvent,
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
    pub done: bool,
    pub output: String,
}

/// The in-progress turn as the stream has drawn it so far. Snapshots carry it
/// because `Session.items` only gains the assistant message when the provider
/// round returns — a mid-turn reattach would otherwise lose the live reply.
#[derive(Debug, Clone, Default)]
pub struct TurnAccumulator {
    pub started_at: u64,
    pub text: String,
    pub thinking: String,
    pub tools: Vec<ToolCall>,
}

impl TurnAccumulator {
    fn apply(&mut self, event: &AgentEvent) {
        match event {
            AgentEvent::TextDelta { text } => append_capped(&mut self.text, text),
            AgentEvent::ThinkingDelta { text } => append_capped(&mut self.thinking, text),
            AgentEvent::ToolStart { id, name, input } => self.tools.push(ToolCall {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
                done: false,
                output: String::new(),
            }),
            AgentEvent::ToolEnd { id, output, .. } => {
                if let Some(tool) = self.tools.iter_mut().find(|t| t.id == *id) {
                    tool.done = true;
                    tool.output = truncate(output, 8 << 10);
                }
            }
            _ => {}
        }
    }
}

fn append_capped(target: &mut String, text: &str) {
    if target.len() >= TURN_TEXT_CAP {
        return;
    }
    let room = TURN_TEXT_CAP - target.len();
    if text.len() <= room {
        target.push_str(text);
    } else {
        // A multi-byte character must not be split; the cap is approximate.
        let end = text.floor_char_boundary(room);
        target.push_str(&text[..end]);
    }
}

fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let end = text.floor_char_boundary(limit);
    format!("{}…[truncated]", &text[..end])
}

struct Inner {
    next_seq: u64,
    ring: VecDeque<EventRecord>,
    turn: Option<TurnAccumulator>,
}

pub struct SessionEventBus {
    root_id: String,
    inner: Mutex<Inner>,
    tx: broadcast::Sender<EventRecord>,
}

impl SessionEventBus {
    pub fn new(root_id: String) -> Self {
        let (tx, _) = broadcast::channel(512);
        Self {
            root_id,
            inner: Mutex::new(Inner {
                next_seq: 0,
                ring: VecDeque::with_capacity(RING),
                turn: None,
            }),
            tx,
        }
    }

    pub fn publish(&self, session_id: &str, event: AgentEvent) -> u64 {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.next_seq += 1;
        let seq = inner.next_seq;
        let record = EventRecord {
            session_id: session_id.to_string(),
            seq,
            event: event.clone(),
        };
        if let Some(turn) = inner.turn.as_mut() {
            match &event {
                AgentEvent::TurnEnd { .. } | AgentEvent::Error { .. } => inner.turn = None,
                _ => turn.apply(&event),
            }
        }
        if session_id == self.root_id {
            match &event {
                AgentEvent::TurnStart { .. } => {
                    inner.turn = Some(TurnAccumulator {
                        started_at: now_ms(),
                        ..TurnAccumulator::default()
                    });
                }
                AgentEvent::UserMessage { .. } if inner.turn.is_none() => {
                    inner.turn = Some(TurnAccumulator {
                        started_at: now_ms(),
                        ..TurnAccumulator::default()
                    });
                }
                _ => {}
            }
        }
        inner.ring.push_back(record.clone());
        while inner.ring.len() > RING {
            inner.ring.pop_front();
        }
        let _ = self.tx.send(record);
        seq
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EventRecord> {
        self.tx.subscribe()
    }

    /// Events strictly after `after`. `gap` means the ring no longer holds the
    /// first missing event, so the client must take a snapshot instead.
    pub fn replay_after(&self, after: u64) -> (Vec<EventRecord>, bool) {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let oldest = inner
            .ring
            .front()
            .map(|r| r.seq)
            .unwrap_or(inner.next_seq + 1);
        if after > inner.next_seq || after + 1 < oldest {
            return (Vec::new(), true);
        }
        let events = inner
            .ring
            .iter()
            .filter(|r| r.seq > after)
            .cloned()
            .collect();
        (events, false)
    }

    pub fn turn(&self) -> Option<TurnAccumulator> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .turn
            .clone()
    }

    pub fn event_seq(&self) -> u64 {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .next_seq
    }

    pub fn reset(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.turn = None;
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delta(text: &str) -> AgentEvent {
        AgentEvent::TextDelta { text: text.into() }
    }

    #[test]
    fn seq_is_monotonic_and_replay_is_exact() {
        let bus = SessionEventBus::new("root".into());
        assert_eq!(bus.publish("root", delta("a")), 1);
        assert_eq!(bus.publish("child", delta("b")), 2);
        assert_eq!(bus.publish("root", delta("c")), 3);

        let (events, gap) = bus.replay_after(1);
        assert!(!gap);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].seq, 2);
        assert_eq!(events[0].session_id, "child");

        let (none, gap) = bus.replay_after(3);
        assert!(none.is_empty());
        assert!(!gap);
    }

    #[test]
    fn ring_overflow_requests_a_snapshot() {
        let bus = SessionEventBus::new("root".into());
        for i in 0..(RING + 5) {
            bus.publish("root", delta(&i.to_string()));
        }
        let (events, gap) = bus.replay_after(1);
        assert!(gap);
        assert!(events.is_empty());
    }

    #[test]
    fn turn_accumulator_tracks_text_and_tools() {
        let bus = SessionEventBus::new("root".into());
        bus.publish("root", AgentEvent::TurnStart { items: 1 });
        bus.publish("root", delta("你好"));
        bus.publish(
            "root",
            AgentEvent::ToolStart {
                id: "t1".into(),
                name: "Read".into(),
                input: serde_json::json!({"path": "a"}),
            },
        );
        bus.publish(
            "root",
            AgentEvent::ToolEnd {
                id: "t1".into(),
                ok: true,
                output: "x".repeat(20 << 10),
                images: Vec::new(),
            },
        );
        let turn = bus.turn().expect("turn");
        assert_eq!(turn.text, "你好");
        assert_eq!(turn.tools.len(), 1);
        assert!(turn.tools[0].done);
        assert!(turn.tools[0].output.len() < 9 << 10);
        assert!(turn.tools[0].output.ends_with("…[truncated]"));

        bus.publish(
            "root",
            AgentEvent::TurnEnd {
                reason: "end".into(),
                items: 3,
            },
        );
        assert!(bus.turn().is_none());
    }

    #[test]
    fn child_events_do_not_start_the_root_turn() {
        let bus = SessionEventBus::new("root".into());
        bus.publish("child", AgentEvent::TurnStart { items: 0 });
        assert!(bus.turn().is_none());
    }
}
