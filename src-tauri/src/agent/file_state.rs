//! Per-session record of what the agent has read, and when.
//!
//! Write and Edit must not touch a file the model has not read in this
//! session, nor one that changed on disk after that read (the user, a
//! formatter, or a shell command). The entry holds the read mtime and range
//! only — never the file contents — so it costs a few dozen bytes per path.
//!
//! Claude Code keeps contents in the same cache and therefore has to cap it at
//! 25MB. Nothing on this side reads cached bytes back: Edit re-reads from disk,
//! and dedupe only needs the range and the mtime, so the content copy buys
//! nothing here.

use lru::LruCache;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Files remembered per session. Beyond this the least recently used entry is
/// dropped, which forces a fresh Read before writing that file — the safe
/// direction. 100 matches Claude Code's default.
const MAX_ENTRIES: usize = 100;

/// What one successful Read (or Write/Edit) left behind for a path.
#[derive(Debug, Clone, Copy)]
pub struct FileState {
    /// The file's mtime at the moment of the read. A later Write/Edit compares
    /// the disk mtime against it to detect an external change.
    pub mtime: SystemTime,
    /// The Read range as the model sent it. `None` means the whole file, which
    /// is what Write/Edit record after they succeed: a following Read must
    /// re-send the content, because the earlier tool result predates the write.
    pub offset: Option<u64>,
    pub limit: Option<u64>,
}

impl FileState {
    /// True when this entry was recorded by a Read of exactly this range, so a
    /// repeated call on an unchanged file can be answered with a stub.
    pub fn covers(&self, offset: u64, limit: Option<u64>) -> bool {
        self.offset == Some(offset) && self.limit == limit
    }
}

pub struct FileStateCache {
    cache: Mutex<LruCache<PathBuf, FileState>>,
}

impl Default for FileStateCache {
    fn default() -> Self {
        Self::new()
    }
}

impl FileStateCache {
    pub fn new() -> Self {
        let capacity = NonZeroUsize::new(MAX_ENTRIES).unwrap_or(NonZeroUsize::MIN);
        Self {
            cache: Mutex::new(LruCache::new(capacity)),
        }
    }

    /// The last recorded state, promoting the entry to most-recently used. A
    /// poisoned lock is recovered: the map stays consistent even if another
    /// thread panicked while holding the guard.
    pub fn get(&self, path: &Path) -> Option<FileState> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.get(path).copied()
    }

    pub fn record(&self, path: &Path, state: FileState) {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.put(path.to_path_buf(), state);
    }
}
