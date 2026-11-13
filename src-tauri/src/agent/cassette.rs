//! Record real model traffic as frame-level cassettes.
//!
//! Set `BNOTE_CASSETTE_DIR=<folder>` before starting the app (or a test) and
//! every successful SSE response is written under that folder:
//!
//! ```text
//! <folder>/
//!   manifest.json
//!   0001-request.json          the exact request body and its metadata
//!   0001-response/meta.json    status, content type, frame count
//!   0001-response/frames/0001.sse
//!   0001-response/frames/0002.sse
//! ```
//!
//! Each `.sse` file is one complete SSE frame, byte for byte as received
//! (separator included); a truncated stream leaves its last partial frame as
//! `NNNN-partial.sse`. The replay server in `tests/common` feeds those files
//! back through a real HTTP socket, so the harness sees the same wire format
//! and chunk boundaries it saw during recording.
//!
//! Recording is best effort, like [`super::request_log`]: a folder that cannot
//! be written says so on stderr and the turn continues. The request body is
//! stored verbatim (no authorization header is ever read), so a cassette
//! contains the prompts and notes that were part of the conversation.

use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Directory to record into; unset or empty disables recording.
pub const DIR_ENV: &str = "BNOTE_CASSETTE_DIR";

static RECORDER: OnceLock<Option<Arc<Recorder>>> = OnceLock::new();

/// Starts recording interactively for one provider attempt. `None` when
/// recording is off, or when the request could not be written.
///
/// Call this only after the response head arrived: a retry that never produced
/// a response is an HTTP-attempt concern, not a stream cassette.
pub fn begin(
    protocol: &str,
    url: &str,
    model: &str,
    session: &str,
    purpose: &str,
    thinking: bool,
    status: u16,
    body: &Value,
) -> Option<Interaction> {
    let recorder = RECORDER.get_or_init(open_from_env).as_ref()?;
    recorder.begin(
        protocol, url, model, session, purpose, thinking, status, body,
    )
}

fn open_from_env() -> Option<Arc<Recorder>> {
    let dir = std::env::var(DIR_ENV).ok()?;
    let dir = dir.trim();
    if dir.is_empty() {
        return None;
    }
    match Recorder::open(Path::new(dir)) {
        Ok(recorder) => Some(Arc::new(recorder)),
        Err(e) => {
            eprintln!("[cassette] cannot record into {dir}: {e}");
            None
        }
    }
}

/// One recording folder. Sequence numbers continue across restarts, so a new
/// session appends to the same scenario instead of overwriting it.
pub struct Recorder {
    dir: PathBuf,
    next: AtomicU64,
}

impl Recorder {
    pub fn open(dir: &Path) -> io::Result<Recorder> {
        fs::create_dir_all(dir)?;
        let manifest = dir.join("manifest.json");
        if !manifest.exists() {
            let body = json!({
                "format": "bnote-cassette",
                "version": 1,
                "createdAt": now_ms(),
            });
            let bytes =
                serde_json::to_vec_pretty(&body).map_err(|e| io::Error::other(e.to_string()))?;
            fs::write(&manifest, bytes)?;
        }
        let mut next = 1u64;
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(prefix) = name.strip_suffix("-request.json") else {
                continue;
            };
            if let Ok(seq) = prefix.parse::<u64>() {
                next = next.max(seq + 1);
            }
        }
        Ok(Recorder {
            dir: dir.to_path_buf(),
            next: AtomicU64::new(next),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn begin(
        &self,
        protocol: &str,
        url: &str,
        model: &str,
        session: &str,
        purpose: &str,
        thinking: bool,
        status: u16,
        body: &Value,
    ) -> Option<Interaction> {
        let seq = self.next.fetch_add(1, Ordering::SeqCst);
        let response_dir = self.dir.join(format!("{seq:04}-response"));
        let frames_dir = response_dir.join("frames");
        if let Err(e) = fs::create_dir_all(&frames_dir) {
            eprintln!("[cassette] {response_dir:?}: {e}");
            return None;
        }
        let request = json!({
            "seq": seq,
            "protocol": protocol,
            "method": "POST",
            "url": url,
            "model": model,
            "session": session,
            "purpose": purpose,
            "thinking": thinking,
            "recordedAt": now_ms(),
            "body": body,
        });
        let request_path = self.dir.join(format!("{seq:04}-request.json"));
        let bytes = match serde_json::to_vec_pretty(&request) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!("[cassette] request encode: {e}");
                return None;
            }
        };
        if let Err(e) = fs::write(&request_path, bytes) {
            eprintln!("[cassette] {request_path:?}: {e}");
            return None;
        }
        Some(Interaction {
            status: AtomicU16::new(status),
            response_dir,
            frames_dir,
            buffer: Mutex::new(Vec::new()),
            frames: Mutex::new(0u32),
            bytes: AtomicU64::new(0),
            finished: Mutex::new(false),
        })
    }
}

/// One response being recorded. `push_chunk` receives the bytes exactly as the
/// HTTP layer delivered them, including partial frames.
pub struct Interaction {
    status: AtomicU16,
    response_dir: PathBuf,
    frames_dir: PathBuf,
    buffer: Mutex<Vec<u8>>,
    frames: Mutex<u32>,
    bytes: AtomicU64,
    finished: Mutex<bool>,
}

impl Interaction {
    pub fn push_chunk(&self, chunk: &[u8]) {
        self.bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        let frames = {
            let Ok(mut buffer) = self.buffer.lock() else {
                return;
            };
            buffer.extend_from_slice(chunk);
            take_frames(&mut buffer)
        };
        for frame in frames {
            if let Err(e) = self.write_frame(&frame) {
                eprintln!("[cassette] frame write failed: {e}");
                return;
            }
        }
    }

    /// Writes the metadata and flushes a trailing partial frame. `completed`
    /// is false when the stream ended on error (abort, timeout, cut).
    pub fn finish(&self, content_type: Option<&str>, completed: bool) {
        let Ok(mut finished) = self.finished.lock() else {
            return;
        };
        if *finished {
            return;
        }
        *finished = true;
        let rest = {
            let Ok(mut buffer) = self.buffer.lock() else {
                return;
            };
            std::mem::take(&mut *buffer)
        };
        if !rest.is_empty() {
            if let Err(e) = self.write_frame_named("9999-partial.sse", &rest) {
                eprintln!("[cassette] partial frame write failed: {e}");
            }
        }
        let count = self.frames.lock().map(|g| *g).unwrap_or(0);
        let meta = json!({
            "status": self.status.load(Ordering::SeqCst),
            "contentType": content_type.unwrap_or(""),
            "frames": count,
            "bytes": self.bytes.load(Ordering::Relaxed),
            "completed": completed,
            "finishedAt": now_ms(),
        });
        let path = self.response_dir.join("meta.json");
        match serde_json::to_vec_pretty(&meta) {
            Ok(bytes) => {
                if let Err(e) = fs::write(&path, bytes) {
                    eprintln!("[cassette] {path:?}: {e}");
                }
            }
            Err(e) => eprintln!("[cassette] meta encode: {e}"),
        }
    }

    fn write_frame(&self, frame: &[u8]) -> io::Result<()> {
        let mut index = self
            .frames
            .lock()
            .map_err(|_| io::Error::other("frame counter poisoned"))?;
        *index += 1;
        let name = format!("{:04}.sse", *index);
        self.write_frame_named(&name, frame)
    }

    fn write_frame_named(&self, name: &str, frame: &[u8]) -> io::Result<()> {
        fs::write(self.frames_dir.join(name), frame)
    }
}

impl Drop for Interaction {
    fn drop(&mut self) {
        // A panic or an early return must not leave a response folder without
        // metadata: the replay loader would otherwise read it as "no frames".
        self.finish(None, false);
    }
}

/// Moves every complete SSE frame out of `buffer`, preserving its exact bytes.
/// A frame ends at `\n\n` or `\r\n\r\n`; what remains is an incomplete frame
/// waiting for the next chunk.
fn take_frames(buffer: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i + 1 < buffer.len() {
        if buffer[i] == b'\n' && buffer[i + 1] == b'\n' {
            out.push(buffer[start..i + 2].to_vec());
            i += 2;
            start = i;
            continue;
        }
        if i + 3 < buffer.len() && &buffer[i..i + 4] == b"\r\n\r\n" {
            out.push(buffer[start..i + 4].to_vec());
            i += 4;
            start = i;
            continue;
        }
        i += 1;
    }
    if start > 0 {
        buffer.drain(..start);
    }
    out
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "bnote-cassette-{tag}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn frames_split_on_lf_and_crlf_without_losing_bytes() {
        let mut buffer = b"data: a\n\ndata: b\r\n\r\ndata: part".to_vec();
        let frames = take_frames(&mut buffer);
        assert_eq!(
            frames,
            vec![b"data: a\n\n".to_vec(), b"data: b\r\n\r\n".to_vec()]
        );
        assert_eq!(buffer, b"data: part");
    }

    #[test]
    fn a_frame_split_across_chunks_is_written_once() {
        let dir = temp_dir("split");
        let recorder = Recorder::open(&dir).expect("recorder");
        let interaction = recorder
            .begin(
                "anthropic",
                "http://example.test/v1/messages",
                "m",
                "s",
                "turn",
                true,
                200,
                &json!({"model": "m"}),
            )
            .expect("interaction");

        interaction.push_chunk(b"data: {\"type\":");
        interaction.push_chunk(b"\"ping\"}\n\n");
        interaction.finish(Some("text/event-stream"), true);

        let frames = dir.join("0001-response/frames");
        assert_eq!(
            fs::read(frames.join("0001.sse")).expect("frame"),
            b"data: {\"type\":\"ping\"}\n\n"
        );
        let meta: Value =
            serde_json::from_slice(&fs::read(dir.join("0001-response/meta.json")).expect("meta"))
                .expect("meta json");
        assert_eq!(meta["frames"], 1);
        assert_eq!(meta["completed"], true);
        let request: Value =
            serde_json::from_slice(&fs::read(dir.join("0001-request.json")).expect("request"))
                .expect("request json");
        assert_eq!(request["protocol"], "anthropic");
        assert_eq!(request["body"]["model"], "m");
        assert!(!request.to_string().contains("api_key"));

        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn a_truncated_stream_keeps_its_partial_frame() {
        let dir = temp_dir("partial");
        let recorder = Recorder::open(&dir).expect("recorder");
        let interaction = recorder
            .begin(
                "openai",
                "http://example.test/chat/completions",
                "m",
                "s",
                "turn",
                false,
                200,
                &json!({}),
            )
            .expect("interaction");
        interaction.push_chunk(b"data: a\n\ndata: b");
        interaction.finish(Some("text/event-stream"), false);

        let frames = dir.join("0001-response/frames");
        assert_eq!(
            fs::read(frames.join("0001.sse")).expect("frame"),
            b"data: a\n\n"
        );
        assert_eq!(
            fs::read(frames.join("9999-partial.sse")).expect("partial"),
            b"data: b"
        );
        let meta: Value =
            serde_json::from_slice(&fs::read(dir.join("0001-response/meta.json")).expect("meta"))
                .expect("meta json");
        assert_eq!(meta["completed"], false);

        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn reopening_a_folder_continues_the_sequence() {
        let dir = temp_dir("resume");
        let first = Recorder::open(&dir).expect("recorder");
        first
            .begin("anthropic", "u", "m", "s", "turn", false, 200, &json!({}))
            .expect("interaction");
        let second = Recorder::open(&dir).expect("reopen");
        let interaction = second
            .begin("anthropic", "u", "m", "s", "turn", false, 200, &json!({}))
            .expect("interaction");
        drop(interaction);

        assert!(dir.join("0002-request.json").exists());
        fs::remove_dir_all(&dir).expect("cleanup");
    }
}
