//! Cross-file todo sync engine. Port of `bnote/src/daily/engine.ts` — the
//! INTENT layer (`intentsForRange` / `dedupeIntents`) and the APPLY layer
//! (`applyMirror` / `applySend` / the `sendTodoToDaily` per-line core /
//! `dailyScaffoldWithRollover`), reworked as pure functions: they take both
//! sides' current texts and return new texts plus link mutations. The caller
//! (GPUI shell) owns files, editors, debounce and uuids.
//!
//! Semantic rules preserved verbatim (see the TS module comment):
//! - a linked block mirrors its whole subtree to the other side on any edit
//!   (re-indented, checkbox/✅ stamp travel with the text);
//! - touched unlinked todos auto-send to today's daily (existence is sync);
//! - a recorded link whose root gets un-checked clears the daily entry and
//!   unlinks (from either side; the daily-side path also flips the source
//!   todo back to unchecked);
//! - source root stops being a todo → delete the daily entry and unlink;
//!   daily root stops being a todo → unlink only (the user is curating
//!   today's list, project todos stay);
//! - a daily entry deleted by the user just unlinks (no resurrection).

use std::collections::{HashMap, HashSet};

use super::links::{DailyLink, LinkKind, LinkStore};
use super::model::{
    append_entry_spec, block_end, block_lines, block_root_line, compose_daily_scaffold,
    daily_path_for, daily_scaffold, find_entry_by_text, parse_daily_region, parse_list_line,
    previous_daily_file, remove_entry_spec, replace_entry_spec, resolve_root_line, reindent_block,
    rollover_blocks, text_after_changes, todo_text, todo_text_at, Doc, DocChange,
};

// ---------------------------------------------------------------- 意图提取

/// Port of `daily/engine.ts::Intent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
    Mirror {
        link_id: String,
        root_hint: Option<usize>,
        renamed_to: Option<String>,
    },
    Send {
        root_hint: usize,
        text: String,
    },
}

/// Block-root identity texts within a line slice → first root line, in
/// appearance order (the TS relies on `Map` insertion order).
/// Port of `daily/engine.ts::rootTextsOfSlice`.
struct RootTexts {
    order: Vec<(String, usize)>,
    map: HashMap<String, usize>,
}

impl RootTexts {
    fn get(&self, key: &str) -> Option<usize> {
        self.map.get(key).copied()
    }

    fn contains_key(&self, key: &str) -> bool {
        self.map.contains_key(key)
    }
}

fn root_texts_of_slice(doc: &Doc, from_no: usize, to_no: usize) -> RootTexts {
    let mut out = RootTexts { order: Vec::new(), map: HashMap::new() };
    for n in from_no..=to_no {
        let root = block_root_line(doc, n);
        if let Some(t) = todo_text_at(doc, root) {
            if !out.map.contains_key(t) {
                out.map.insert(t.to_string(), root);
                out.order.push((t.to_string(), root));
            }
        }
    }
    out
}

/// Whether the line itself or any shallower ancestor is a todo whose
/// identity text belongs to one of the file's links (i.e. already mirrored
/// via some link). Port of `daily/engine.ts::lineLinked`.
fn line_linked(doc: &Doc, line_no: usize, file_links: &[DailyLink]) -> bool {
    let has_text = |t: &str| file_links.iter().any(|l| l.text == t);
    if let Some(self_text) = todo_text_at(doc, line_no) {
        if has_text(self_text) {
            return true;
        }
    }
    let Some(start) = parse_list_line(doc.line(line_no)) else { return false };
    let mut depth = start.indent.len();
    let mut n = line_no - 1;
    while n >= 1 {
        let Some(p) = parse_list_line(doc.line(n)) else { break };
        if p.indent.len() < depth {
            if p.box_.is_some() && has_text(todo_text(&p)) {
                return true;
            }
            depth = p.indent.len();
            if depth == 0 {
                break;
            }
        }
        n -= 1;
    }
    false
}

/// One transaction's changed range (old/new document coordinates) → sync
/// intents. Line numbers are hints only; execution re-locates by text.
/// Offsets are byte offsets into each side's text.
/// Port of `daily/engine.ts::intentsForRange`.
pub fn intents_for_range(
    start_text: &str,
    end_text: &str,
    from_a: usize,
    to_a: usize,
    from_b: usize,
    to_b: usize,
    file_links: &[DailyLink],
    allow_send: bool,
) -> Vec<Intent> {
    if file_links.is_empty() && !allow_send {
        return Vec::new();
    }
    let start = Doc::new(start_text);
    let end = Doc::new(end_text);
    let old_from = start.line_at(from_a);
    let old_to = if to_a > from_a { start.line_at(to_a - 1) } else { start.line_at(from_a) };
    let new_from = end.line_at(from_b);
    let new_to = if to_b > from_b { end.line_at(to_b - 1) } else { end.line_at(from_b) };
    let mut intents: Vec<Intent> = Vec::new();
    let new_roots = root_texts_of_slice(&end, new_from, new_to);

    if !file_links.is_empty() {
        let old_roots = root_texts_of_slice(&start, old_from, old_to);
        // First block root of the new slice: root-line hint plus the renamed
        // identity text (root became plain prose → None, read as "vanished").
        let new_first_root_no = block_root_line(&end, new_from);
        let new_first_root_text = todo_text_at(&end, new_first_root_no);
        for link in file_links {
            let hit_old = old_roots.contains_key(&link.text);
            let hit_new = new_roots.contains_key(&link.text);
            if !hit_old && !hit_new {
                continue;
            }
            let root_hint = if hit_new {
                new_roots.get(&link.text)
            } else if new_first_root_text.is_some() {
                Some(new_first_root_no)
            } else {
                None
            };
            intents.push(Intent::Mirror {
                link_id: link.id.clone(),
                root_hint,
                renamed_to: new_first_root_text.map(str::to_string),
            });
        }
    }

    // Auto sync: unlinked todo blocks touched by the transaction are sent
    // whole to today's daily — no shortcut, no prior check-off required.
    // Judgement uses identity text only; empty text (still typing) is not
    // sent; already-linked blocks (self or ancestor) go through mirror, not
    // a duplicate send; the rename target of a mirror in this round is also
    // skipped (the link migrates there; apply-side findByText covers the
    // race). The caller turns allowSend off for paste/drop.
    if allow_send {
        let renamed: HashSet<String> = intents
            .iter()
            .filter_map(|i| match i {
                Intent::Mirror { renamed_to: Some(t), .. } => Some(t.clone()),
                _ => None,
            })
            .collect();
        for (text, root_no) in &new_roots.order.clone() {
            if text.is_empty() {
                continue;
            }
            if file_links.iter().any(|l| &l.text == text) {
                continue;
            }
            if renamed.contains(text) {
                continue;
            }
            if line_linked(&end, *root_no, file_links) {
                continue;
            }
            intents.push(Intent::Send { root_hint: *root_no, text: text.clone() });
        }
    }
    intents
}

/// Merge duplicate intents within one debounce round: mirrors union their
/// hints per link, sends keep the first per text. Port of
/// `daily/engine.ts::dedupeIntents`.
pub fn dedupe_intents(intents: Vec<Intent>) -> Vec<Intent> {
    // (link_id, root_hint, renamed_to) — newer non-null hints win
    // (`it.rootHint ?? cur?.rootHint ?? null`).
    let mut mirrors: Vec<(String, Option<usize>, Option<String>)> = Vec::new();
    let mut sends: Vec<(String, usize)> = Vec::new();
    for it in intents {
        match it {
            Intent::Mirror { link_id, root_hint, renamed_to } => {
                match mirrors.iter_mut().find(|(id, _, _)| *id == link_id) {
                    Some((_, hint, renamed)) => {
                        if root_hint.is_some() {
                            *hint = root_hint;
                        }
                        if renamed_to.is_some() {
                            *renamed = renamed_to;
                        }
                    }
                    None => mirrors.push((link_id, root_hint, renamed_to)),
                }
            }
            Intent::Send { root_hint, text } => {
                if !sends.iter().any(|(t, _)| *t == text) {
                    sends.push((text, root_hint));
                }
            }
        }
    }
    let mut out = Vec::new();
    for (link_id, root_hint, renamed_to) in mirrors {
        out.push(Intent::Mirror { link_id, root_hint, renamed_to });
    }
    for (text, root_hint) in sends {
        out.push(Intent::Send { root_hint, text });
    }
    out
}

// ---------------------------------------------------------------- 执行

/// Which side the change happened on. Port of the `side` variable in
/// `daily/engine.ts::applyMirror`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MirrorSide {
    Src,
    Daily,
}

/// Link mutation to apply after a mirror. Port of the `store.remove` /
/// `store.update` calls in `daily/engine.ts::applyMirror`.
#[derive(Debug, Clone, PartialEq)]
pub enum LinkChange {
    Keep,
    Remove,
    Update(DailyLink),
}

/// Result of a pure mirror: new texts per side (Some = write it) plus the
/// link mutation. `local` is the side the change happened on; `other` is the
/// mirror target file.
#[derive(Debug, Clone, PartialEq)]
pub struct MirrorOutcome {
    pub local_new: Option<String>,
    pub other_new: Option<String>,
    pub link: LinkChange,
}

/// Flip a todo line `[x]`→`[ ]` and strip its ✅ stamp — the same edits as
/// the checkbox toggle. Port of `daily/engine.ts::uncheckSpecs` with the
/// offset arithmetic of `editor/ops.ts::toggleTodo` (see note below).
pub fn uncheck_specs(doc: &Doc, line_no: usize) -> Option<Vec<DocChange>> {
    let line_text = doc.line(line_no);
    let p = parse_list_line(line_text)?;
    if p.box_.is_none() || p.box_ == Some(' ') {
        return None;
    }
    let line_start = doc.line_start(line_no);
    // mark_from points at the `[x]` box; the box is always 3 bytes.
    let mark_from = line_start + p.indent.len() + p.marker.len() + p.gap.len();
    // p.text is a suffix of the line text; its start sits after the box plus
    // the optional single space BOX_RE consumes. (engine.ts computes
    // `markFrom + 3 + stamp.index`, dropping that consumed space — an
    // off-by-one against its own ops.ts reference, where the task regex
    // keeps the space in the tail; we mirror ops.ts's byte-exact result.)
    let text_start = line_start + line_text.len() - p.text.len();
    let stamp = super::model::done_stamp_start(p.text);
    let mut changes =
        vec![DocChange { from: mark_from + 1, to: Some(mark_from + 2), insert: Some(" ".into()) }];
    if let Some(stamp_start) = stamp {
        let text_end = text_start + stamp_start;
        changes.push(DocChange {
            from: text_end,
            to: Some(doc.line_end(line_no)),
            insert: Some(String::new()),
        });
    }
    Some(changes)
}

/// Mirror execution. Port of `daily/engine.ts::applyMirror` (minus the
/// editor `viewAlive` guard and file locking — shell concerns).
///
/// - `local_text`: current text of the side the change happened on;
/// - `other_text`: current text of the linked other file, `None` when
///   unreadable (deleted/renamed) → unlink, no crash.
pub fn apply_mirror(
    side: MirrorSide,
    local_text: &str,
    other_text: Option<&str>,
    link: &DailyLink,
    root_hint: Option<usize>,
    renamed_to: Option<&str>,
) -> MirrorOutcome {
    let Some(other_text) = other_text else {
        // The other file is gone (deleted/renamed): unlink, stop mirroring.
        return MirrorOutcome { local_new: None, other_new: None, link: LinkChange::Remove };
    };
    let other = Doc::new(other_text);
    let local = Doc::new(local_text);
    let texts: Vec<&str> = match renamed_to {
        Some(t) if t != link.text => vec![t, link.text.as_str()],
        _ => vec![link.text.as_str()],
    };
    let root_no = resolve_root_line(&local, &texts, root_hint);
    let root = root_no.and_then(|n| parse_list_line(local.line(n)));
    let is_todo_root = root.as_ref().is_some_and(|r| r.box_.is_some());
    let mut outcome = MirrorOutcome { local_new: None, other_new: None, link: LinkChange::Keep };

    // Recorded link: root got un-checked → clear this entry from the daily
    // (either direction triggers it).
    if is_todo_root && link.kind == LinkKind::Recorded && root.as_ref().unwrap().box_ == Some(' ') {
        match side {
            MirrorSide::Src => {
                // Source unchecked: delete the daily entry + unlink.
                let region = parse_daily_region(&other);
                if let Some(entry) = find_entry_by_text(&other, &region, &link.text, link.daily_line)
                {
                    outcome.other_new =
                        Some(text_after_changes(other_text, &[remove_entry_spec(&other, entry)]));
                }
            }
            MirrorSide::Daily => {
                // Daily-side uncheck: drop the local entry and flip the
                // source todo back to unchecked.
                let region = parse_daily_region(&local);
                if let Some(entry) = find_entry_by_text(&local, &region, &link.text, link.daily_line)
                {
                    outcome.local_new =
                        Some(text_after_changes(local_text, &[remove_entry_spec(&local, entry)]));
                }
                let src_root_no =
                    resolve_root_line(&other, &[link.text.as_str()], Some(link.src_line));
                if let Some(src_root_no) = src_root_no {
                    if let Some(specs) = uncheck_specs(&other, src_root_no) {
                        outcome.other_new = Some(text_after_changes(other_text, &specs));
                    }
                }
            }
        }
        outcome.link = LinkChange::Remove;
        return outcome;
    }

    if !is_todo_root {
        // Root is no longer a todo (deleted / became prose). Source side
        // vanished → delete the daily entry; daily side vanished → unlink
        // only, leave the project todo alone.
        if side == MirrorSide::Src {
            let region = parse_daily_region(&other);
            if let Some(entry) = find_entry_by_text(&other, &region, &link.text, link.daily_line) {
                outcome.other_new =
                    Some(text_after_changes(other_text, &[remove_entry_spec(&other, entry)]));
            }
        }
        outcome.link = LinkChange::Remove;
        return outcome;
    }

    let root_no = root_no.unwrap();
    let root = root.unwrap();
    let block = block_lines(&local, root_no);

    match side {
        MirrorSide::Src => {
            let region = parse_daily_region(&other);
            let Some(entry) = find_entry_by_text(&other, &region, &link.text, link.daily_line)
            else {
                // The daily entry was deleted by the user = unlink, do not
                // resurrect (sync again via the shortcut to re-send).
                outcome.link = LinkChange::Remove;
                return outcome;
            };
            let reindented = reindent_block(&block, root.indent.len(), "");
            outcome.other_new =
                Some(text_after_changes(other_text, &[replace_entry_spec(&other, entry, &reindented)]));
            outcome.link = LinkChange::Update(DailyLink {
                text: todo_text(&root).to_string(),
                src_line: root_no,
                daily_line: entry.start,
                ..link.clone()
            });
        }
        MirrorSide::Daily => {
            let src_root_no = resolve_root_line(&other, &[link.text.as_str()], Some(link.src_line));
            let src_root = src_root_no.and_then(|n| parse_list_line(other.line(n)));
            let is_src_todo = src_root.as_ref().is_some_and(|r| r.box_.is_some());
            if !is_src_todo {
                // The source todo is gone: remove the local entry + unlink.
                let region = parse_daily_region(&local);
                if let Some(entry) =
                    find_entry_by_text(&local, &region, &link.text, link.daily_line)
                {
                    outcome.local_new =
                        Some(text_after_changes(local_text, &[remove_entry_spec(&local, entry)]));
                }
                outcome.link = LinkChange::Remove;
                return outcome;
            }
            let src_root = src_root.unwrap();
            let src_root_no = src_root_no.unwrap();
            let reindented = reindent_block(&block, 0, src_root.indent);
            outcome.other_new = Some(text_after_changes(
                other_text,
                &[DocChange {
                    from: other.line_start(src_root_no),
                    to: Some(other.line_end(block_end(&other, src_root_no))),
                    insert: Some(reindented.join("\n")),
                }],
            ));
            outcome.link = LinkChange::Update(DailyLink {
                text: todo_text(&root).to_string(),
                src_line: src_root_no,
                daily_line: root_no,
                ..link.clone()
            });
        }
    }
    outcome
}

/// Result of a pure auto-send: new daily text to write (Some = write, even
/// when identical to the input, mirroring the TS unconditional writeFile)
/// plus the link to upsert.
#[derive(Debug, Clone, PartialEq)]
pub struct SendOutcome {
    pub daily_new: Option<String>,
    pub link: Option<DailyLink>,
}

/// "Auto sync" execution: copy the touched unlinked todo block as a top-level
/// entry of today's daily (checkbox state travels with the line) and persist
/// a `kind=auto` mapping; the mirror then keeps both sides in sync. When the
/// daily already holds an identical entry it is claimed as the mirror root
/// (brought over by rollover or pasted by hand — no duplicate append).
/// Port of `daily/engine.ts::applySend`.
///
/// `daily_text` must already be resolved by the caller: the current daily
/// file content, or `daily_scaffold_with_rollover(...)` when the file does
/// not exist yet.
#[allow(clippy::too_many_arguments)]
pub fn apply_send(
    src_path: &str,
    src_text: &str,
    daily_path: &str,
    daily_text: &str,
    root_hint: usize,
    text: &str,
    today: &str,
    link_id: &str,
    store: &mut LinkStore,
) -> SendOutcome {
    let src = Doc::new(src_text);
    let root_no = resolve_root_line(&src, &[text], Some(root_hint));
    let root = root_no.and_then(|n| parse_list_line(src.line(n)));
    let is_todo_root = root.as_ref().is_some_and(|r| r.box_.is_some());
    if root_no.is_none() || !is_todo_root {
        return SendOutcome { daily_new: None, link: None }; // block vanished / became prose in the debounce window
    }
    if text.is_empty() {
        return SendOutcome { daily_new: None, link: None }; // still typing
    }
    if store.find_by_text(src_path, text, root_no.unwrap()).is_some() {
        return SendOutcome { daily_new: None, link: None }; // already linked (race): mirror carries it
    }
    let root = root.unwrap();
    let block = block_lines(&src, root_no.unwrap());
    let reindented = reindent_block(&block, root.indent.len(), "");
    let base = daily_text;
    let bdoc = Doc::new(base);
    let region = parse_daily_region(&bdoc);
    let new_daily;
    let daily_line;
    if let Some(existing) = find_entry_by_text(&bdoc, &region, text, 0) {
        // Identical entry already in the daily: claim it as the mirror root.
        daily_line = existing.start;
        new_daily = base.to_string();
    } else {
        let (change, _) = append_entry_spec(&bdoc, &region, &reindented);
        new_daily = text_after_changes(base, &[change]);
        let ndoc = Doc::new(&new_daily);
        daily_line = find_entry_by_text(&ndoc, &parse_daily_region(&ndoc), text, usize::MAX)
            .map_or(1, |e| e.start);
    }
    let link = DailyLink {
        id: link_id.to_string(),
        kind: LinkKind::Auto,
        day: today.to_string(),
        src_path: src_path.to_string(),
        daily_path: daily_path.to_string(),
        text: text.to_string(),
        src_line: root_no.unwrap(),
        daily_line,
    };
    store.upsert(link.clone());
    SendOutcome { daily_new: Some(new_daily), link: Some(link) }
}

/// Link whose source path + today's daily path + identity text all match.
/// Port of `daily/engine.ts::linkForDaily`.
fn link_for_daily<'s>(
    store: &'s LinkStore,
    src_path: &str,
    daily_path: &str,
    text: &str,
) -> Option<&'s DailyLink> {
    store
        .all()
        .into_iter()
        .find(|l| l.src_path == src_path && l.daily_path == daily_path && l.text == text)
}

/// Link of any **ancestor** todo on `daily_path` (self is judged by the
/// caller). Port of `daily/engine.ts::ancestorLinkForDaily`.
fn ancestor_link_for_daily<'s>(
    doc: &Doc,
    line_no: usize,
    src_path: &str,
    daily_path: &str,
    store: &'s LinkStore,
) -> Option<&'s DailyLink> {
    let start = parse_list_line(doc.line(line_no))?;
    let mut depth = start.indent.len();
    let mut n = line_no - 1;
    while n >= 1 {
        let Some(p) = parse_list_line(doc.line(n)) else { break };
        if p.indent.len() < depth {
            if p.box_.is_some() {
                if let Some(l) = link_for_daily(store, src_path, daily_path, todo_text(&p)) {
                    return Some(l);
                }
            }
            depth = p.indent.len();
            if depth == 0 {
                break;
            }
        }
        n -= 1;
    }
    None
}

/// Counters mirroring the toast decision of `daily/engine.ts::sendTodoToDaily`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SendReport {
    pub sent: usize,
    pub already: usize,
    pub not_todo: usize,
}

/// Explicit "send todo to today's daily" per-line core. Port of
/// `daily/engine.ts::sendTodoToDaily` (the multi-cursor loop; the editor
/// selection, `isDailyPath` guard and toasts are the caller's job — pass
/// cursor lines in, dedup happens here as in the TS `seenLines`).
///
/// Press on a child todo promotes the child to a top-level daily entry with
/// its own subtree kept nested ("按下行为准"). "Already sent" is judged by
/// whether today's daily really holds the entry, not by the mapping record —
/// stale mappings are unlinked in place and re-sent. Mappings are owned per
/// day: yesterday's mapping points at yesterday's file and neither blocks
/// today's send nor gets unlinked by it.
///
/// `daily_text`: current content of today's daily, `None` when the file does
/// not exist yet (a fresh scaffold is built lazily via `fresh_scaffold` only
/// when a send actually happens). Returns the new daily text (Some = write
/// the file) and per-line counters.
pub fn send_todo_lines(
    src_path: &str,
    src_text: &str,
    daily_path: &str,
    daily_text: Option<String>,
    lines: &[usize],
    today: &str,
    store: &mut LinkStore,
    fresh_scaffold: &dyn Fn() -> String,
    new_id: &mut dyn FnMut() -> String,
) -> (Option<String>, SendReport) {
    let mut report = SendReport::default();
    let mut daily_text: Option<String> = daily_text;
    let mut mutated = false;
    let src = Doc::new(src_text);
    let mut seen: HashSet<usize> = HashSet::new();

    let daily_has = |daily_text: &Option<String>, text: &str| -> bool {
        let Some(t) = daily_text else { return false };
        let d = Doc::new(t);
        let region = parse_daily_region(&d);
        find_entry_by_text(&d, &region, text, 0).is_some()
    };

    for &line_no in lines {
        if !seen.insert(line_no) {
            continue;
        }
        let parsed = parse_list_line(src.line(line_no));
        let is_todo_line = parsed.as_ref().is_some_and(|l| l.box_.is_some());
        if !is_todo_line || todo_text(parsed.as_ref().unwrap()).is_empty() {
            report.not_todo += 1;
            continue;
        }
        let l = parsed.unwrap();
        let text = todo_text(&l).to_string();
        let own = link_for_daily(store, src_path, daily_path, &text).map(|l| (l.id.clone(), l.kind));
        if let Some((id, kind)) = own {
            if daily_has(&daily_text, &text) {
                // Already mapped; an explicit send upgrades a recorded link.
                if kind == LinkKind::Recorded {
                    store.update(&id, |l| l.kind = LinkKind::Copied);
                }
                report.already += 1;
                continue;
            }
            // Stale mapping (today's daily deleted / entry removed by hand):
            // unlink and re-send as a new entry.
            store.remove(&id);
        } else if let Some(anc) =
            ancestor_link_for_daily(&src, line_no, src_path, daily_path, store)
        {
            if daily_has(&daily_text, &anc.text) {
                report.already += 1; // mirrored with the parent; already in the daily
                continue;
            }
            let anc_id = anc.id.clone();
            store.remove(&anc_id); // the parent's entry is gone too: stale as well
        }
        let block = block_lines(&src, line_no);
        let reindented = reindent_block(&block, l.indent.len(), "");
        if daily_text.is_none() {
            daily_text = Some(fresh_scaffold());
        }
        let base = daily_text.clone().unwrap();
        let bdoc = Doc::new(&base);
        let region = parse_daily_region(&bdoc);
        let new_daily;
        let daily_line;
        if let Some(existing) = find_entry_by_text(&bdoc, &region, &text, 0) {
            daily_line = existing.start; // identical entry already there: claim, no re-append
            new_daily = base;
        } else {
            let (change, _) = append_entry_spec(&bdoc, &region, &reindented);
            new_daily = text_after_changes(&base, &[change]);
            let ndoc = Doc::new(&new_daily);
            daily_line = find_entry_by_text(&ndoc, &parse_daily_region(&ndoc), &text, usize::MAX)
                .map_or(1, |e| e.start);
        }
        daily_text = Some(new_daily);
        store.upsert(DailyLink {
            id: new_id(),
            kind: LinkKind::Copied,
            day: today.to_string(),
            src_path: src_path.to_string(),
            daily_path: daily_path.to_string(),
            text,
            src_line: line_no,
            daily_line,
        });
        mutated = true;
        report.sent += 1;
    }
    (if mutated { daily_text } else { None }, report)
}

// ---------------------------------------------------------------- 待办跟随

/// Initial content of a new day's daily: bare scaffold + the previous day's
/// unfinished todos (rollover, see `model::rollover_blocks`). "Previous" =
/// the latest daily earlier than today in `Daily/`. Rollover is an
/// enhancement, never an obligation: unreadable directories/files or any
/// error fold into the bare scaffold, never blocking daily creation. Port of
/// `daily/engine.ts::dailyScaffoldWithRollover`.
pub fn daily_scaffold_with_rollover(
    read_dir: &dyn Fn(&str) -> Option<Vec<String>>,
    read_file: &dyn Fn(&str) -> Option<String>,
    vault_root: &str,
    today: &str,
) -> String {
    let base = daily_scaffold(today);
    let Some(names) = read_dir("Daily") else { return base };
    let Some(prev) = previous_daily_file(&names, today) else { return base };
    let Some(prev_text) = read_file(&daily_path_for(vault_root, &prev)) else { return base };
    compose_daily_scaffold(today, &rollover_blocks(&prev_text))
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daily::links::{DailyLink, LinkKind, LinkStore};

    const VAULT: &str = "/vault";
    const DAILY: &str = "/vault/Daily/2026-09-23.md";
    const TODAY: &str = "2026-09-23";

    fn link(id: &str, patch: impl FnOnce(&mut DailyLink)) -> DailyLink {
        let mut l = DailyLink {
            id: id.to_string(),
            kind: LinkKind::Copied,
            day: TODAY.into(),
            src_path: "/vault/p.md".into(),
            daily_path: DAILY.into(),
            text: "任务甲".into(),
            src_line: 1,
            daily_line: 3,
        };
        patch(&mut l);
        l
    }

    fn counter() -> impl FnMut() -> String {
        let mut n = 0usize;
        move || {
            n += 1;
            format!("l{n}")
        }
    }

    // ---------------------------------------------------------------- 意图提取与合并
    // (engine.test.ts "意图提取与合并")

    #[test]
    fn touched_unlinked_todo_sends_linked_one_mirrors() {
        let s = "- [ ] 甲\n";
        let e = "- [x] 甲 ✅ 2026-09-23\n";
        assert_eq!(
            intents_for_range(s, e, 0, s.len(), 0, e.len(), &[], true),
            vec![Intent::Send { root_hint: 1, text: "甲".into() }]
        );
        let links = vec![link("L", |l| l.text = "甲".into())];
        assert_eq!(
            intents_for_range(s, e, 0, s.len(), 0, e.len(), &links, true),
            vec![Intent::Mirror { link_id: "L".into(), root_hint: Some(1), renamed_to: Some("甲".into()) }]
        );
    }

    #[test]
    fn touched_nested_todo_sends_anchored_at_block_root_not_the_child_line() {
        let s = "- [ ] 父\n  - [ ] 子\n";
        let e = "- [ ] 父\n  - [x] 子\n";
        assert_eq!(
            intents_for_range(s, e, 0, s.len(), 0, e.len(), &[], true),
            vec![Intent::Send { root_hint: 1, text: "父".into() }]
        );
    }

    #[test]
    fn empty_text_todo_and_prose_lines_produce_no_send() {
        let s = "";
        let e = "- [ ] \n";
        assert_eq!(intents_for_range(s, e, 0, 0, 0, e.len(), &[], true), Vec::<Intent>::new());
        let s2 = "正文\n";
        let e2 = "正文改\n";
        assert_eq!(
            intents_for_range(s2, e2, 0, s2.len(), 0, e2.len(), &[], true),
            Vec::<Intent>::new()
        );
    }

    #[test]
    fn rename_carries_new_text_root_to_prose_signals_null() {
        let s = "- [ ] 旧名\n";
        let e = "- [ ] 新名\n";
        let links = vec![link("L", |l| l.text = "旧名".into())];
        assert_eq!(
            intents_for_range(s, e, 0, s.len(), 0, e.len(), &links, true),
            vec![Intent::Mirror { link_id: "L".into(), root_hint: Some(1), renamed_to: Some("新名".into()) }]
        );
        let e2 = "旧名\n";
        assert_eq!(
            intents_for_range(s, e2, 0, s.len(), 0, e2.len(), &links, true),
            vec![Intent::Mirror { link_id: "L".into(), root_hint: None, renamed_to: None }]
        );
    }

    #[test]
    fn paste_drop_ranges_produce_no_send_intent() {
        let s = "- [ ] 甲\n";
        let e = "- [x] 甲 ✅ 2026-09-23\n";
        assert_eq!(
            intents_for_range(s, e, 0, s.len(), 0, e.len(), &[], false),
            Vec::<Intent>::new()
        );
    }

    #[test]
    fn dedupe_merges_mirrors_by_link_and_sends_by_text() {
        let out = dedupe_intents(vec![
            Intent::Mirror { link_id: "L".into(), root_hint: None, renamed_to: None },
            Intent::Mirror { link_id: "L".into(), root_hint: Some(3), renamed_to: None },
            Intent::Send { root_hint: 5, text: "甲".into() },
            Intent::Send { root_hint: 9, text: "甲".into() },
        ]);
        assert_eq!(
            out,
            vec![
                Intent::Mirror { link_id: "L".into(), root_hint: Some(3), renamed_to: None },
                Intent::Send { root_hint: 5, text: "甲".into() },
            ]
        );
    }

    // ---------------------------------------------------------------- 发送命令
    // (engine.test.ts "发送命令", via the pure send_todo_lines core)

    /// In-memory IO for the rollover scaffold closure.
    fn mem_files() -> std::collections::HashMap<String, String> {
        std::collections::HashMap::new()
    }

    fn scaffold_fn(files: &std::collections::HashMap<String, String>) -> impl Fn() -> String + '_ {
        move || {
            daily_scaffold_with_rollover(
                &|rel| {
                    let prefix = format!("{VAULT}/{rel}/");
                    let names: Vec<String> = files
                        .keys()
                        .filter(|k| k.starts_with(&prefix) && !k[prefix.len()..].contains('/'))
                        .map(|k| k[prefix.len()..].to_string())
                        .collect();
                    Some(names)
                },
                &|p| files.get(p).cloned(),
                VAULT,
                TODAY,
            )
        }
    }

    fn send(
        src_text: &str,
        lines: &[usize],
        daily_text: Option<String>,
        files: &std::collections::HashMap<String, String>,
        store: &mut LinkStore,
    ) -> (Option<String>, SendReport) {
        send_todo_lines(
            "/vault/p.md",
            src_text,
            DAILY,
            daily_text,
            lines,
            TODAY,
            store,
            &scaffold_fn(files),
            &mut counter(),
        )
    }

    #[test]
    fn send_top_todo_with_subtree_creates_daily_and_persists_mapping() {
        let files = mem_files();
        let mut store = LinkStore::new();
        let (daily, report) = send(
            "# 项目\n\n- [ ] 写章节\n  - [ ] 查资料\n",
            &[3],
            None,
            &files,
            &mut store,
        );
        assert_eq!(daily.unwrap(), "# 2026-09-23\n\n- [ ] 写章节\n  - [ ] 查资料\n");
        assert_eq!(store.all().len(), 1);
        let l = store.all()[0];
        assert_eq!(
            (l.kind, l.text.as_str(), l.src_line, l.daily_line),
            (LinkKind::Copied, "写章节", 3, 3)
        );
        assert_eq!(report.sent, 1);
    }

    #[test]
    fn send_when_daily_missing_builds_file_with_rollover_first() {
        let mut files = mem_files();
        files.insert(
            "/vault/Daily/2026-09-22.md".to_string(),
            "# 2026-09-22\n\n- [x] 昨天做完 ✅ 2026-09-22\n- [ ] 昨天没做完\n".to_string(),
        );
        let mut store = LinkStore::new();
        let (daily, _) = send("- [ ] 新任务\n", &[1], None, &files, &mut store);
        assert_eq!(daily.unwrap(), "# 2026-09-23\n\n- [ ] 昨天没做完\n- [ ] 新任务\n");
    }

    #[test]
    fn second_send_appends_chronologically() {
        let files = mem_files();
        let mut store = LinkStore::new();
        let (daily, _) = send("- [ ] 甲\n", &[1], None, &files, &mut store);
        let mut daily = daily.unwrap();
        let (next, _) = send("- [ ] 乙\n", &[1], Some(daily.clone()), &files, &mut store);
        daily = next.unwrap();
        assert_eq!(daily, "# 2026-09-23\n\n- [ ] 甲\n- [ ] 乙\n");
    }

    #[test]
    fn send_on_child_line_promotes_child_to_top_entry_keeps_its_subtree() {
        let files = mem_files();
        let mut store = LinkStore::new();
        let (daily, _) = send("- [ ] 父\n  - [ ] 子\n    - [ ] 孙\n", &[2], None, &files, &mut store);
        assert_eq!(daily.unwrap(), "# 2026-09-23\n\n- [ ] 子\n  - [ ] 孙\n");
        assert_eq!(store.all()[0].text, "子");
        assert_eq!(store.all()[0].src_line, 2);
    }

    #[test]
    fn repeated_send_is_noop() {
        let files = mem_files();
        let mut store = LinkStore::new();
        let (daily, r1) = send("- [ ] 甲\n", &[1], None, &files, &mut store);
        let daily = daily.unwrap();
        let (again, r2) = send("- [ ] 甲\n", &[1], Some(daily), &files, &mut store);
        assert_eq!(again, None);
        assert_eq!(store.all().len(), 1);
        assert_eq!((r1.sent, r2.already), (1, 1));
    }

    #[test]
    fn send_on_child_when_root_linked_reports_already() {
        let files = mem_files();
        let mut store = LinkStore::new();
        let (daily, _) = send("- [ ] 父\n  - [ ] 子\n", &[1], None, &files, &mut store);
        let daily = daily.unwrap();
        let (again, r) = send("- [ ] 父\n  - [ ] 子\n", &[2], Some(daily), &files, &mut store);
        assert_eq!(again, None);
        assert_eq!(store.all().len(), 1);
        assert_eq!(r.already, 1);
    }

    #[test]
    fn recorded_link_upgrades_to_copied_on_explicit_send() {
        let mut files = mem_files();
        let mut store = LinkStore::new();
        store.upsert(link("r1", |l| {
            l.kind = LinkKind::Recorded;
            l.src_line = 1;
        }));
        let daily = "# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n".to_string();
        files.insert(DAILY.to_string(), daily.clone());
        let (out, r) = send("- [ ] 任务甲\n", &[1], Some(daily.clone()), &files, &mut store);
        // Already mapped and present: no rewrite of the daily (mutation-free).
        assert_eq!(out, None);
        assert_eq!(files.get(DAILY).unwrap(), &daily);
        assert_eq!(store.get_by_id("r1").unwrap().kind, LinkKind::Copied);
        assert_eq!(r.already, 1);
    }

    #[test]
    fn claims_existing_identical_entry_instead_of_reappending() {
        let mut files = mem_files();
        let daily = "# 2026-09-23\n\n- [ ] 手写的\n\n正文\n".to_string();
        files.insert(DAILY.to_string(), daily.clone());
        let mut store = LinkStore::new();
        let (out, _) = send("- [ ] 手写的\n", &[1], Some(daily), &files, &mut store);
        assert_eq!(out.unwrap(), "# 2026-09-23\n\n- [ ] 手写的\n\n正文\n");
        assert_eq!(store.all()[0].text, "手写的");
        assert_eq!(store.all()[0].daily_line, 3);
    }

    #[test]
    fn rebuild_daily_after_delete_then_resend() {
        let files = mem_files();
        let mut store = LinkStore::new();
        let (daily, r1) = send("- [ ] 甲\n", &[1], None, &files, &mut store);
        let (again, r2) = send("- [ ] 甲\n", &[1], None, &files, &mut store); // file deleted meanwhile
        assert_eq!(daily.unwrap(), "# 2026-09-23\n\n- [ ] 甲\n");
        assert_eq!(again.unwrap(), "# 2026-09-23\n\n- [ ] 甲\n");
        assert_eq!(store.all().len(), 1);
        assert_eq!((r1.sent, r2.sent), (1, 1));
    }

    #[test]
    fn resend_after_manual_entry_removal() {
        let files = mem_files();
        let mut store = LinkStore::new();
        let (_, _) = send("- [ ] 甲\n", &[1], None, &files, &mut store);
        let (again, r) = send("- [ ] 甲\n", &[1], Some("# 2026-09-23\n".to_string()), &files, &mut store);
        assert_eq!(again.unwrap(), "# 2026-09-23\n\n- [ ] 甲\n");
        assert_eq!(r.sent, 1);
    }

    #[test]
    fn stale_ancestor_mapping_resends_on_child() {
        let files = mem_files();
        let mut store = LinkStore::new();
        let (_, _) = send("- [ ] 父\n  - [ ] 子\n", &[1], None, &files, &mut store);
        let (again, r) = send(
            "- [ ] 父\n  - [ ] 子\n",
            &[2],
            Some("# 2026-09-23\n".to_string()),
            &files,
            &mut store,
        );
        assert_eq!(again.unwrap(), "# 2026-09-23\n\n- [ ] 子\n");
        assert_eq!(r.sent, 1);
        assert_eq!(store.all()[0].text, "子");
    }

    #[test]
    fn yesterdays_mapping_does_not_block_nor_break_today() {
        let mut files = mem_files();
        let yesterday = "/vault/Daily/2026-09-22.md".to_string();
        files.insert(yesterday.clone(), "# 2026-09-22\n\n- [ ] 任务甲\n".to_string());
        let mut store = LinkStore::new();
        store.upsert(link("y1", |l| {
            l.day = "2026-09-22".into();
            l.daily_path = yesterday.clone();
        }));
        let (daily, r) = send("- [ ] 任务甲\n", &[1], None, &files, &mut store);
        // Rollover brought the unfinished todo in; the send claims it.
        assert_eq!(daily.unwrap(), "# 2026-09-23\n\n- [ ] 任务甲\n");
        assert_eq!(files.get(&yesterday).unwrap(), "# 2026-09-22\n\n- [ ] 任务甲\n");
        assert_eq!(store.all().len(), 2);
        assert_eq!(r.sent, 1);
    }

    #[test]
    fn not_todo_line_counts_and_writes_nothing() {
        let files = mem_files();
        let mut store = LinkStore::new();
        let (daily, r) = send("普通文字\n", &[1], None, &files, &mut store);
        assert_eq!(daily, None);
        assert_eq!(r.not_todo, 1);
        assert!(store.all().is_empty());
    }

    // ---------------------------------------------------------------- 自动同步(触碰即发)
    // (engine.test.ts "自动同步(触碰即发)", intents + pure apply)
    //
    // The TS pipeline feeds applySend/applyMirror the transaction's changed
    // range (`iterChangedRanges`) and the post-transaction view doc; these
    // helpers reproduce that for a one-line edit.

    /// Byte range of line `n` (1-based) in `text`.
    fn line_range(text: &str, n: usize) -> (usize, usize) {
        let d = Doc::new(text);
        (d.line_start(n), d.line_end(n))
    }

    #[test]
    fn checking_unmapped_todo_sends_with_stamp_and_state() {
        let s = "- [ ] 任务甲\n- [ ] 任务乙\n";
        let e = "- [x] 任务甲 ✅ 2026-09-23\n- [ ] 任务乙\n";
        let (fa, ta) = line_range(s, 1);
        let (fb, tb) = line_range(e, 1);
        let intents = dedupe_intents(intents_for_range(s, e, fa, ta, fb, tb, &[], true));
        assert_eq!(intents, vec![Intent::Send { root_hint: 1, text: "任务甲".into() }]);
        let mut store = LinkStore::new();
        let Intent::Send { root_hint, text } = &intents[0] else { unreachable!() };
        let base = daily_scaffold_with_rollover(&|_| Some(Vec::new()), &|_| None, VAULT, TODAY);
        // The view doc the engine reads from is the post-transaction text.
        let out = apply_send("/vault/p.md", e, DAILY, &base, *root_hint, text, TODAY, "l1", &mut store);
        assert_eq!(out.daily_new.unwrap(), "# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n");
        let l = store.all()[0];
        assert_eq!((l.kind, l.text.as_str(), l.src_line), (LinkKind::Auto, "任务甲", 1));
    }

    #[test]
    fn editing_unchecked_todo_also_sends() {
        let s = "- [ ] 新任务\n";
        let e = "- [ ] 新任务!\n";
        // Zero-width insertion at the end of line 1 (before the newline),
        // like the TS `view.dispatch({changes: {from: 9, to: 9, insert: "!"}})`.
        let intents = intents_for_range(s, e, s.len() - 1, s.len() - 1, e.len() - 1, e.len() - 1, &[], true);
        let Intent::Send { root_hint, text } = &intents[0] else { unreachable!() };
        let mut store = LinkStore::new();
        let out = apply_send("/vault/p.md", e, DAILY, &daily_scaffold(TODAY), *root_hint, text, TODAY, "l1", &mut store);
        assert_eq!(out.daily_new.unwrap(), "# 2026-09-23\n\n- [ ] 新任务!\n");
        assert_eq!(store.all()[0].kind, LinkKind::Auto);
        assert_eq!(store.all()[0].text, "新任务!");
    }

    #[test]
    fn auto_send_appends_after_existing_entries() {
        let s = "- [ ] 任务甲\n";
        let e = "- [x] 任务甲 ✅ 2026-09-23\n";
        let (fa, ta) = line_range(s, 1);
        let (fb, tb) = line_range(e, 1);
        let Intent::Send { root_hint, text } =
            &intents_for_range(s, e, fa, ta, fb, tb, &[], true)[0]
        else {
            unreachable!()
        };
        let mut store = LinkStore::new();
        let out = apply_send(
            "/vault/p.md",
            e,
            DAILY,
            "# 2026-09-23\n\n- [ ] 早上的事\n",
            *root_hint,
            text,
            TODAY,
            "l1",
            &mut store,
        );
        assert_eq!(
            out.daily_new.unwrap(),
            "# 2026-09-23\n\n- [ ] 早上的事\n- [x] 任务甲 ✅ 2026-09-23\n"
        );
    }

    #[test]
    fn auto_send_creating_daily_rolls_over_previous_unfinished_first() {
        let s = "- [ ] 任务甲\n";
        let e = "- [x] 任务甲 ✅ 2026-09-23\n";
        let (fa, ta) = line_range(s, 1);
        let (fb, tb) = line_range(e, 1);
        let Intent::Send { root_hint, text } =
            &intents_for_range(s, e, fa, ta, fb, tb, &[], true)[0]
        else {
            unreachable!()
        };
        let mut files = std::collections::HashMap::new();
        files.insert(
            "/vault/Daily/2026-09-22.md".to_string(),
            "# 2026-09-22\n\n- [ ] 昨天没做完\n".to_string(),
        );
        let base = daily_scaffold_with_rollover(
            &|rel| {
                let prefix = format!("{VAULT}/{rel}/");
                Some(
                    files
                        .keys()
                        .filter(|k| k.starts_with(&prefix))
                        .map(|k| k[prefix.len()..].to_string())
                        .collect(),
                )
            },
            &|p| files.get(p).cloned(),
            VAULT,
            TODAY,
        );
        let mut store = LinkStore::new();
        let out = apply_send("/vault/p.md", e, DAILY, &base, *root_hint, text, TODAY, "l1", &mut store);
        assert_eq!(
            out.daily_new.unwrap(),
            "# 2026-09-23\n\n- [ ] 昨天没做完\n- [x] 任务甲 ✅ 2026-09-23\n"
        );
    }

    #[test]
    fn recorded_todo_unchecked_again_clears_daily_entry_and_unlinks() {
        let mut store = LinkStore::new();
        store.upsert(link("r1", |l| l.kind = LinkKind::Recorded));
        let link = store.get_by_id("r1").unwrap().clone();
        let daily = "# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n";
        let src_new = "- [ ] 任务甲";
        let out = apply_mirror(MirrorSide::Src, src_new, Some(daily), &link, Some(1), None);
        assert_eq!(out.other_new.unwrap(), "# 2026-09-23\n");
        assert_eq!(out.link, LinkChange::Remove);
    }

    #[test]
    fn child_touch_parent_unlinked_sends_whole_block_with_original_hierarchy() {
        let s = "- [ ] 父\n  - [ ] 子\n    - [ ] 孙\n";
        let e = "- [ ] 父\n  - [x] 子 ✅ 2026-09-23\n    - [ ] 孙\n";
        let (fa, ta) = line_range(s, 2);
        let (fb, tb) = line_range(e, 2);
        let Intent::Send { root_hint, text } =
            &intents_for_range(s, e, fa, ta, fb, tb, &[], true)[0]
        else {
            unreachable!()
        };
        assert_eq!((*root_hint, text.as_str()), (1, "父"));
        let mut store = LinkStore::new();
        let out = apply_send("/vault/p.md", e, DAILY, &daily_scaffold(TODAY), *root_hint, text, TODAY, "l1", &mut store);
        assert_eq!(
            out.daily_new.unwrap(),
            "# 2026-09-23\n\n- [ ] 父\n  - [x] 子 ✅ 2026-09-23\n    - [ ] 孙\n"
        );
        assert_eq!(store.all()[0].text, "父");
        assert_eq!(store.all()[0].kind, LinkKind::Auto);
    }

    #[test]
    fn child_touch_parent_linked_mirrors_block_no_duplicate_send() {
        let s = "- [ ] 父\n  - [ ] 子\n    - [ ] 孙\n";
        let e = "- [ ] 父\n  - [x] 子 ✅ 2026-09-23\n    - [ ] 孙\n";
        let links = vec![link("p1", |l| {
            l.text = "父".into();
            l.src_line = 1;
            l.daily_line = 3;
        })];
        let (fa, ta) = line_range(s, 2);
        let (fb, tb) = line_range(e, 2);
        let intents = intents_for_range(s, e, fa, ta, fb, tb, &links, true);
        assert!(
            intents.iter().all(|i| matches!(i, Intent::Mirror { .. })),
            "no send intent expected, got {intents:?}"
        );
        let daily = "# 2026-09-23\n\n- [ ] 父\n  - [ ] 子\n    - [ ] 孙\n";
        let out = apply_mirror(MirrorSide::Src, e, Some(daily), &links[0], Some(1), Some("父"));
        assert_eq!(
            out.other_new.unwrap(),
            "# 2026-09-23\n\n- [ ] 父\n  - [x] 子 ✅ 2026-09-23\n    - [ ] 孙\n"
        );
        assert!(matches!(out.link, LinkChange::Update(_)));
    }

    // ---------------------------------------------------------------- 双向镜像
    // (engine.test.ts "双向镜像", via pure apply_mirror)

    #[test]
    fn src_complete_copied_todo_mirrors_check_to_daily() {
        let mut store = LinkStore::new();
        store.upsert(link("c1", |_| {}));
        let link = store.get_by_id("c1").unwrap().clone();
        let daily = "# 2026-09-23\n\n- [ ] 任务甲\n";
        let out = apply_mirror(
            MirrorSide::Src,
            "- [x] 任务甲 ✅ 2026-09-23",
            Some(daily),
            &link,
            Some(1),
            None,
        );
        assert_eq!(out.other_new.unwrap(), "# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n");
        assert_eq!(store.all().len(), 1);
    }

    #[test]
    fn src_uncheck_copied_todo_resets_both_sides_entry_kept() {
        let mut store = LinkStore::new();
        store.upsert(link("c1", |_| {}));
        let link = store.get_by_id("c1").unwrap().clone();
        let daily = "# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n";
        let out = apply_mirror(MirrorSide::Src, "- [ ] 任务甲", Some(daily), &link, Some(1), None);
        assert_eq!(out.other_new.unwrap(), "# 2026-09-23\n\n- [ ] 任务甲\n");
        assert!(matches!(out.link, LinkChange::Update(_)));
        assert_eq!(out.local_new, None);
    }

    #[test]
    fn daily_check_mirrors_back_to_src_with_stamp() {
        let mut store = LinkStore::new();
        store.upsert(link("c1", |_| {}));
        let link = store.get_by_id("c1").unwrap().clone();
        let src = "- [ ] 任务甲\n";
        let out = apply_mirror(
            MirrorSide::Daily,
            "# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n",
            Some(src),
            &link,
            Some(3),
            None,
        );
        assert_eq!(out.other_new.unwrap(), "- [x] 任务甲 ✅ 2026-09-23\n");
    }

    #[test]
    fn daily_add_child_mirrors_back_restoring_src_root_indent() {
        let mut store = LinkStore::new();
        store.upsert(link("c1", |_| {}));
        let link = store.get_by_id("c1").unwrap().clone();
        let src = "  - [ ] 任务甲\n";
        let out = apply_mirror(
            MirrorSide::Daily,
            "# 2026-09-23\n\n- [ ] 任务甲\n  - [ ] 新子项\n",
            Some(src),
            &link,
            Some(3),
            None,
        );
        assert_eq!(out.other_new.unwrap(), "  - [ ] 任务甲\n    - [ ] 新子项\n");
    }

    #[test]
    fn src_rename_updates_daily_and_migrates_anchor() {
        let mut store = LinkStore::new();
        store.upsert(link("c1", |l| l.text = "旧名".into()));
        let link = store.get_by_id("c1").unwrap().clone();
        let daily = "# 2026-09-23\n\n- [ ] 旧名\n";
        let out = apply_mirror(MirrorSide::Src, "- [ ] 新名", Some(daily), &link, Some(1), Some("新名"));
        assert_eq!(out.other_new.unwrap(), "# 2026-09-23\n\n- [ ] 新名\n");
        match out.link {
            LinkChange::Update(l) => assert_eq!(l.text, "新名"),
            other => panic!("expected update, got {other:?}"),
        }
    }

    #[test]
    fn src_root_becomes_prose_deletes_daily_entry_and_unlinks() {
        let mut store = LinkStore::new();
        store.upsert(link("c1", |_| {}));
        let link = store.get_by_id("c1").unwrap().clone();
        let daily = "# 2026-09-23\n\n- [ ] 任务甲\n";
        let out = apply_mirror(MirrorSide::Src, "任务甲", Some(daily), &link, None, None);
        assert_eq!(out.other_new.unwrap(), "# 2026-09-23\n");
        assert_eq!(out.link, LinkChange::Remove);
    }

    #[test]
    fn daily_entry_deleted_by_user_unlinks_only_src_kept() {
        let mut store = LinkStore::new();
        store.upsert(link("c1", |_| {}));
        let link = store.get_by_id("c1").unwrap().clone();
        // The user deleted the entry line in the daily editor.
        let daily_after = "# 2026-09-23\n\n\n正文\n";
        let out = apply_mirror(MirrorSide::Daily, daily_after, Some("- [ ] 任务甲\n"), &link, None, None);
        assert_eq!(out.other_new, None);
        assert_eq!(out.local_new, None);
        assert_eq!(out.link, LinkChange::Remove);
    }

    #[test]
    fn daily_root_becomes_prose_unlinks_only_src_untouched() {
        let mut store = LinkStore::new();
        store.upsert(link("c1", |_| {}));
        let link = store.get_by_id("c1").unwrap().clone();
        let daily_after = "# 2026-09-23\n\n任务甲\n";
        let out = apply_mirror(MirrorSide::Daily, daily_after, Some("- [ ] 任务甲\n"), &link, None, None);
        assert_eq!(out.other_new, None);
        assert_eq!(out.link, LinkChange::Remove);
    }

    #[test]
    fn other_file_unreadable_unlinks_without_crash() {
        let mut store = LinkStore::new();
        store.upsert(link("c1", |_| {}));
        let link = store.get_by_id("c1").unwrap().clone();
        let out = apply_mirror(
            MirrorSide::Daily,
            "# 2026-09-23\n\n- [x] 任务甲 ✅ 2026-09-23\n",
            None,
            &link,
            Some(3),
            None,
        );
        assert_eq!(out.link, LinkChange::Remove);
        assert_eq!(out.other_new, None);
    }

    #[test]
    fn daily_side_recorded_uncheck_drops_local_entry_and_unchecks_src() {
        // From engine.ts: 日记侧取消:摘掉本地条目,并把源待办翻回未完成
        let mut store = LinkStore::new();
        store.upsert(link("r1", |l| l.kind = LinkKind::Recorded));
        let link = store.get_by_id("r1").unwrap().clone();
        let daily_after = "# 2026-09-23\n\n- [ ] 任务甲\n";
        let src = "- [x] 任务甲 ✅ 2026-09-23\n";
        let out = apply_mirror(MirrorSide::Daily, daily_after, Some(src), &link, Some(3), None);
        assert_eq!(out.local_new.unwrap(), "# 2026-09-23\n");
        assert_eq!(out.other_new.unwrap(), "- [ ] 任务甲\n");
        assert_eq!(out.link, LinkChange::Remove);
    }

    // ---------------------------------------------------------------- 待办跟随

    #[test]
    fn scaffold_with_rollover_composes_from_previous_daily() {
        let files = std::collections::HashMap::from([(
            "/vault/Daily/2026-09-22.md".to_string(),
            "# 2026-09-22\n\n- [x] 做完 ✅ 2026-09-22\n- [ ] 没做完\n".to_string(),
        )]);
        let text = daily_scaffold_with_rollover(
            &|rel| {
                let prefix = format!("{VAULT}/{rel}/");
                Some(
                    files
                        .keys()
                        .filter(|k| k.starts_with(&prefix))
                        .map(|k| k[prefix.len()..].to_string())
                        .collect(),
                )
            },
            &|p| files.get(p).cloned(),
            VAULT,
            TODAY,
        );
        assert_eq!(text, "# 2026-09-23\n\n- [ ] 没做完\n");
    }

    #[test]
    fn scaffold_with_rollover_folds_every_failure_into_bare_scaffold() {
        let bare = daily_scaffold(TODAY);
        // Directory listing fails
        assert_eq!(
            daily_scaffold_with_rollover(&|_| None, &|_: &str| None, VAULT, TODAY),
            bare
        );
        // No previous daily
        assert_eq!(
            daily_scaffold_with_rollover(&|_| Some(Vec::new()), &|_: &str| None, VAULT, TODAY),
            bare
        );
        // Previous daily unreadable
        assert_eq!(
            daily_scaffold_with_rollover(&|_| Some(vec!["2026-09-22.md".into()]), &|_| None, VAULT, TODAY),
            bare
        );
    }
}
