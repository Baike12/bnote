//! The RPC surface the phone drives (`protocol/v1.md` §6.3).
//!
//! Every method is a thin wrapper over an existing command or Session API; the
//! dispatcher is an allowlist, not a generic command forwarder. In particular
//! `agent_get_config` and `load_app_config` are absent by construction: the
//! model catalog below is rebuilt without API keys.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::Manager;

use crate::agent::models::ModelSelection;
use crate::agent::session::Session;
use crate::agent::types::{AgentEvent, ChatItem, Content};
use crate::state::AppState;

use super::audit;
use super::checkpoint;
use super::client::{ClientHandle, Control};
use super::manager::RemoteManager;
use super::pairing;
use super::recorder;
use super::settings;
use super::transcript;
use super::Origin;

#[derive(Debug)]
pub struct RpcError {
    pub code: &'static str,
    pub message: String,
}

impl RpcError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn from_cmd(e: String) -> RpcError {
    let code = match e.split(':').next().unwrap_or("") {
        "SESSION_NOT_FOUND" | "NOT_FOUND" => "SESSION_NOT_FOUND",
        "NO_VAULT" => "NO_VAULT",
        "INVALID_WORKDIR" => "BAD_PARAMS",
        "SESSION_BUSY" => "SESSION_BUSY",
        "NO_API_KEY" => "NOT_FOUND",
        _ => "INTERNAL",
    };
    RpcError::new(code, e)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn project_id_for(session: &Session) -> Option<String> {
    session.ctx.workdir.as_deref().map(settings::project_id_for)
}

fn live(state: &AppState, live_id: &str) -> Result<Arc<Session>, RpcError> {
    let registry = state
        .sessions
        .lock()
        .map_err(|_| RpcError::new("INTERNAL", "session registry poisoned"))?;
    registry
        .get(live_id)
        .cloned()
        .ok_or_else(|| RpcError::new("SESSION_NOT_FOUND", "session is not live"))
}

fn live_by_transcript(state: &AppState, transcript_id: &str) -> Option<Arc<Session>> {
    let registry = state.sessions.lock().ok()?;
    registry
        .values()
        .find(|s| s.transcript_id() == transcript_id)
        .cloned()
}

fn title_of(session: &Session) -> String {
    session
        .history()
        .iter()
        .find_map(|item| match item {
            ChatItem::Message { role, content } if role == "user" => {
                content.iter().find_map(|c| match c {
                    Content::Text { text } if !text.trim().is_empty() => Some(
                        text.lines()
                            .next()
                            .unwrap_or("")
                            .chars()
                            .take(80)
                            .collect::<String>(),
                    ),
                    _ => None,
                })
            }
            _ => None,
        })
        .unwrap_or_else(|| session.transcript_id().to_string())
}

fn summary(session: &Arc<Session>) -> Value {
    let project = project_id_for(session);
    let pending = {
        let permission = session
            .pending_permissions
            .lock()
            .map(|g| !g.is_empty())
            .unwrap_or(false);
        let question = session
            .pending_questions
            .lock()
            .map(|g| !g.is_empty())
            .unwrap_or(false);
        if permission {
            "permission"
        } else if question {
            "question"
        } else {
            "none"
        }
    };
    json!({
        "transcriptId": session.transcript_id(),
        "liveId": session.id,
        "projectId": project,
        "title": title_of(session),
        "running": session.running.load(std::sync::atomic::Ordering::SeqCst),
        "origin": match session.origin() { Origin::Local => "local", Origin::Remote => "remote" },
        "pending": if pending == "none" { Value::Null } else { json!(pending) },
        "model": session.provider().model,
        "permissionMode": session.permission_mode().id(),
        "updatedAt": 0,
    })
}

fn state_json(session: &Arc<Session>) -> Value {
    let selection = session.selection.lock().map(|g| g.clone()).ok();
    let todos = session.todos.lock().map(|g| g.clone()).unwrap_or_default();
    json!({
        "liveId": session.id,
        "transcriptId": session.transcript_id(),
        "running": session.running.load(std::sync::atomic::Ordering::SeqCst),
        "origin": match session.origin() { Origin::Local => "local", Origin::Remote => "remote" },
        "model": session.provider().model,
        "selection": selection,
        "permissionMode": session.permission_mode().id(),
        "todos": todos,
        "pendingPermission": Value::Null,
        "pendingQuestion": Value::Null,
        "eventSeq": session.events.event_seq(),
        "turn": session.events.turn().map(|turn| json!({
            "startedAt": turn.started_at,
            "text": turn.text,
            "thinking": turn.thinking,
            "tools": turn.tools.iter().map(|t| json!({
                "id": t.id,
                "name": t.name,
                "input": t.input,
                "done": t.done,
                "outputSummary": t.output,
            })).collect::<Vec<_>>(),
        })),
    })
}

fn event_json(record: &super::events::EventRecord) -> Value {
    json!({
        "t": "evt",
        "name": "agent.event",
        "data": {
            "sessionId": record.session_id,
            "eventSeq": record.seq,
            "event": record.event,
        },
    })
}

/// Installs the bus forwarder for one (device, session). Idempotent: a phone
/// that attaches twice does not duplicate every event.
fn subscribe(handle: &ClientHandle, device: &str, session: &Arc<Session>) {
    if !handle.mark_subscribed(&format!("{device}|{}", session.id)) {
        return;
    }
    let mut rx = session.events.subscribe();
    let handle = handle.clone();
    let device = device.to_string();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(record) => handle.send_app(Some(device.clone()), event_json(&record)),
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
}

async fn start_session(
    handle: &ClientHandle,
    project_id: &str,
) -> Result<(Arc<Session>, String), RpcError> {
    let state = handle.app.state::<AppState>();
    let data_dir = state.data_dir();
    let workdir = settings::allowed_project(&data_dir, project_id)
        .ok_or_else(|| RpcError::new("BAD_PARAMS", "project is not on the allowlist"))?;
    let transcript_id = super::crypto::hex_encode(&super::crypto::random::<16>());
    let value = crate::commands::agent::agent_start_session(
        handle.app.clone(),
        state,
        None,
        None,
        None,
        None,
        None,
        Some("coding".into()),
        Some(workdir.to_string_lossy().to_string()),
        None,
        Some(transcript_id.clone()),
    )
    .await
    .map_err(from_cmd)?;
    let live_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new("INTERNAL", "start returned no sessionId"))?
        .to_string();
    let state = handle.app.state::<AppState>();
    let session = live(&state, &live_id)?;
    session.take_remote_origin();
    Ok((session, transcript_id))
}

#[allow(clippy::too_many_lines)]
pub async fn dispatch(
    handle: ClientHandle,
    device: &str,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    let state = handle.app.state::<AppState>();
    let data_dir = state.data_dir();
    match method {
        "projects.list" => {
            let projects = settings::load_settings(&data_dir)
                .allowed_projects
                .iter()
                .map(|path| {
                    let path = std::path::PathBuf::from(path);
                    json!({
                        "id": settings::project_id_for(&path),
                        "name": path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({"projects": projects}))
        }
        "sessions.list" => {
            let project_id = params
                .get("projectId")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::new("BAD_PARAMS", "projectId"))?;
            let registry = state
                .sessions
                .lock()
                .map_err(|_| RpcError::new("INTERNAL", "registry poisoned"))?;
            let sessions = registry
                .values()
                .filter(|s| project_id_for(s).as_deref() == Some(project_id))
                .map(summary)
                .collect::<Vec<_>>();
            Ok(json!({"sessions": sessions}))
        }
        "sessions.start" => {
            let project_id = params
                .get("projectId")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::new("BAD_PARAMS", "projectId"))?;
            let (session, transcript_id) = start_session(&handle, project_id).await?;
            if let Some(mode) = params.get("permissionMode").and_then(Value::as_str) {
                if let Some(mode) = crate::agent::permissions::Mode::parse(mode) {
                    session.set_permission_mode(mode);
                }
            }
            subscribe(&handle, device, &session);
            audit::append(&data_dir, device, "pair", "started a coding session");
            handle.send_app(
                None,
                json!({
                    "t": "evt",
                    "name": "session.created",
                    "data": {
                        "transcriptId": transcript_id,
                        "liveId": session.id,
                        "projectId": project_id,
                        "title": title_of(&session),
                        "origin": "remote",
                    }
                }),
            );
            Ok(json!({
                "liveId": session.id,
                "transcriptId": transcript_id,
                "state": state_json(&session),
            }))
        }
        "sessions.attach" => {
            let project_id = params
                .get("projectId")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::new("BAD_PARAMS", "projectId"))?;
            let transcript_id = params
                .get("transcriptId")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::new("BAD_PARAMS", "transcriptId"))?;
            if let Some(session) = live_by_transcript(&state, transcript_id) {
                subscribe(&handle, device, &session);
                return Ok(json!({
                    "liveId": session.id,
                    "transcriptId": transcript_id,
                    "title": title_of(&session),
                    "state": state_json(&session),
                    "history": session.history(),
                    "historyTruncated": false,
                }));
            }
            // Not live: restore from disk exactly as the desktop's restore
            // does, with the record's own id as the task list.
            let workdir = settings::allowed_project(&data_dir, project_id)
                .ok_or_else(|| RpcError::new("BAD_PARAMS", "project is not on the allowlist"))?;
            let path = crate::agent::home::session_transcript(&workdir, transcript_id);
            let loaded = transcript::load(&path).map_err(|e| RpcError::new("NOT_FOUND", e))?;
            let value = crate::commands::agent::agent_start_session(
                handle.app.clone(),
                handle.app.state::<AppState>(),
                None,
                None,
                Some(loaded.items),
                loaded.model,
                loaded.selection,
                Some("coding".into()),
                Some(workdir.to_string_lossy().to_string()),
                None,
                Some(transcript_id.to_string()),
            )
            .await
            .map_err(from_cmd)?;
            let live_id = value
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| RpcError::new("INTERNAL", "restore returned no sessionId"))?;
            let state = handle.app.state::<AppState>();
            let session = live(&state, live_id)?;
            session.take_remote_origin();
            subscribe(&handle, device, &session);
            Ok(json!({
                "liveId": session.id,
                "transcriptId": transcript_id,
                "title": loaded.title,
                "state": state_json(&session),
                "history": session.history(),
                "historyTruncated": false,
            }))
        }
        "sessions.history" => {
            let live_id = str_param(&params, "liveId")?;
            let session = live(&state, live_id)?;
            Ok(json!({"items": session.history(), "truncated": false}))
        }
        "sessions.send" => {
            let live_id = str_param(&params, "liveId")?;
            let text = str_param(&params, "text")?;
            let client_id = params
                .get("clientId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let session = live(&state, live_id)?;
            if text.trim().is_empty() {
                return Err(RpcError::new("BAD_PARAMS", "empty message"));
            }
            if session
                .running
                .compare_exchange(
                    false,
                    true,
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                )
                .is_err()
            {
                return Err(RpcError::new("SESSION_BUSY", "a turn is already running"));
            }
            if let Some(workdir) = session.ctx.workdir.clone() {
                let items = session.history().len();
                if let Ok(cp) = checkpoint::create(&workdir, &data_dir, &session.id, items) {
                    handle.app.state::<RemoteManager>().remember_checkpoint(cp);
                }
            }
            // Flip the writer only after the busy CAS: a rejected send must not
            // stop the desktop from recording a turn it is already running.
            session.take_remote_origin();
            let items = session.history().len() + 1;
            session.emit(AgentEvent::TurnStart { items });
            audit::append(&data_dir, device, "send", text);
            let turn = session.clone();
            let client_id = client_id.clone();
            let text = text.to_string();
            tauri::async_runtime::spawn(async move {
                use futures::FutureExt;
                let fut = std::panic::AssertUnwindSafe(turn.send_with_client(
                    &text,
                    Vec::new(),
                    &client_id,
                ));
                if fut.catch_unwind().await.is_err() {
                    turn.emit(AgentEvent::Error {
                        message: "会话内部错误,本轮已中止(可重试)".into(),
                        items: turn.history().len(),
                    });
                }
            });
            Ok(json!({"accepted": true}))
        }
        "sessions.abort" => {
            let live_id = str_param(&params, "liveId")?;
            let session = live(&state, live_id)?;
            session.ctx.abort.abort();
            audit::append(&data_dir, device, "abort", "aborted the turn");
            Ok(json!({}))
        }
        "sessions.setPermissionMode" => {
            let live_id = str_param(&params, "liveId")?;
            let mode = str_param(&params, "mode")?;
            let mode = crate::agent::permissions::Mode::parse(mode)
                .ok_or_else(|| RpcError::new("BAD_PARAMS", "unknown mode"))?;
            let session = live(&state, live_id)?;
            session.set_permission_mode(mode);
            Ok(json!({"mode": mode.id()}))
        }
        "sessions.models" => {
            let live_id = str_param(&params, "liveId")?;
            let session = live(&state, live_id)?;
            let provider = session.provider();
            let selection = session.selection.lock().map(|g| g.clone()).ok();
            Ok(json!({
                "models": [{
                    "providerId": provider.provider_id,
                    "providerName": provider.model,
                    "modelId": provider.model_id,
                    "modelName": provider.model,
                    "thinkingLevels": [],
                }],
                "selection": selection,
            }))
        }
        "sessions.setModel" => {
            let live_id = str_param(&params, "liveId")?.to_string();
            let selection: ModelSelection = serde_json::from_value(
                params
                    .get("selection")
                    .cloned()
                    .ok_or_else(|| RpcError::new("BAD_PARAMS", "selection"))?,
            )
            .map_err(|_| RpcError::new("BAD_PARAMS", "selection"))?;
            let value = crate::commands::agent::agent_set_session_model(
                handle.app.state::<AppState>(),
                live_id,
                selection,
            )
            .await
            .map_err(from_cmd)?;
            Ok(json!({"selection": value.get("selection").cloned().unwrap_or(Value::Null)}))
        }
        "permission.reply" => {
            let live_id = str_param(&params, "liveId")?;
            let request_id = str_param(&params, "requestId")?;
            let allow = params
                .get("allow")
                .and_then(Value::as_bool)
                .ok_or_else(|| RpcError::new("BAD_PARAMS", "allow"))?;
            let feedback = params
                .get("feedback")
                .and_then(Value::as_str)
                .map(str::to_string);
            let session = live(&state, live_id)?;
            session
                .resolve_permission(
                    request_id,
                    crate::agent::session::PermissionAnswer { allow, feedback },
                )
                .map_err(from_cmd)?;
            session.emit(AgentEvent::PermissionResolved {
                id: request_id.to_string(),
                allow,
            });
            audit::append(
                &data_dir,
                device,
                "permission",
                if allow {
                    "allowed a tool"
                } else {
                    "denied a tool"
                },
            );
            Ok(json!({}))
        }
        "question.reply" => {
            let live_id = str_param(&params, "liveId")?;
            let request_id = str_param(&params, "requestId")?;
            let answer = str_param(&params, "answer")?;
            let session = live(&state, live_id)?;
            session
                .resolve_question(request_id, answer.to_string())
                .map_err(from_cmd)?;
            session.emit(AgentEvent::QuestionResolved {
                id: request_id.to_string(),
            });
            Ok(json!({}))
        }
        "resume" => {
            let transcript_id = str_param(&params, "transcriptId")?;
            let after = params
                .get("afterEventSeq")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let session = live_by_transcript(&state, transcript_id)
                .ok_or_else(|| RpcError::new("SESSION_NOT_FOUND", "not live"))?;
            let (events, gap) = session.events.replay_after(after);
            if gap {
                Ok(json!({
                    "replayed": [],
                    "snapshot": {
                        "liveId": session.id,
                        "transcriptId": session.transcript_id(),
                        "state": state_json(&session),
                        "history": session.history(),
                        "historyTruncated": false,
                    }
                }))
            } else {
                Ok(json!({
                    "replayed": events.iter().map(event_json).collect::<Vec<_>>(),
                    "snapshot": Value::Null,
                }))
            }
        }
        "devices.list" => Ok(json!({"devices": pairing::load_devices(&data_dir)})),
        "devices.revoke" => {
            let device_id = str_param(&params, "deviceId")?;
            pairing::revoke_device(&data_dir, device_id)
                .map_err(|e| RpcError::new("NOT_FOUND", e))?;
            let _ = handle.control.send(Control::Revoke {
                device_id: device_id.to_string(),
            });
            audit::append(&data_dir, device, "revoke", device_id);
            Ok(json!({}))
        }
        "audit.tail" => {
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
            Ok(json!({
                "entries": audit::tail(&data_dir, limit),
                "nextCursor": Value::Null,
            }))
        }
        "todo.config" => Ok(json!({})),
        "checkpoint.create" => {
            let live_id = str_param(&params, "liveId")?;
            let session = live(&state, live_id)?;
            let workdir = session
                .ctx
                .workdir
                .clone()
                .ok_or_else(|| RpcError::new("BAD_PARAMS", "session has no workdir"))?;
            let cp = checkpoint::create(&workdir, &data_dir, &session.id, session.history().len())
                .map_err(|e| RpcError::new("INTERNAL", e))?;
            handle
                .app
                .state::<RemoteManager>()
                .remember_checkpoint(cp.clone());
            serde_json::to_value(cp).map_err(|e| RpcError::new("INTERNAL", e.to_string()))
        }
        "checkpoint.rollback" => {
            let live_id = str_param(&params, "liveId")?;
            let checkpoint_id = str_param(&params, "checkpointId")?;
            let session = live(&state, live_id)?;
            if session.running.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(RpcError::new("SESSION_BUSY", "stop the turn first"));
            }
            let cp = checkpoint::load(&data_dir, checkpoint_id)
                .map_err(|e| RpcError::new("NOT_FOUND", e))?;
            if cp.live_id != session.id {
                return Err(RpcError::new(
                    "BAD_PARAMS",
                    "checkpoint belongs to another session",
                ));
            }
            let workdir = session
                .ctx
                .workdir
                .clone()
                .ok_or_else(|| RpcError::new("BAD_PARAMS", "session has no workdir"))?;
            checkpoint::rollback(&workdir, &data_dir, &cp)
                .map_err(|e| RpcError::new("INTERNAL", e))?;
            if let Ok(mut items) = session.items.lock() {
                let len = items.len();
                items.truncate(cp.items_len.min(len));
                items.push(crate::agent::types::ChatItem::user_text(
                    "<system-reminder>本轮改动已回滚到检查点，相关文件回到回合开始前的状态。</system-reminder>",
                ));
            }
            recorder::record_reset(&session, checkpoint_id);
            audit::append(&data_dir, device, "rollback", checkpoint_id);
            Ok(json!({"restored": true}))
        }
        "diff.files" => {
            let live_id = str_param(&params, "liveId")?;
            let session = live(&state, live_id)?;
            let workdir = session
                .ctx
                .workdir
                .clone()
                .ok_or_else(|| RpcError::new("BAD_PARAMS", "session has no workdir"))?;
            let cp = checkpoint_for(&handle, &params, &session)?;
            let (files, _) = diff_files(&workdir, &data_dir, &cp)?;
            Ok(json!({"files": files, "checkpointId": cp.checkpoint_id}))
        }
        "diff.file" => {
            let live_id = str_param(&params, "liveId")?;
            let path = str_param(&params, "path")?;
            let session = live(&state, live_id)?;
            let workdir = session
                .ctx
                .workdir
                .clone()
                .ok_or_else(|| RpcError::new("BAD_PARAMS", "session has no workdir"))?;
            let cp = checkpoint_for(&handle, &params, &session)?;
            let (patch, truncated) = diff_file(&workdir, &data_dir, &cp, path)?;
            Ok(json!({"path": path, "patch": patch, "truncated": truncated}))
        }
        _ => Err(RpcError::new("UNKNOWN_METHOD", method)),
    }
}

fn checkpoint_for(
    handle: &ClientHandle,
    params: &Value,
    session: &Arc<Session>,
) -> Result<checkpoint::Checkpoint, RpcError> {
    let manager = handle.app.state::<RemoteManager>();
    if let Some(id) = params.get("checkpointId").and_then(Value::as_str) {
        return checkpoint::load(&handle.app.state::<AppState>().data_dir(), id)
            .map_err(|e| RpcError::new("NOT_FOUND", e));
    }
    manager
        .checkpoint_for(&session.id)
        .ok_or_else(|| RpcError::new("CHECKPOINT_REQUIRED", "no checkpoint for this turn"))
}

fn git(workdir: &std::path::Path, args: &[&str]) -> Result<String, RpcError> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(workdir)
        .args(args)
        .output()
        .map_err(|e| RpcError::new("INTERNAL", format!("git: {e}")))?;
    if !out.status.success() {
        return Err(RpcError::new(
            "INTERNAL",
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn diff_files(
    workdir: &std::path::Path,
    data_dir: &std::path::Path,
    cp: &checkpoint::Checkpoint,
) -> Result<(Vec<Value>, Option<String>), RpcError> {
    let (stash, untracked) = checkpoint::diff_base(data_dir, &cp.checkpoint_id)
        .map_err(|e| RpcError::new("NOT_FOUND", e))?;
    let base = stash.clone().unwrap_or_else(|| "HEAD".to_string());
    let numstat = git(workdir, &["diff", "--numstat", &base])?;
    let status = git(workdir, &["diff", "--name-status", &base])?;
    let mut out = Vec::new();
    let counts = numstat
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let add = parts.next()?;
            let del = parts.next()?;
            let path = parts.next()?;
            Some((
                path.to_string(),
                (
                    add.parse::<u64>().unwrap_or(0),
                    del.parse::<u64>().unwrap_or(0),
                ),
            ))
        })
        .collect::<std::collections::HashMap<String, (u64, u64)>>();
    for line in status.lines() {
        let mut parts = line.split('\t');
        let code = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("").to_string();
        if path.is_empty() {
            continue;
        }
        let kind = match code.chars().next().unwrap_or('M') {
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            _ => "modified",
        };
        let (additions, deletions) = counts.get(&path).copied().unwrap_or((0, 0));
        out.push(json!({
            "path": path,
            "status": kind,
            "additions": additions,
            "deletions": deletions,
        }));
    }
    for path in untracked {
        if !out
            .iter()
            .any(|f| f.get("path").and_then(Value::as_str) == Some(path.as_str()))
        {
            out.push(json!({
                "path": path,
                "status": "added",
                "additions": 0,
                "deletions": 0,
            }));
        }
    }
    out.sort_by(|a, b| {
        a.get("path")
            .and_then(Value::as_str)
            .cmp(&b.get("path").and_then(Value::as_str))
    });
    Ok((out, stash))
}

fn diff_file(
    workdir: &std::path::Path,
    data_dir: &std::path::Path,
    cp: &checkpoint::Checkpoint,
    path: &str,
) -> Result<(String, bool), RpcError> {
    let (stash, _) = checkpoint::diff_base(data_dir, &cp.checkpoint_id)
        .map_err(|e| RpcError::new("NOT_FOUND", e))?;
    let base = stash.unwrap_or_else(|| "HEAD".to_string());
    let patch = git(workdir, &["diff", &base, "--", path])?;
    const LIMIT: usize = 2 << 20;
    if patch.len() <= LIMIT {
        return Ok((patch, false));
    }
    let end = (0..=LIMIT)
        .rev()
        .find(|i| patch.is_char_boundary(*i))
        .unwrap_or(0);
    Ok((format!("{}…[truncated]", &patch[..end]), true))
}

fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new("BAD_PARAMS", key))
}

// Keep the session list's timestamp meaningful without a second source.
#[allow(dead_code)]
fn _now() -> u64 {
    now_ms()
}
