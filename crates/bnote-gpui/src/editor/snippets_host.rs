//! Insert-mode snippet host for the GPUI editor: the LaTeX-suite key path and
//! bracket coloring on top of the ported engine (`bnote_core::snippets`).
//!
//! The engine is pure; this module is the host side of its contract:
//!
//! * [`SnippetHost`] owns the [`SnippetStore`], the [`LatexConfig`], the
//!   [`SessionStack`], the per-document `scan_math` cache and the decision
//!   function ([`SnippetHost::on_key`]).
//! * [`SnippetBridge`] registers the one app-wide keystroke interceptor,
//!   finds the focused attached editor and applies the plan through the same
//!   `apply_lsp_edits` + `set_selected_range` path the vim bridge uses.
//!
//! # The key path (who runs first, and why)
//!
//! GPUI runs **every** registered keystroke interceptor for a key, in
//! registration order, and only consults `cx.propagate_event` afterwards
//! (gpui-pre `window.rs::dispatch_key_event` → `dispatch_keystroke_interceptors`,
//! a `SubscriberSet` keyed by increasing id, i.e. insertion order). Two facts
//! follow, and the whole design rests on them:
//!
//! 1. The snippet interceptor must be registered **before** the vim bridge's,
//!    so it reads the mode *before* the key is fed to vim. Otherwise the `i`/
//!    `a`/`o` keys that *cause* the Normal→Insert transition would be seen as
//!    insert-mode input by the snippet layer (vim switches first, and both
//!    interceptors still run).
//! 2. Keys the snippet layer consumes still reach the vim interceptor
//!    afterwards. That is harmless because in Insert mode the vim core
//!    consumes exactly one key — Escape (`vim/core/exec.rs::feed_insert`) —
//!    and the snippet layer deliberately passes Escape to vim
//!    ([`keys::escape`] with `vim_enabled = true` does nothing). Both facts
//!    are load-bearing; changing either one changes key ownership.
//!
//! Vim gating mirrors the TS `vimAllowsEdit`: `VimGate::Other` (Normal/Visual/
//! Replace) makes the whole layer inert — not one byte is touched, so no vim
//! behavior can depend on this module. With vim off (`VimGate::Off`) every key
//! is insert-mode, exactly like the TS (`!settings.vim`).
//!
//! # Pass-through and the session chain
//!
//! The engine's contract says the host remaps the chain through *every* edit;
//! here the editor engine, not this module, performs passed keys' edits
//! (gpui-kit's Backspace/Enter, the IME path for typed text), so the host
//! cannot name them. Instead of guessing, [`SnippetHost`] keeps the document
//! it last saw while a session is live and recovers the pending edit by
//! prefix/suffix comparison at the next key: single-cursor editing is a single
//! contiguous replacement, so that *is* the edit. A whole-document
//! replacement (file switch, external reload) becomes `[0, old_len)`, which
//! the engine defines as "the anchored document is gone" and clears the chain
//! with.
//!
//! # Performance (AGENTS.md 性能是生命线)
//!
//! Per key, in the insert path, with **no** session live (the common case):
//!
//! * non-printable keys translate to no key at all and return before any
//!   snapshot (the interceptor's translate step);
//! * a printable key builds "the document with the pending character" (one
//!   `String` splice, O(document)) and runs the engine's trigger **shape
//!   probe**: an anchored prefix/regex check per auto snippet over one line
//!   prefix. Only when the shape hits (or the key is `/`, the auto-fraction)
//!   is the document-grade context computed (`context_at_scan` + `scan_math`,
//!   each O(document); `scan_math` is memoized by document fingerprint);
//! * Tab / Enter / matrix / Backspace decide from the memoized math. Backspace
//!   additionally runs the engine's own cheap pre-check (`script_braces_at` +
//!   the two-`$` shape) first, so the common Backspace never scans;
//! * with a live session, one memcmp of the document reconciles the chain.
//!
//! Measured (debug build, 70KB note, `the_per_key_cost_*` tests): **8.5µs** per
//! printable key with no session, **14.9µs** with a live session — the debug
//! build is roughly an order of magnitude off release, and the tests assert a
//! 1ms/2ms ceiling so only a magnitude regression trips them.
//!
//! The expansion's second transaction (auto-enlarge) rescans the math of the
//! post-edit document — expansions create/shift `$` regions, so the pre-edit
//! regions are not valid there. Expansions are user-paced, not per-keystroke.
//! The bracket marks are rebuilt only when the document, the caret or the
//! visible row range changed (the workspace's render guard), and their cost is
//! the math inside one `caret_window` — see [`caret_window`].
//!
//! # v1 limits (explicit)
//!
//! * **Single cursor**: the engine and this host decide for one caret.
//! * **Reversed selection**: the engine's `Range` has no direction; a reversed
//!   selection (head before anchor) is normalized to `from < to`, and the
//!   caret is taken as the range end for Tab/Enter/Backspace. The Text path is
//!   unaffected (it replaces the selection either way, and the caret that
//!   insertion leaves is the end of the inserted text).
//! * **Vault snippet file**: [`SnippetHost::load_source`] takes the file's
//!   *text* — the real `.bnote/snippets.js` JS module (`export default [ … ]`,
//!   regex literals, comments, one function replacement) or the bare-array /
//!   JSON shape. `load.rs` reads the module statically (it cannot run JS); a
//!   file it cannot fully bind reports the skipped entries, and a missing or
//!   unparsable file falls back to the built-ins, the TS error path.
//!   Ownership invariant: the loader path replaces the source, the settings
//!   path must only flip `enabled`.
//! * IME composition: multi-character commits are only considered when they
//!   end in `/` (the TS `triggerKeyOf`); the TS deferred-fraction timer is not
//!   ported. Character-level composition (`view.composing` suppression) has no
//!   equivalent here because the interceptor never sees a composing key.
//! * **Mirror freshness lags by one key.** The TS `mirrorSyncListener` runs in
//!   the same update as the edit; here the edit is the editor's, so the sync
//!   is discovered at the *next* intercepted key (step 2 of
//!   [`SnippetHost::on_key`]). Typing inside a mirrored tabstop (`beg`'s env
//!   name) therefore leaves the other copy one character behind until the next
//!   key — which is also the key that writes it, before its own effect lands.
//!   Arrow-key navigation alone does not trigger the sync (nothing intercepts
//!   it); the next real key does.
//! * **Undo granularity**: an expansion plus its enlarge/mirror stages go
//!   through `apply_lsp_edits` as separate transactions, like the vim bridge's
//!   multi-edit commands. Whether that groups into one undo step the way the
//!   TS `userEvent` does needs the real GUI to confirm.

use std::cell::RefCell;
use std::ops::Range as StdRange;
use std::rc::Rc;

use bnote_core::markdown::context::{EditContext, context_at_scan};
use bnote_core::markdown::math_scan::{MathRegion, scan_math};
use bnote_core::snippets::brackets::{
    BracketColor, BracketHighlight, build_bracket_colors, build_cursor_brackets,
};
use bnote_core::snippets::config::LatexConfig;
use bnote_core::snippets::keys::{self, KeyAction};
use bnote_core::snippets::load;
use bnote_core::snippets::session::SessionStack;
use bnote_core::snippets::{MatchOptions, Range, Replace, SnippetStore, apply_replaces};

// ---------------------------------------------------------------------------
// The decision surface (pure; everything the tests drive)
// ---------------------------------------------------------------------------

/// How the vim layer gates the snippet keys — the TS `vimAllowsEdit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VimGate {
    /// vim is off for this editor: every key is an insert-mode key.
    Off,
    /// vim is on and the editor is in Insert mode.
    Insert,
    /// vim is on and the editor is *not* in Insert mode: the snippet layer is
    /// inert (vim owns every printable key there).
    Other,
}

impl VimGate {
    /// Whether the snippet layer may act on this key at all.
    pub fn allows_edit(self) -> bool {
        !matches!(self, VimGate::Other)
    }

    fn vim_enabled(self) -> bool {
        !matches!(self, VimGate::Off)
    }
}

/// One key the snippet layer decides on: the insert-mode key set of the TS
/// keymap (`Tab`/`Shift-Tab`/`Escape`), the bindings `setup.ts` adds
/// (Backspace, Enter-in-matrix) and the input-handler character path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnippetKey<'a> {
    Tab { shift: bool },
    Enter { shift: bool },
    Escape,
    Backspace,
    /// Printable text the editor would insert at the selection: one character
    /// for an ordinary keystroke, the whole string for an IME commit.
    Text(&'a str),
}

/// What the editor must do with the key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyPlan {
    /// Nothing decided: the key goes on to the editor unchanged.
    Pass,
    /// Edits the editor must apply, after which the key goes on unchanged: the
    /// session's mirror sync firing one keystroke late (the edit that made the
    /// mirrors stale was performed by the editor, see the module docs).
    Sync { stages: Vec<Vec<Replace>> },
    /// The snippet layer owns the key. `stages` are document edits in pipeline
    /// order — stage N's offsets are in the document stages `0..N` produced —
    /// and `selection` is the caret/selection after all of them (`None` = the
    /// caret is the editor's own business, e.g. a pure cursor action).
    Handled {
        stages: Vec<Vec<Replace>>,
        selection: Option<Range>,
    },
}

impl KeyPlan {
    fn handled(stages: Vec<Vec<Replace>>, selection: Option<Range>) -> Self {
        KeyPlan::Handled { stages, selection }
    }

    /// Whether the key goes on to the editor. (`Sync` does: it only writes the
    /// session's own mirrors and lets the key through.)
    pub fn is_pass(&self) -> bool {
        matches!(self, KeyPlan::Pass | KeyPlan::Sync { .. })
    }
}

/// The two bracket mark sets of the LaTeX-suite feature (engine types; the
/// GPUI glue turns them into `TextDecoration`s with the theme's colors).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BracketMarks {
    pub colors: Vec<BracketColor>,
    pub highlights: Vec<BracketHighlight>,
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/// Insert-mode host state for one editor: the snippet source, the settings,
/// the session chain and the per-document math cache.
pub struct SnippetHost {
    store: SnippetStore,
    config: LatexConfig,
    stack: SessionStack,
    /// The document as of the last key this host decided on, kept only while a
    /// session is live (see the module docs on pass-through edits).
    last_doc: Option<String>,
    /// `scan_math` memo, keyed by [`fingerprint`] of the document.
    math: Option<(u64, Rc<Vec<MathRegion>>)>,
}

impl Default for SnippetHost {
    fn default() -> Self {
        Self::new()
    }
}

impl SnippetHost {
    /// The built-in snippets, plugin-default settings.
    pub fn new() -> Self {
        Self {
            store: SnippetStore::builtin(),
            config: LatexConfig::default(),
            stack: SessionStack::new(),
            last_doc: None,
            math: None,
        }
    }

    /// Replace the snippet source (the loader path; see `load.rs`'s source
    /// ownership invariant — the settings path must only flip `enabled`).
    pub fn set_store(&mut self, store: SnippetStore) {
        self.store = store;
        self.stack.clear();
        self.last_doc = None;
    }

    /// Load a snippet source — the vault file's `.bnote/snippets.js` module (or
    /// the bare-array/JSON shape) — through the reader; returns the entries the
    /// engine had to skip (empty when everything took effect; the count comes
    /// from [`SnippetHost::snippet_count`]).
    ///
    /// This is the seam the vault file goes through: `load::store_from_file`
    /// reads the module statically (regex literals, comments, the one function
    /// replacement — see `load.rs`), so a malformed file is an error (the
    /// caller falls back to the built-ins, the TS error path) while a
    /// well-formed entry it cannot bind is reported, not silently dropped.
    pub fn load_source(&mut self, source: &str) -> Result<Vec<String>, String> {
        let loaded =
            load::store_from_file(source, self.store.enabled).map_err(|e| e.to_string())?;
        self.set_store(loaded.store);
        Ok(loaded.skipped)
    }

    /// Built-ins, enabled state preserved.
    pub fn use_builtins(&mut self) {
        let enabled = self.store.enabled;
        self.set_store(load::builtin_store(enabled).0);
    }

    /// Flip the engine on or off (the settings toggle). Only `enabled` moves:
    /// the source stays whatever the loader installed — the TS
    /// `applySnippetsEnabled` / `reloadSnippets` pair, and the source-ownership
    /// invariant `load.rs` states.
    pub fn set_enabled(&mut self, enabled: bool) {
        self.store.enabled = enabled;
    }

    /// The compiled snippet count (the loader reports it in the status line).
    pub fn snippet_count(&self) -> usize {
        self.store.compiled.list.len()
    }

    /// How many session levels are live. The tests' window into the chain; no
    /// user-facing surface reads it.
    #[cfg(test)]
    pub fn session_len(&self) -> usize {
        self.stack.len()
    }

    /// The innermost session's active stop, for the chain-mapping tests.
    #[cfg(test)]
    fn active_range(&self) -> Option<Range> {
        self.stack.top().and_then(|s| s.active_range())
    }

    /// Drop everything anchored to the previous document (file switched /
    /// buffer rebuilt wholesale).
    pub fn reset(&mut self) {
        self.stack.clear();
        self.last_doc = None;
        self.math = None;
    }

    /// Decide one key. `doc` is the pre-key document and `selection` the
    /// pre-key selection (`anchor..head`; a reversed selection is normalized,
    /// see the module docs).
    pub fn on_key(
        &mut self,
        key: SnippetKey<'_>,
        doc: &str,
        selection: StdRange<usize>,
        vim: VimGate,
    ) -> KeyPlan {
        if !vim.allows_edit() {
            return KeyPlan::Pass;
        }
        let mut from_caret = selection.start.min(selection.end);
        let mut to = selection.start.max(selection.end);

        // 1. Keep the chain honest against a document this module did not write
        //    (vim commands, IME commits, workspace commands, reloads).
        if !self.stack.is_empty() {
            self.reconcile(doc);
        }

        // 2. The mirror sync (TS `mirrorSyncListener`) runs *before* the exit
        //    rule and the key decision, exactly like the TS listener order.
        //    The edits are in this document's coordinates; when they fire, the
        //    rest of the decision runs against the predicted post-sync
        //    document, so every offset the engine answers with is valid.
        let mut leading: Vec<Vec<Replace>> = Vec::new();
        let mut synced_doc: Option<String> = None;
        if !self.stack.is_empty() {
            let mirrors = self.stack.mirror_edits(doc, to);
            if !mirrors.is_empty() {
                for e in &mirrors {
                    self.stack.apply_edit(e, doc.len());
                }
                to = map_caret(to, &mirrors);
                from_caret = map_caret(from_caret, &mirrors);
                synced_doc = Some(apply_replaces(doc, &mirrors));
                leading.push(mirrors);
            }
        }
        let doc: &str = synced_doc.as_deref().unwrap_or(doc);
        let from = from_caret.min(to);

        // 3. The engine's exit rule (TS `exitListener`) before any position
        //    from the chain is used.
        if !self.stack.is_empty() {
            self.stack.prune(to);
        }

        let sel = Range::new(from, to);
        let plan = match key {
            SnippetKey::Escape => self.escape_plan(vim.vim_enabled()),
            SnippetKey::Tab { shift } => self.tab_plan(doc, sel, shift),
            SnippetKey::Enter { shift } => self.enter_plan(doc, sel, shift),
            SnippetKey::Backspace => self.backspace_plan(doc, to),
            SnippetKey::Text(text) => self.text_plan(doc, sel, text),
        };

        // 4. The chain's positions are only meaningful for a document this
        //    host has seen; keep the base the next reconcile diffs against. A
        //    passed key's own edit is deliberately not predicted (the editor
        //    performs it after this interceptor returns) — the next key's diff
        //    recovers it.
        if self.stack.is_empty() {
            self.last_doc = None;
        } else if synced_doc.is_some() && leading.len() == 1 && plan.is_pass() {
            // The only edit we know about is the sync itself.
            self.last_doc = synced_doc;
        } else if self.last_doc.is_none() {
            self.last_doc = Some(doc.to_string());
        }

        match plan {
            KeyPlan::Pass if leading.is_empty() => KeyPlan::Pass,
            KeyPlan::Pass => KeyPlan::Sync { stages: leading },
            KeyPlan::Handled { stages, selection } => {
                let mut all = leading;
                all.extend(stages);
                KeyPlan::Handled { stages: all, selection }
            }
            KeyPlan::Sync { .. } => unreachable!("the key arms never build Sync"),
        }
    }

    // ---- key arms ---------------------------------------------------------

    fn escape_plan(&mut self, vim_enabled: bool) -> KeyPlan {
        // `keys::escape` models the TS `escapeForSnippet`: with vim on the
        // engine gets Esc first (leave insert mode) and the session is dropped
        // by the exit rule once the cursor leaves; with vim off Esc ends the
        // session (consumed only when there *is* one).
        match keys::escape(&mut self.stack, vim_enabled) {
            KeyAction::Pass => KeyPlan::Pass,
            KeyAction::Apply { selection, .. } => KeyPlan::handled(Vec::new(), selection),
        }
    }

    fn tab_plan(&mut self, doc: &str, sel: Range, shift: bool) -> KeyPlan {
        let math = self.math_for(doc);
        let ctx = context_at_scan(doc, sel.to, &math);
        let before = self.stack.len();
        let action = if shift {
            keys::shift_tab(&mut self.stack, doc, sel, &ctx, &math, &self.config)
        } else {
            keys::tab(&self.store, &mut self.stack, doc, sel, &ctx, &math, &self.config)
        };
        // An expansion is the only layer that starts a session, so the chain
        // grows — except for a replacement without tabstops, which is settled
        // by asking the store the same question `expandOnTab` asked (its
        // match is deterministic and pure).
        let expansion = match &action {
            KeyAction::Apply { changes, .. } if !changes.is_empty() => {
                if self.stack.len() > before {
                    Some(changes[0].insert.clone())
                } else if changes.len() == 1 {
                    self.manual_expansion(doc, sel, &ctx, &changes[0])
                } else {
                    None
                }
            }
            _ => None,
        };
        self.finish(action, doc, sel, expansion)
    }

    /// The store's answer to "would a manual Tab expand here?", used only to
    /// classify a Tab change as an expansion (see [`Self::tab_plan`]).
    fn manual_expansion(
        &self,
        doc: &str,
        sel: Range,
        ctx: &EditContext,
        change: &Replace,
    ) -> Option<String> {
        if !self.store.enabled {
            return None;
        }
        let visual = if sel.is_empty() { None } else { doc.get(sel.from..sel.to) };
        let opts = MatchOptions::from_config(&self.config, false, None, visual);
        let exp = self.store.compiled.match_at(doc, sel.to, ctx, &opts)?;
        (exp.start == change.from
            && exp.end == change.to
            && exp.replacement.text == change.insert)
            .then(|| exp.replacement.text.clone())
    }

    fn enter_plan(&mut self, doc: &str, sel: Range, shift: bool) -> KeyPlan {
        // Enter outside a matrix is the editor's own newline: no context scan
        // for the common case. A row break only exists inside a matrix
        // environment, which needs a `\begin` somewhere (the gate is a
        // superset: the engine's env scan allows whitespace before the brace).
        if !self.config.matrix_shortcuts || !doc.contains("\\begin") {
            return KeyPlan::Pass;
        }
        let math = self.math_for(doc);
        let ctx = context_at_scan(doc, sel.to, &math);
        let action = keys::enter(&mut self.stack, doc, sel, shift, &ctx, &math, &self.config);
        self.finish(action, doc, sel, None)
    }

    fn backspace_plan(&mut self, doc: &str, caret: usize) -> KeyPlan {
        if !cheap_backspace_probe(doc, caret, &self.config) {
            return KeyPlan::Pass;
        }
        let math = self.math_for(doc);
        let ctx = context_at_scan(doc, caret, &math);
        let action = keys::backspace(&mut self.stack, doc, caret, &ctx, &self.config);
        self.finish(action, doc, Range::caret(caret), None)
    }

    fn text_plan(&mut self, doc: &str, sel: Range, text: &str) -> KeyPlan {
        // 1. The close-bracket skip is asked *before* the character is
        //    inserted (the engine's contract for `close_bracket_skip`): the
        //    key is consumed and the cursor jumps instead of doubling the
        //    auto-inserted closer. Only a live session can answer, and the
        //    question needs no context scan.
        if !self.stack.is_empty() {
            let action = keys::close_bracket_skip(&mut self.stack, doc, sel.to, text);
            if !action.is_pass() {
                return self.finish(action, doc, sel, None);
            }
        }

        let Some(typed) = trigger_key_of(text) else {
            return KeyPlan::Pass;
        };

        // 2. Simulate the native insertion (the IME path replaces the
        //    selection with exactly this text), so the engine sees the
        //    document state its `auto_expand` contract assumes: the typed key
        //    is in the document and the caret sits after it.
        let sim = simulate_typing(doc, sel, text);
        let visual = if sel.is_empty() { None } else { doc.get(sel.from..sel.to) };

        // 3. The cheap shape probe: with a context that accepts every mode,
        //    `match_at` can only over-accept, never miss — so a miss proves
        //    nothing can expand and the O(document) context/scan is skipped.
        if !self.may_expand(&sim.doc, sim.caret, typed, visual) {
            return KeyPlan::Pass;
        }

        let math = self.math_for(&sim.doc);
        let ctx = context_at_scan(&sim.doc, sim.caret, &math);
        let action = keys::auto_expand(
            &self.store,
            &mut self.stack,
            &sim.doc,
            sim.caret,
            &ctx,
            &math,
            &self.config,
            typed,
            visual,
        );
        let expansion = match &action {
            KeyAction::Apply { changes, .. } => changes.first().map(|c| c.insert.clone()),
            KeyAction::Pass => None,
        };
        if action.is_pass() {
            return KeyPlan::Pass;
        }
        // The action's coordinates are simulated-document coordinates; every
        // offset it names lies inside the region the simulated insertion
        // touched, so translate the *changes* back (the returned selection is
        // already valid: both documents end up byte-identical after the edit).
        let action = match action {
            KeyAction::Apply { changes, selection } => {
                let changes = changes
                    .into_iter()
                    .map(|c| Replace {
                        from: sim_to_real(c.from, sel, text.len()),
                        to: sim_to_real(c.to, sel, text.len()),
                        insert: c.insert,
                    })
                    .collect();
                KeyAction::Apply { changes, selection }
            }
            KeyAction::Pass => unreachable!("checked above"),
        };
        self.finish(action, doc, sel, expansion)
    }

    /// The shape probe (never a false negative; see [`Self::text_plan`]).
    fn may_expand(&self, doc: &str, caret: usize, typed: &str, visual: Option<&str>) -> bool {
        if !self.store.enabled {
            return false;
        }
        if typed == "/" {
            // Auto-fraction is not trigger-based; the `/` path always gets the
            // document-grade context.
            return true;
        }
        let opts = MatchOptions::from_config(&self.config, true, Some(typed), visual);
        self.store.compiled.match_at(doc, caret, &probe_context(), &opts).is_some()
    }

    // ---- plan assembly ----------------------------------------------------

    /// Turn one engine action into a plan and run the follow-up passes the
    /// engine's contract asks for:
    ///
    /// * the **auto-enlarge** (TS `startSessionAt` → `autoEnlargeBrackets`)
    ///   after an expansion, with the inserted text, as its own transaction;
    /// * the **mirror sync** (TS `mirrorSyncListener`) whenever the document
    ///   changed: mirrored tabstops are rewritten as one more transaction.
    fn finish(
        &mut self,
        action: KeyAction,
        doc: &str,
        sel: Range,
        expansion: Option<String>,
    ) -> KeyPlan {
        let KeyAction::Apply { changes, selection } = action else {
            return KeyPlan::Pass;
        };
        if changes.is_empty() {
            // A pure cursor action leaves the document where it was: the chain
            // (already reconciled, and synced by the caller if it had to be)
            // describes exactly this document.
            if !self.stack.is_empty() {
                self.last_doc = Some(doc.to_string());
            }
            return KeyPlan::handled(Vec::new(), selection);
        }
        let mut caret = selection.map(|s| s.to);
        let mut doc_cur = apply_replaces(doc, &changes);
        let mut stages = vec![changes];

        if let Some(inserted) = expansion {
            // The enlarge scan reads the *post-edit* document: an expansion
            // can create or shift the `$` regions the scan needs, so the
            // pre-edit regions are not valid here. This also refreshes the
            // math memo for the next key.
            let math = self.math_for(&doc_cur);
            let head = caret.unwrap_or(sel.to);
            let edits =
                keys::enlarge_after_expansion(&doc_cur, head, &inserted, &self.config, &math);
            if !edits.is_empty() {
                self.remap_chain(&edits, doc_cur.len());
                if let Some(c) = caret.as_mut() {
                    *c = map_caret(*c, &edits);
                }
                doc_cur = apply_replaces(&doc_cur, &edits);
                stages.push(edits);
            }
        }

        if !self.stack.is_empty() {
            let head = caret.unwrap_or(sel.to);
            let mirrors = self.stack.mirror_edits(&doc_cur, head);
            if !mirrors.is_empty() {
                self.remap_chain(&mirrors, doc_cur.len());
                if let Some(c) = caret.as_mut() {
                    *c = map_caret(*c, &mirrors);
                }
                doc_cur = apply_replaces(&doc_cur, &mirrors);
                stages.push(mirrors);
            }
            // The chain now describes exactly this document: make it the base
            // the next reconcile diffs against (the editor is about to write
            // the stages below, so anything else is a later, unknown edit).
            self.last_doc = Some(doc_cur);
        }

        KeyPlan::handled(stages, caret.map(Range::caret))
    }

    /// Remaps the chain through a whole change set.
    ///
    /// Every [`Replace`] in a set carries **pre-edit** coordinates (the engine
    /// emits them that way, like a CodeMirror transaction), so the set is
    /// pushed highest-offset-first — the order in which each edit's coordinates
    /// are still valid for the positions it moves, exactly like the document
    /// edits the glue applies through `apply_lsp_edits`. `old_len` is the
    /// document the chain was anchored to, for the engine's whole-document
    /// replacement rule.
    fn remap_chain(&mut self, edits: &[Replace], old_len: usize) {
        let mut ordered: Vec<&Replace> = edits.iter().collect();
        ordered.sort_by_key(|e| std::cmp::Reverse(e.from));
        for e in ordered {
            self.stack.apply_edit(e, old_len);
        }
    }

    /// Keeps the session chain in step with a document this module did not
    /// write (see the module docs).
    fn reconcile(&mut self, doc: &str) {
        let Some(prev) = self.last_doc.as_ref() else { return };
        if prev == doc {
            return;
        }
        let edit = single_edit(prev, doc);
        self.stack.apply_edit(&edit, prev.len());
        self.last_doc = Some(doc.to_string());
    }

    /// `scan_math` memoized per document (AGENTS.md: nothing O(document) per
    /// frame — the bracket marks re-query this on every scroll step).
    fn math_for(&mut self, doc: &str) -> Rc<Vec<MathRegion>> {
        let key = fingerprint(doc);
        if let Some((k, regions)) = &self.math {
            if *k == key {
                return regions.clone();
            }
        }
        let regions = Rc::new(scan_math(doc));
        self.math = Some((key, regions.clone()));
        regions
    }

    /// The bracket marks for one visible window plus the caret's pair (the two
    /// LaTeX-suite decorations, each gated by its own setting).
    pub fn bracket_marks(
        &mut self,
        doc: &str,
        window: StdRange<usize>,
        caret: usize,
    ) -> BracketMarks {
        let mut marks = BracketMarks::default();
        if !self.config.bracket_colors && !self.config.highlight_cursor_brackets {
            return marks;
        }
        let math = self.math_for(doc);
        if self.config.bracket_colors {
            marks.colors =
                build_bracket_colors(doc, &[Range::new(window.start, window.end)], &math);
        }
        if self.config.highlight_cursor_brackets {
            marks.highlights = build_cursor_brackets(doc, &[Range::caret(caret)], &math);
        }
        marks
    }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// A context every snippet matches (`matches_context` can only accept more):
/// the probe's filter is "would any trigger shape match here at all".
fn probe_context() -> EditContext {
    EditContext {
        inline_math: true,
        block_math: true,
        text_env: true,
        code: true,
        code_block: Some(String::new()),
        is_text: true,
    }
}

/// The TS `triggerKeyOf`: one character is its own trigger key; a multi-char
/// commit (IME) counts only when it ends in `/` (the auto-fraction).
fn trigger_key_of(text: &str) -> Option<&str> {
    if text.is_empty() || text == "\n" {
        return None;
    }
    if text.chars().count() == 1 {
        return Some(text);
    }
    text.ends_with('/').then_some("/")
}

/// The cheap **superset** Backspace pre-check (the ordering `keys`' docs ask
/// for): the engine's chain can only fire between two `$` or on a `_{}`/`^{}`
/// tail, so every other Backspace skips the document context scan.
fn cheap_backspace_probe(doc: &str, caret: usize, config: &LatexConfig) -> bool {
    if config.auto_delete_dollar
        && doc.as_bytes().get(caret) == Some(&b'$')
        && caret > 0
        && doc.as_bytes().get(caret - 1) == Some(&b'$')
    {
        return true;
    }
    keys::script_braces_at(doc, caret)
}

/// The document with `text` typed at `sel` (the IME path replaces the
/// selection), plus the caret that insertion leaves.
struct Simulated {
    doc: String,
    caret: usize,
}

fn simulate_typing(doc: &str, sel: Range, text: &str) -> Simulated {
    let change = Replace::new(sel.from, sel.to, text);
    let caret = sel.from + text.len();
    Simulated { doc: apply_replaces(doc, &[change]), caret }
}

/// Simulated-document offset → real-document offset: the simulated document is
/// `doc[..sel.from] + text + doc[sel.to..]`, everything else shifted.
fn sim_to_real(pos: usize, sel: Range, text_len: usize) -> usize {
    if pos <= sel.from {
        pos
    } else if pos >= sel.from + text_len {
        sel.to + (pos - sel.from - text_len)
    } else {
        // Inside the inserted text: only a change boundary equal to the
        // caret can land here, and the caret's real position is the end of
        // the selection it replaced.
        sel.to
    }
}

/// The single contiguous edit that turns `prev` into `next` (common prefix /
/// common suffix): the shape every single-cursor edit has. Used to remap the
/// session chain through edits this module did not perform.
fn single_edit(prev: &str, next: &str) -> Replace {
    let a = prev.as_bytes();
    let b = next.as_bytes();
    let max = a.len().min(b.len());
    let mut prefix = 0usize;
    while prefix < max && a[prefix] == b[prefix] {
        prefix += 1;
    }
    while prefix > 0 && (!prev.is_char_boundary(prefix) || !next.is_char_boundary(prefix)) {
        prefix -= 1;
    }
    let mut suffix = 0usize;
    while suffix < max - prefix && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix] {
        suffix += 1;
    }
    while suffix > 0
        && (!prev.is_char_boundary(prev.len() - suffix)
            || !next.is_char_boundary(next.len() - suffix))
    {
        suffix -= 1;
    }
    Replace::new(prefix, prev.len() - suffix, &next[prefix..next.len() - suffix])
}

/// The caret's position after a set of non-overlapping edits, with CodeMirror's
/// cursor assoc -1 (`ChangeDesc.mapPos`): the edits are all in pre-edit
/// coordinates, so the whole set is applied in one pass — an insertion exactly
/// at the caret stays *before* it, a position inside a replaced range maps to
/// its start.
fn map_caret(caret: usize, edits: &[Replace]) -> usize {
    let mut sorted: Vec<&Replace> = edits.iter().collect();
    sorted.sort_by_key(|e| e.from);
    let mut delta: isize = 0;
    for e in sorted {
        if caret < e.from {
            break;
        }
        if caret <= e.to {
            return (e.from as isize + delta) as usize;
        }
        delta += e.insert.len() as isize - (e.to - e.from) as isize;
    }
    (caret as isize + delta) as usize
}

/// FNV-1a over the document bytes, salted with the length: the cache key for
/// the math memo (the length goes in so a same-hash shorter document cannot
/// hit; 2^64 of state is unreachable by editing a note).
fn fingerprint(doc: &str) -> u64 {
    let mut h: u64 =
        0xcbf2_9ce4_8422_2325 ^ (doc.len() as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    for &b in doc.as_bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// The byte window the bracket colors are computed for: the caret's line plus
/// `visible_rows` lines either side.
///
/// gpui-kit exposes only the visible *display rows* (`visible_row_range`); the
/// display map that would turn them into buffer ranges is `pub(super)`, so the
/// host takes the row count as a line budget. A wrapped line occupies more rows
/// than lines, so `rows` lines either side is a superset of the visible buffer
/// lines whenever the caret is on screen — which is the cost bound the feature
/// needs (the engine scans only the math inside the window).
pub fn caret_window(doc: &str, caret: usize, visible_rows: usize) -> StdRange<usize> {
    let lines = visible_rows.max(1);
    let caret = caret.min(doc.len());
    let mut from = line_start(doc, caret);
    for _ in 0..lines {
        if from == 0 {
            break;
        }
        from = line_start(doc, from - 1);
    }
    let mut to = line_end(doc, caret);
    for _ in 0..lines {
        if to >= doc.len() {
            break;
        }
        to = line_end(doc, to + 1);
    }
    if to < doc.len() {
        to += 1; // keep the trailing newline so the last line's start is inside
    }
    from..to.max(from)
}

/// Byte offset of the start of the line containing `pos`.
fn line_start(doc: &str, pos: usize) -> usize {
    doc[..pos.min(doc.len())].rfind('\n').map_or(0, |i| i + 1)
}

/// Byte offset of the end of the line containing `pos` (the `\n` or the
/// document end, excluding the line break).
fn line_end(doc: &str, pos: usize) -> usize {
    let pos = pos.min(doc.len());
    doc[pos..].find('\n').map_or(doc.len(), |i| pos + i)
}

// ---------------------------------------------------------------------------
// GPUI glue: the keystroke interceptor
// ---------------------------------------------------------------------------

use gpui::{App, Entity, Focusable as _, Hsla, Keystroke, Window};
use gpui_kit::component::input::{EditorState, TextDecoration, TextDecorationCollection};

use crate::editor::vim::core::Mode as VimMode;
use crate::editor::vim::integration::VimBridge;

struct Attachment {
    editor: Entity<EditorState>,
    host: SnippetHost,
    /// The app-wide vim bridge: the single authority for "is this editor in
    /// insert mode" ([`VimBridge::mode_of`]).
    vim: VimBridge,
    decorations: TextDecorationCollection,
}

/// App-wide snippet bridge: one keystroke interceptor, a registry of the
/// editors that carry snippets, and the vim bridge as the mode authority.
///
/// The registry exists because the vim bridge's own list only spans
/// *vim-enabled* editors, and snippets must run with vim off too (the TS
/// `vimAllowsEdit` returns true when vim is off). There is still only one mode
/// authority: [`VimBridge::mode_of`].
///
/// **Register this before the vim bridge** (`SnippetBridge::init` before
/// `VimBridge::init` in `main.rs`): interceptors run in registration order and
/// both run for every key, so this layer must read the mode *before* vim
/// processes the key (see the module docs).
#[derive(Clone)]
pub struct SnippetBridge {
    attachments: Rc<RefCell<Vec<Attachment>>>,
}

impl SnippetBridge {
    /// Register the keystroke interceptor. Call once, before opening windows
    /// and before [`VimBridge::init`].
    pub fn init(cx: &mut App) -> Self {
        let bridge = Self { attachments: Rc::new(RefCell::new(Vec::new())) };
        let this = bridge.clone();
        // The subscription lives as long as the app; the bridge itself is held
        // by the caller.
        let _subscription = cx.intercept_keystrokes(move |event, window, cx| {
            this.on_keystroke(&event.keystroke, window, cx);
        });
        bridge
    }

    /// Make an editor carry snippets (independent of vim being on).
    pub fn attach(&self, editor: Entity<EditorState>, vim: VimBridge, cx: &mut App) {
        let mut list = self.attachments.borrow_mut();
        if list.iter().any(|a| a.editor == editor) {
            return;
        }
        let decorations = editor.update(cx, |state, cx| {
            state.create_decorations_collection(Vec::new(), cx)
        });
        list.push(Attachment { editor, host: SnippetHost::new(), vim, decorations });
    }

    /// The buffer was replaced wholesale (file switched): drop the session and
    /// the document-keyed caches.
    pub fn reset(&self, editor: &Entity<EditorState>) {
        self.with_host_mut(editor, |host| host.reset());
    }

    /// Load a snippet source (the vault-file seam; see
    /// [`SnippetHost::load_source`]). Returns the skipped entries, if any.
    pub fn load_source(
        &self,
        editor: &Entity<EditorState>,
        source: &str,
    ) -> Result<Vec<String>, String> {
        self.with_host_mut(editor, |host| host.load_source(source))
            .unwrap_or(Err("编辑器未挂载片段层".to_string()))
    }

    /// The compiled snippet count of an attached editor.
    pub fn snippet_count(&self, editor: &Entity<EditorState>) -> usize {
        self.with_host_mut(editor, |host| host.snippet_count()).unwrap_or(0)
    }

    /// Fall back to the built-in snippet set.
    pub fn use_builtins(&self, editor: &Entity<EditorState>) {
        self.with_host_mut(editor, |host| host.use_builtins());
    }

    /// Turn the engine on or off for an attached editor (the settings toggle;
    /// source untouched, see [`SnippetHost::set_enabled`]).
    pub fn set_enabled(&self, editor: &Entity<EditorState>, enabled: bool) {
        self.with_host_mut(editor, |host| host.set_enabled(enabled));
    }

    /// Refresh the bracket decorations from the current document, caret and
    /// visible rows. The caller decides when (document/caret/scroll changed);
    /// nothing is computed while a setting is off.
    pub fn refresh_marks(
        &self,
        editor: &Entity<EditorState>,
        window: &mut Window,
        cx: &mut App,
    ) -> bool {
        let _ = window;
        let atts = self.attachments.clone();
        let mut list = atts.borrow_mut();
        let Some(index) = list.iter().position(|a| &a.editor == editor) else {
            return false;
        };
        let att = &mut list[index];
        let (text, caret, rows) = {
            let state = att.editor.read(cx);
            let Some(rows) = state.visible_row_range() else {
                return false;
            };
            (state.text().to_string(), state.cursor(), rows.len())
        };
        let window_range = caret_window(&text, caret, rows);
        let marks = att.host.bracket_marks(&text, window_range, caret);
        let palette = {
            use gpui_kit::component::ActiveTheme as _;
            let theme = cx.theme();
            // The Tauri shell's `--latex-bracket-0..2`, through the active
            // palette so the light mode gets its own values (they differ from
            // the dark ones); the dark palette is the boot fallback.
            let brackets = cx
                .try_global::<crate::theme::ActivePalette>()
                .map(|active| active.0)
                .unwrap_or_else(|| crate::theme::Palette::dark());
            BracketPalette {
                colors: [
                    brackets.bracket(0),
                    brackets.bracket(1),
                    brackets.bracket(2),
                ],
                cursor: theme.accent.opacity(0.3),
            }
        };
        att.decorations.set(marks_to_decorations(&marks, &palette), cx);
        true
    }

    fn with_host_mut<R>(
        &self,
        editor: &Entity<EditorState>,
        f: impl FnOnce(&mut SnippetHost) -> R,
    ) -> Option<R> {
        let mut list = self.attachments.borrow_mut();
        list.iter_mut()
            .find(|a| &a.editor == editor)
            .map(|att| f(&mut att.host))
    }

    fn on_keystroke(&self, ks: &Keystroke, window: &mut Window, cx: &mut App) {
        let Some(key) = snippet_key(ks) else {
            return; // chords, navigation and IME keys pass through
        };
        let index = {
            let list = self.attachments.borrow();
            list.iter()
                .position(|a| a.editor.read(cx).focus_handle(cx).is_focused(window))
        };
        let Some(index) = index else { return };
        // The mode *before* vim sees this key: this interceptor is registered
        // first, so the snapshot is the pre-key state (module docs).
        let vim_gate = {
            let list = self.attachments.borrow();
            let att = &list[index];
            match att.vim.mode_of(&att.editor) {
                Some(VimMode::Insert) => VimGate::Insert,
                Some(_) => VimGate::Other,
                None => VimGate::Off,
            }
        };
        if !vim_gate.allows_edit() {
            return;
        }
        let (doc, selection) = {
            let list = self.attachments.borrow();
            let state = list[index].editor.read(cx);
            (state.text().to_string(), state.selected_range())
        };
        let plan = {
            let mut list = self.attachments.borrow_mut();
            list[index].host.on_key(key, &doc, selection, vim_gate)
        };
        match plan {
            KeyPlan::Pass => {}
            KeyPlan::Sync { stages } => {
                // The session's mirrors were stale and are written now; the
                // key itself still belongs to the editor.
                apply_plan(&self.attachments, index, &stages, None, window, cx);
            }
            KeyPlan::Handled { stages, selection } => {
                // Stop propagation: the key is the snippet layer's. This also
                // keeps the IME path from inserting a character the expansion
                // already accounts for.
                cx.stop_propagation();
                apply_plan(&self.attachments, index, &stages, selection, window, cx);
            }
        }
    }
}

fn apply_plan(
    attachments: &Rc<RefCell<Vec<Attachment>>>,
    index: usize,
    stages: &[Vec<Replace>],
    selection: Option<Range>,
    window: &mut Window,
    cx: &mut App,
) {
    let editor = attachments.borrow()[index].editor.clone();
    editor.update(cx, |state, cx| {
        if !stages.is_empty() {
            let mut text = state.text().to_string();
            for stage in stages.iter().filter(|s| !s.is_empty()) {
                let mut edits: Vec<lsp_types::TextEdit> = stage
                    .iter()
                    .map(|e| lsp_types::TextEdit {
                        range: lsp_types::Range {
                            start: crate::apply_ops::to_lsp_pos(&text, e.from),
                            end: crate::apply_ops::to_lsp_pos(&text, e.to),
                        },
                        new_text: e.insert.clone(),
                    })
                    .collect();
                // The engine derives offsets per edit against the live text;
                // applying highest-offset-first keeps them valid.
                edits.sort_by(|a, b| {
                    (b.range.start.line, b.range.start.character)
                        .cmp(&(a.range.start.line, a.range.start.character))
                });
                text = apply_replaces(&text, stage);
                state.apply_lsp_edits(&edits, window, cx);
            }
        }
        if let Some(sel) = selection {
            state.set_selected_range(sel.from..sel.to, cx);
        }
    });
}

/// GPUI keystroke → the snippet layer's key. Only the keys the layer can
/// decide on are translated; everything else (arrows, delete, chords,
/// non-printable IME keys) passes untouched and costs nothing.
fn snippet_key(ks: &Keystroke) -> Option<SnippetKey<'_>> {
    let m = ks.modifiers;
    if m.platform || m.function || m.control || m.alt {
        return None;
    }
    match ks.key.as_str() {
        "tab" => Some(SnippetKey::Tab { shift: m.shift }),
        "enter" => Some(SnippetKey::Enter { shift: m.shift }),
        "escape" => Some(SnippetKey::Escape),
        "backspace" => Some(SnippetKey::Backspace),
        _ => {
            let chars = ks.key_char.as_deref()?;
            if chars.is_empty() || chars.chars().any(|c| c.is_control()) {
                return None;
            }
            Some(SnippetKey::Text(chars))
        }
    }
}

/// The three paired-bracket colors (the Tauri shell's `--latex-bracket-0..2`)
/// and the cursor-pair wash.
struct BracketPalette {
    colors: [Hsla; 3],
    cursor: Hsla,
}

fn marks_to_decorations(marks: &BracketMarks, palette: &BracketPalette) -> Vec<TextDecoration> {
    let mut out = Vec::with_capacity(marks.colors.len() + marks.highlights.len());
    for c in &marks.colors {
        let color = palette.colors[(c.depth as usize) % palette.colors.len()];
        out.push(TextDecoration::new(
            c.from..c.to,
            gpui::HighlightStyle { color: Some(color), ..Default::default() },
        ));
    }
    for h in &marks.highlights {
        out.push(TextDecoration::new(
            h.from..h.to,
            gpui::HighlightStyle {
                background_color: Some(palette.cursor),
                ..Default::default()
            },
        ));
    }
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use bnote_core::snippets::engine::{RawSnippet, lit};

    /// The TS test view's stand-in: a document, a selection, the host. Keys are
    /// driven exactly the way the GPUI glue drives them (apply the stages in
    /// order, then move the caret), so the assertions are about the real
    /// translation layer, not a parallel implementation.
    struct Sim {
        host: SnippetHost,
        doc: String,
        sel: Range,
        vim: VimGate,
    }

    impl Sim {
        fn new(doc: &str, caret: usize) -> Self {
            Sim {
                host: SnippetHost::new(),
                doc: doc.to_string(),
                sel: Range::caret(caret),
                vim: VimGate::Off,
            }
        }

        /// A store with only the given snippets: the table tests stay readable
        /// without the built-in table's 221 entries.
        fn with_snippets(doc: &str, caret: usize, raws: &[RawSnippet<'_>]) -> Self {
            let mut sim = Sim::new(doc, caret);
            sim.host.set_store(SnippetStore::from_raw(raws, true));
            sim
        }

        fn vim(mut self, gate: VimGate) -> Self {
            self.vim = gate;
            self
        }

        /// One key: decide, then apply the plan the way the glue applies it.
        /// Returns whether the snippet layer consumed the key.
        fn key(&mut self, key: SnippetKey<'_>) -> bool {
            let plan = self.host.on_key(key, &self.doc, self.sel.from..self.sel.to, self.vim);
            let (stages, selection, consumed) = match plan {
                KeyPlan::Pass => return false,
                KeyPlan::Sync { stages } => (stages, None, false),
                KeyPlan::Handled { stages, selection } => (stages, selection, true),
            };
            for stage in &stages {
                self.doc = apply_replaces(&self.doc, stage);
            }
            if let Some(sel) = selection {
                self.sel = sel;
            }
            consumed
        }

        /// A typed character: the host decides *before* the editor inserts, so
        /// a passed key is inserted by the test (like gpui-kit's IME path).
        fn type_char(&mut self, text: &str) -> bool {
            let consumed = self.key(SnippetKey::Text(text));
            if consumed {
                return true;
            }
            let at = self.sel.from;
            let change = Replace::new(self.sel.from, self.sel.to, text);
            self.doc = apply_replaces(&self.doc, &[change]);
            self.sel = Range::caret(at + text.len());
            false
        }

        fn type_str(&mut self, text: &str) {
            for c in text.chars() {
                self.type_char(&c.to_string());
            }
        }

        fn head(&self) -> usize {
            self.sel.to
        }
    }

    /// `sq` — 一个带制表位的片段,表格测试的统一素材.
    const SQ: RawSnippet<'static> = lit("sq", "\\sqrt{$0}$1", "mA");
    /// `beg` — 镜像制表位(环境名写两处).
    const BEG: RawSnippet<'static> = lit("beg", "\\begin{$0}\n$1\n\\end{$0}", "mA");
    /// `ddt` — 无制表位的片段(手动 Tab 展开的分类分支).
    const DDT: RawSnippet<'static> = lit("ddt", "\\frac{d}{dt} ", "mA");
    /// `xhat` — 正则触发(`r` 标志)的样例.
    const XHAT: RawSnippet<'static> = bnote_core::snippets::engine::rx("([a-zA-Z])hat", "\\hat{[[0]]}", "rmA");

    /// 决策表:(文档, 光标, 按键) → (文档, 光标)。每行都是引擎语义经过本层
    /// 翻译后的净效果;`None` 表示按键原样放行(编辑器自己处理).
    #[test]
    fn key_decision_table() {
        struct Row {
            name: &'static str,
            doc: &'static str,
            caret: usize,
            key: SnippetKey<'static>,
            raws: &'static [RawSnippet<'static>],
            want_doc: &'static str,
            want_caret: Option<usize>,
            consumed: bool,
        }
        let rows = [
            Row {
                name: "无匹配 → 原样放行",
                doc: "正文 zz",
                caret: 9,
                key: SnippetKey::Text("z"),
                raws: &[SQ],
                want_doc: "正文 zz",
                want_caret: None,
                consumed: false,
            },
            Row {
                name: "片段展开(单字符自动触发)",
                doc: "$$s",
                caret: 3,
                key: SnippetKey::Text("q"),
                raws: &[SQ],
                want_doc: "$$\\sqrt{}",
                want_caret: Some(8),
                consumed: true,
            },
            Row {
                name: "正则触发 `xhat`",
                doc: "$$xha",
                caret: 5,
                key: SnippetKey::Text("t"),
                raws: &[XHAT],
                want_doc: "$$\\hat{x}",
                want_caret: Some(9),
                consumed: true,
            },
            Row {
                name: "数学态里的 `/` → 自动分数",
                doc: "$$1",
                caret: 3,
                key: SnippetKey::Text("/"),
                raws: &[SQ],
                want_doc: "$$\\frac{1}{}",
                want_caret: Some(11),
                consumed: true,
            },
            Row {
                name: "数学态外的触发词保持字面",
                doc: "x",
                caret: 1,
                key: SnippetKey::Text("/"),
                raws: &[SQ],
                want_doc: "x",
                want_caret: None,
                consumed: false,
            },
            Row {
                name: "空公式的 Backspace 成对删除",
                doc: "$$",
                caret: 1,
                key: SnippetKey::Backspace,
                raws: &[SQ],
                want_doc: "",
                want_caret: Some(0),
                consumed: true,
            },
            Row {
                name: "普通 Backspace 放行",
                doc: "abc",
                caret: 2,
                key: SnippetKey::Backspace,
                raws: &[SQ],
                want_doc: "abc",
                want_caret: None,
                consumed: false,
            },
            Row {
                name: "没有会话的 Tab 走到 tabout",
                doc: "$a)b$",
                caret: 1,
                key: SnippetKey::Tab { shift: false },
                raws: &[SQ],
                want_doc: "$a)b$",
                want_caret: Some(3),
                consumed: true,
            },
            Row {
                name: "正文里的 Tab 放行",
                doc: "正文段落",
                caret: 0,
                key: SnippetKey::Tab { shift: false },
                raws: &[SQ],
                want_doc: "正文段落",
                want_caret: None,
                consumed: false,
            },
            Row {
                name: "矩阵里的 Enter 补行分隔",
                doc: "$$\n\\begin{pmatrix}\nQ & b\n\\end{pmatrix}\n$$",
                caret: 19,
                key: SnippetKey::Enter { shift: false },
                raws: &[SQ],
                want_doc: "$$\n\\begin{pmatrix}\n \\\\\nQ & b\n\\end{pmatrix}\n$$",
                want_caret: Some(23), // after the inserted row break
                consumed: true,
            },
        ];
        for row in rows {
            let mut sim = Sim::with_snippets(row.doc, row.caret, row.raws);
            let consumed = sim.key(row.key);
            assert_eq!(consumed, row.consumed, "{}: consumed", row.name);
            assert_eq!(sim.doc, row.want_doc, "{}: document", row.name);
            if let Some(caret) = row.want_caret {
                assert_eq!(sim.head(), caret, "{}: caret", row.name);
            } else {
                assert_eq!(sim.head(), row.caret, "{}: caret untouched", row.name);
            }
        }
    }

    /// Tab 逐站走完片段,最后一站 `exit_cursor` 收尾;Shift-Tab 回退一站.
    #[test]
    fn tab_walks_tabstops_and_shift_tab_walks_back() {
        let mut sim = Sim::with_snippets("$$", 2, &[SQ]);
        sim.type_str("sq");
        assert_eq!(sim.doc, "$$\\sqrt{}");
        assert_eq!(sim.head(), 8); // inside `{}` (the `$0` stop)
        assert_eq!(sim.host.session_len(), 1);

        assert!(sim.key(SnippetKey::Tab { shift: false }));
        assert_eq!(sim.head(), 9); // `$1`, the end of the replacement
        assert!(sim.key(SnippetKey::Tab { shift: true })); // back to `$0`
        assert_eq!(sim.head(), 8);
        // Forward again, then the last step ends the session at `final_pos`.
        assert!(sim.key(SnippetKey::Tab { shift: false }));
        assert_eq!(sim.host.session_len(), 1);
        assert!(sim.key(SnippetKey::Tab { shift: false }));
        assert_eq!(sim.host.session_len(), 0);
        assert_eq!(sim.head(), 9);
    }

    /// 整块片段(dm)最后一个制表位:`exit_cursor` 把光标夹在公式块内,不扔出去.
    #[test]
    fn the_exit_cursor_stays_inside_the_formula_for_a_whole_block_snippet() {
        let dm = lit("dm", "$$\n\\begin{align}\n$0\n\\end{align}\n$$", "tA");
        let mut sim = Sim::with_snippets("正文\n\nd", 9, &[dm]);
        sim.type_char("m");
        assert!(sim.doc.contains("\\begin{align}"));
        let inside = sim.head();
        // The session's only stop: Tab ends the chain, and `exit_cursor`
        // clamps the landing point (the replacement ends past the `$$`, i.e.
        // outside the formula) to "stay where you are".
        assert!(sim.key(SnippetKey::Tab { shift: false }));
        assert_eq!(sim.host.session_len(), 0);
        assert_eq!(sim.head(), inside, "the cursor must stay inside the formula");
        assert!(sim.head() < sim.doc.len());
    }

    /// 面对的右括号:一次 Tab,不再补第二个(`close_bracket_skip` 的净效果);
    /// 三个闭括号都在判定集里,`$` 不在(引擎只认 `)]}`).
    #[test]
    fn a_facing_close_bracket_is_skipped_not_doubled() {
        const PAREN: RawSnippet<'static> = lit("z", "($0)$1", "mA");
        const BRACKET: RawSnippet<'static> = lit("z", "[$0]$1", "mA");
        const BRACE: RawSnippet<'static> = lit("z", "{$0}$1", "mA");
        for (close, raw) in [(')', PAREN), (']', BRACKET), ('}', BRACE)] {
            let mut sim = Sim::with_snippets("$$", 2, &[raw]);
            assert!(sim.type_char("z"), "{close}: expansion");
            assert_eq!(sim.doc, format!("$${}{}", raw_open(close), close));
            assert_eq!(sim.head(), 3, "{close}: inside the pair");
            assert!(sim.type_char(&close.to_string()), "{close}: skip");
            assert_eq!(sim.doc, format!("$${}{}", raw_open(close), close), "{close}: not doubled");
            assert_eq!(sim.head(), 4, "{close}: stepped out");
        }
        // `$` is not in the engine's close-bracket set: the key passes.
        let mut sim = Sim::with_snippets("$$", 2, &[SQ]);
        assert!(!sim.key(SnippetKey::Text("$")));
    }

    fn raw_open(close: char) -> char {
        match close {
            ')' => '(',
            ']' => '[',
            '}' => '{',
            _ => unreachable!(),
        }
    }

    /// Backspace 的三种命运:成对删除、上下标花括号整对删除、其余放行.
    #[test]
    fn backspace_deletes_pairs_and_passes_everything_else() {
        let mut sim = Sim::new("$$", 1);
        assert!(sim.key(SnippetKey::Backspace));
        assert_eq!(sim.doc, "");

        // `_{}` inside math: the marker goes with the braces.
        let doc = "$x_{}$";
        let mut sim = Sim::new(doc, doc.find('}').unwrap());
        assert!(sim.key(SnippetKey::Backspace));
        assert_eq!(sim.doc, "$x$");

        // Outside math the same shape is markdown emphasis: pass.
        let doc = "x_{}";
        let mut sim = Sim::new(doc, doc.find('}').unwrap());
        assert!(!sim.key(SnippetKey::Backspace));
        assert_eq!(sim.doc, doc);

        // A single `$` (or a pair outside math) keeps the editor's deletion.
        let mut sim = Sim::new("$x$", 2);
        assert!(!sim.key(SnippetKey::Backspace));
        let mut sim = Sim::new("价格$5 和 $10 不同", 13);
        assert!(!sim.key(SnippetKey::Backspace));
    }

    /// 矩阵里的 Enter 与 Shift+Enter(引擎 `matrixEnter`);矩阵外放行.
    #[test]
    fn enter_in_a_matrix_inserts_the_row_break() {
        let doc = "$$\n\\begin{pmatrix}\nQ & b\n\\end{pmatrix}\n$$";
        let q = doc.find('Q').unwrap();
        let mut sim = Sim::new(doc, q);
        assert!(sim.key(SnippetKey::Enter { shift: false }));
        assert_eq!(sim.doc, "$$\n\\begin{pmatrix}\n \\\\\nQ & b\n\\end{pmatrix}\n$$");

        let mut shifted = Sim::new(doc, q);
        assert!(shifted.key(SnippetKey::Enter { shift: true }));
        assert_eq!(shifted.doc, doc, "Shift+Enter only moves the cursor");

        let mut plain = Sim::new("正文\n第二行", 3);
        assert!(!plain.key(SnippetKey::Enter { shift: false }));
        // A block formula that is not a matrix env passes too.
        let doc = "$$\nx + y\n$$";
        let mut sim = Sim::new(doc, doc.find('x').unwrap());
        assert!(!sim.key(SnippetKey::Enter { shift: false }));
        assert_eq!(sim.doc, doc);
    }

    /// 镜像制表位:`beg` 的环境名写两处,活动处的内容跟着同步到另一处 ——
    /// 同步发生在下一个键上(本层看不到编辑器插入的那一瞬),因此第二个字符
    /// 落地时镜像补上第一个字符.
    #[test]
    fn mirrored_tabstops_sync_on_the_next_key() {
        let mut sim = Sim::with_snippets("$$", 2, &[BEG]);
        sim.type_str("be");
        assert!(sim.type_char("g"));
        assert_eq!(sim.doc, "$$\\begin{}\n\n\\end{}");
        assert_eq!(sim.host.session_len(), 1);

        // `a` is inserted by the editor (passed); the mirror is still empty.
        assert!(!sim.type_char("a"));
        assert_eq!(sim.doc, "$$\\begin{a}\n\n\\end{}");
        // The next key syncs the mirror before doing its own work.
        assert!(!sim.type_char("b"));
        assert_eq!(sim.doc, "$$\\begin{ab}\n\n\\end{a}");
        // Tab (the session's second stop) syncs the rest on its way.
        assert!(sim.key(SnippetKey::Tab { shift: false }));
        assert_eq!(sim.doc, "$$\\begin{ab}\n\n\\end{ab}");
    }

    /// 同步过的编辑不能再被下一次对账当成"外部编辑"映射一次:会话链必须正好
    /// 描述同步之后的文档(Tab 的落点就是准星).
    #[test]
    fn a_sync_edit_is_not_mapped_twice() {
        let mut sim = Sim::with_snippets("$$", 2, &[BEG]);
        sim.type_str("beg");
        assert!(!sim.type_char("a")); // the mirror is stale by one char
        // Enter does not expand anything but lets the sync fire (its own edit
        // is the editor's newline, after this call).
        assert!(!sim.key(SnippetKey::Enter { shift: false }));
        assert_eq!(sim.doc, "$$\\begin{a}\n\n\\end{a}");
        assert_eq!(sim.host.session_len(), 1);
        // The chain describes the synced document: `$1` is exactly the empty
        // line, not shifted by the sync edit.
        assert!(sim.key(SnippetKey::Tab { shift: false }));
        assert_eq!(sim.head(), sim.doc.find("\\end").unwrap() - 1);
    }

    /// 会话期内的外部编辑(宿主没写过的)由前缀/后缀 diff 还原成一条 Replace,
    /// 链上的坐标随之平移 —— 平移到整篇替换时按引擎的 fullReplace 清空.
    #[test]
    fn an_edit_outside_the_session_body_still_maps_the_chain() {
        let mut sim = Sim::with_snippets("$$\n\n$$", 3, &[SQ]);
        sim.type_str("sq");
        let expanded = sim.doc.clone();
        assert_eq!(expanded, "$$\n\\sqrt{}\n$$");
        // An edit before the snippet body the host never saw (a vim command, a
        // ⌘-command, an IME commit): the chain must survive it.
        sim.doc = format!("x{}", sim.doc);
        sim.sel = Range::caret(sim.head() + 1);
        assert!(sim.key(SnippetKey::Tab { shift: false }));
        assert_eq!(sim.host.session_len(), 1, "the session survives an outside edit");
        assert_eq!(sim.head(), expanded.find('}').unwrap() + 2);

        // A whole-document replacement (file switch / external reload) drops
        // the chain instead of using positions from another document.
        sim.doc = "完全不同的另一篇文档".to_string();
        sim.sel = Range::caret(0);
        assert!(!sim.type_char("x"));
        assert_eq!(sim.host.session_len(), 0);
    }

    /// 负向门禁:没匹配上时文档、光标、会话都不许动.
    #[test]
    fn a_passed_key_touches_nothing() {
        let mut sim = Sim::with_snippets("正文 zz", 9, &[SQ]);
        let before = sim.doc.clone();
        let caret = sim.head();
        // The host's answer for a Pass is "not mine": nothing edited, nothing
        // consumed — the editor's own insertion (simulated by `type_char`) is
        // what moves the document afterwards.
        assert!(!sim.key(SnippetKey::Text("z")));
        assert_eq!(sim.doc, before);
        assert!(!sim.key(SnippetKey::Tab { shift: false }));
        assert!(!sim.key(SnippetKey::Enter { shift: false }));
        assert!(!sim.key(SnippetKey::Backspace));
        assert!(!sim.key(SnippetKey::Escape));
        assert_eq!(sim.doc, before);
        assert_eq!(sim.head(), caret);
        assert_eq!(sim.host.session_len(), 0);
    }

    /// vim 非插入态:整层惰性,一个字节都不许动.
    #[test]
    fn the_layer_is_inert_outside_insert_mode() {
        let mut sim = Sim::with_snippets("$$", 2, &[SQ]).vim(VimGate::Other);
        for key in [
            SnippetKey::Tab { shift: false },
            SnippetKey::Tab { shift: true },
            SnippetKey::Enter { shift: false },
            SnippetKey::Backspace,
            SnippetKey::Escape,
            SnippetKey::Text("q"),
        ] {
            assert!(!sim.key(key));
        }
        assert_eq!(sim.doc, "$$");
        assert_eq!(sim.host.session_len(), 0);
    }

    /// Esc 的门控与 TS `escapeForSnippet` 一致:vim 开 → 交给引擎(会话留给
    /// 退出规则);vim 关且有会话 → 结束会话;没会话 → 放行.
    #[test]
    fn escape_hands_the_key_to_vim_when_vim_is_on() {
        let mut with_vim = Sim::with_snippets("$$", 2, &[SQ]).vim(VimGate::Insert);
        with_vim.type_str("sq");
        assert_eq!(with_vim.host.session_len(), 1);
        assert!(!with_vim.key(SnippetKey::Escape), "vim must get the Esc");
        assert_eq!(with_vim.host.session_len(), 1, "the session survives for vim");

        let mut without_vim = Sim::with_snippets("$$", 2, &[SQ]);
        without_vim.type_str("sq");
        assert_eq!(without_vim.host.session_len(), 1);
        assert!(without_vim.key(SnippetKey::Escape));
        assert_eq!(without_vim.host.session_len(), 0);

        let mut idle = Sim::new("正文", 3);
        assert!(!idle.key(SnippetKey::Escape));
    }

    /// 展开之后是第二事务的 auto-enlarge:括号里有 `\sum`/`\frac` 就升成
    /// `\left…\right`,并且光标跟着那个事务走.
    #[test]
    fn an_expansion_inside_brackets_runs_the_enlarge_pass() {
        let sum = lit("sum", "\\sum_{i=1}^{N}", "mA");
        let paren = lit("(", "($0)$1", "mA");
        let mut sim = Sim::with_snippets("$$", 2, &[paren, sum]);
        sim.type_char("(");
        assert_eq!(sim.doc, "$$()");
        sim.type_str("sum");
        assert!(sim.doc.contains("\\sum_{"), "{}", sim.doc);
        assert!(sim.doc.contains("\\left("), "{}", sim.doc);
        assert!(sim.doc.contains("\\right)"), "{}", sim.doc);
    }

    /// 无制表位片段的手动 Tab 展开也触发 enlarge(分类靠重新询问 store 的
    /// 那个分支,不是靠"链长没变就当 tabout").
    #[test]
    fn the_manual_tab_expansion_of_a_stopless_snippet_enlarges_too() {
        let mut sim = Sim::with_snippets("$$(ddt)", 6, &[DDT]);
        assert!(sim.key(SnippetKey::Tab { shift: false }));
        assert_eq!(sim.doc, "$$\\left( \\frac{d}{dt}  \\right)");
        // The caret stays at the end of the inserted text, mapped through the
        // enlarge transaction's two insertions (the `\left( ` before it shifts
        // it, the ` \right)` after it does not).
        assert_eq!(&sim.doc[..sim.head()], "$$\\left( \\frac{d}{dt} ");
        assert_eq!(&sim.doc[sim.head()..], " \\right)");
    }

    /// 自动分数的光标落在分母里,`:0`/`:1` 占位符照引擎的初始选择走.
    #[test]
    fn the_fraction_session_lands_in_the_denominator() {
        let mut sim = Sim::new("$$silu(x)=1", 11);
        assert!(sim.type_char("/"));
        assert_eq!(sim.doc, "$$silu(x)=\\frac{1}{}");
        assert_eq!(sim.head(), 19);
        assert_eq!(sim.host.session_len(), 1);
    }

    /// 可见窗口:行预算 = 可见行数,上下各取,首尾夹紧.
    #[test]
    fn the_caret_window_covers_the_visible_lines() {
        let doc = "l0\nl1\nl2\nl3\nl4\nl5";
        let caret = doc.find("l3").unwrap();
        let w = caret_window(doc, caret, 1);
        assert_eq!(&doc[w.clone()], "l2\nl3\nl4\n");
        assert_eq!(caret_window(doc, 0, 3).start, 0);
        assert_eq!(caret_window(doc, doc.len(), 3).end, doc.len());
    }

    /// 括号标记:窗口内的配对按深度轮转着色,光标处的括号与配对高亮.
    #[test]
    fn bracket_marks_cover_the_window_and_the_caret_pair() {
        let doc = "正文\n$$a(b+c)d$$";
        let formula = doc.find("$$").unwrap();
        let mut host = SnippetHost::new();
        let marks = host.bracket_marks(doc, formula..doc.len(), formula + 5);
        assert_eq!(marks.colors.len(), 2);
        assert!(marks.colors.iter().any(|c| &doc[c.from..c.to] == "("));
        assert!(marks.colors.iter().any(|c| &doc[c.from..c.to] == ")"));
        assert_eq!(marks.highlights.len(), 2); // the pair at the caret
        // The engine scans the math regions the window *touches*: a window
        // that misses the formula yields nothing.
        let marks = host.bracket_marks(doc, 0..3, 0);
        assert!(marks.colors.is_empty());
        assert!(marks.highlights.is_empty());
    }

    /// 指纹:长度混入,不同文档不同键,同一文档稳定.
    #[test]
    fn fingerprints_separate_documents() {
        assert_ne!(fingerprint("abc"), fingerprint("abd"));
        assert_ne!(fingerprint("ab"), fingerprint("ab "));
        assert_eq!(fingerprint("abc"), fingerprint("abc"));
    }

    /// 变更集的链映射:坐标都是**编辑前**的,必须从大到小依次映射 —— 顺序反了
    /// 会把夹在两条编辑之间的制表位按后一条再平移一次.
    #[test]
    fn a_change_set_is_mapped_in_descending_order() {
        use bnote_core::snippets::session::Session;
        let mut host = SnippetHost::new();
        host.stack.push(
            Session::build(8, &bnote_core::snippets::parse_replacement("$0", &[], None, false))
                .expect("the fixture has a stop"),
        );
        // Insert 2 bytes at 2 and 3 bytes at 9, all in the 12-byte document's
        // pre-edit coordinates (the engine's `Replace` contract).
        host.remap_chain(&[Replace::insert_at(2, "aa"), Replace::insert_at(9, "bbb")], 12);
        // The stop at [8,8) is before the second edit: it must move by the
        // first edit's +2 only.
        assert_eq!(host.active_range(), Some(Range::caret(10)));
    }

    /// 外部编辑还原:一条插入、一条删除、一条替换、整篇替换、多字节边界.
    #[test]
    fn single_edit_recovers_insertions_and_replacements() {
        assert_eq!(single_edit("abcd", "abXcd"), Replace::new(2, 2, "X"));
        assert_eq!(single_edit("abcd", "abd"), Replace::new(2, 3, ""));
        assert_eq!(single_edit("abcd", "abXYd"), Replace::new(2, 3, "XY"));
        assert_eq!(single_edit("", "ab"), Replace::new(0, 0, "ab"));
        assert_eq!(single_edit("abcd", "XYZ"), Replace::new(0, 4, "XYZ"));
        assert_eq!(single_edit("值dm", "值dmx"), Replace::new(5, 5, "x"));
        assert_eq!(single_edit("值dm", "值xdm"), Replace::new(3, 3, "x"));
    }

    /// 光标的映射规则(CodeMirror assoc -1):caret 正好落在插入点前时留在原位.
    #[test]
    fn map_caret_keeps_the_cursor_before_an_insertion_at_it() {
        assert_eq!(map_caret(3, &[Replace::insert_at(3, "xy")]), 3);
        assert_eq!(map_caret(5, &[Replace::insert_at(3, "xy")]), 7);
        assert_eq!(map_caret(1, &[Replace::new(3, 5, "z")]), 1);
        assert_eq!(map_caret(4, &[Replace::new(3, 5, "z")]), 3);
        assert_eq!(map_caret(9, &[Replace::new(3, 5, "z")]), 8);
        // Several edits: the pre-edit coordinates of the whole set, applied at
        // once (an insertion before the caret shifts it, one at it does not).
        assert_eq!(
            map_caret(16, &[Replace::new(2, 3, "0123456"), Replace::new(16, 17, "01234567")]),
            22
        );
        assert_eq!(
            map_caret(5, &[Replace::new(2, 3, "0123456"), Replace::new(16, 17, "01234567")]),
            11
        );
    }

    /// 手感门禁:无会话时一次可打印键的决策成本(模拟文档 + 形状探测)在
    /// 70KB 笔记上仍是个位数微秒级 —— 预算按本机实测中位数放大(调试构建
    /// 本身约慢一个量级),拦的是"每键 O(文档²)"这类量级回归.
    #[test]
    fn the_per_key_cost_stays_in_the_interactive_class() {
        let mut doc = String::new();
        while doc.len() < 70_000 {
            doc.push_str("正文一行 $a+b=c$ 与 \\alpha 以及中文注释。\n");
        }
        let mut host = SnippetHost::new();
        let caret = doc.len();
        let keys = 200u32;
        let start = std::time::Instant::now();
        for _ in 0..keys {
            let plan = host.on_key(SnippetKey::Text("q"), &doc, caret..caret, VimGate::Off);
            assert!(plan.is_pass());
            assert_eq!(host.session_len(), 0);
        }
        let per_key = start.elapsed() / keys;
        println!("snippets_host: {}B doc, per printable key (no session): {per_key:?}", doc.len());
        assert!(
            per_key < std::time::Duration::from_millis(1),
            "per-key decision cost exploded: {per_key:?}"
        );
    }

    /// 会话活着的每键成本:一次 memcmp 对账 + 镜像检查,不带 O(文档²).
    #[test]
    fn the_per_key_cost_with_a_live_session_stays_bounded() {
        let mut doc = String::new();
        while doc.len() < 70_000 {
            doc.push_str("正文一行 $a+b=c$ 与 \\alpha 以及中文注释。\n");
        }
        doc.push_str("$$sq");
        let caret = doc.len();
        let mut host = SnippetHost::new();
        // Expand the built-in `sq` at the very end, then keep typing inside it.
        host.on_key(SnippetKey::Text("q"), &doc, caret - 1..caret - 1, VimGate::Off);
        assert_eq!(host.session_len(), 1, "sq must expand");
        let keys = 200u32;
        let start = std::time::Instant::now();
        for _ in 0..keys {
            // A char that expands nothing, inside the session: reconcile +
            // mirror check + shape probe, no document edit.
            let _ = host.on_key(SnippetKey::Text("z"), &doc, caret..caret, VimGate::Off);
        }
        let per_key = start.elapsed() / keys;
        println!("snippets_host: {}B doc, per key with a live session: {per_key:?}", doc.len());
        assert!(
            per_key < std::time::Duration::from_millis(2),
            "per-key cost with a session exploded: {per_key:?}"
        );
    }

    /// 仓库片段文件的接缝:owner 真文件(`.bnote/snippets.js`,逐字节副本存在
    /// bnote-core 的夹具里)经 `SnippetHost::load_source` 装载后 0 跳过,并且
    /// 生效的是**用户的 232 条**而不是内置 221 条——含仅 JS 支持的 lookbehind
    /// 触发(走 fancy-regex 回退)与函数型 replacement(绑定引擎的 `iden`).
    #[test]
    fn the_vault_snippets_file_loads_through_the_host() {
        // `src/editor/` → `crates/`: three levels up. The fixture is a
        // byte-for-byte copy of the owner's real vault file.
        const OWNER_SNIPPETS: &str =
            include_str!("../../../bnote-core/tests/data/snippets-owner.js");

        // 逐字符喂键(host 在键落地前判定,和真实输入路径一致):`aa` 在第二个
        // a 上展开成 \alpha.
        // `$$` with the caret between the dollars: a closed inline math region.
        let mut sim = Sim::new("$$", 1);
        let skipped = sim.host.load_source(OWNER_SNIPPETS).expect("owner 文件可解析");
        assert!(skipped.is_empty(), "{skipped:?}");
        assert_eq!(sim.host.snippet_count(), 232);
        // The first `a` is an ordinary keystroke; the second completes the
        // `aa` trigger and is swallowed by the expansion.
        assert!(!sim.type_char("a"));
        assert!(sim.type_char("a"));
        assert_eq!(sim.doc, "$\\alpha$");

        // 仅 JS 支持的 lookbehind 触发(`/(?<!\\)log/`)在数学态内展开.
        let mut sim = Sim::new("$$", 1);
        sim.host.load_source(OWNER_SNIPPETS).unwrap();
        sim.type_str("log");
        assert_eq!(sim.doc, "$\\log$");

        // 文本态的 `dm`(tAw,自动展开 + 词边界)展开成 align 骨架.
        let mut sim = Sim::new("", 0);
        sim.host.load_source(OWNER_SNIPPETS).unwrap();
        sim.type_str("dm");
        assert!(sim.doc.contains("\\begin{align}"), "{}", sim.doc);
    }

    /// 触发的形状探测:同一个字符在数学态内外、不同 store 下的不同裁决.
    #[test]
    fn the_shape_probe_gates_the_expensive_path() {
        let host = SnippetHost::new();
        // A trigger shape that exists in the built-in table resolves...
        assert!(host.may_expand("$$sq", 4, "q", None));
        // ...and one that does not ends the decision without any scan.
        assert!(!host.may_expand("$$qqq", 5, "q", None));
        // `/` always takes the document-grade path (auto-fraction).
        assert!(host.may_expand("$$1", 3, "/", None));
    }
}
