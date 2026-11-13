//! The todo tool's state (Claude Code's TodoWrite schema): a per-session task
//! list the model maintains across tool rounds. Stored on the `Session`, shown
//! in the panel through the `todos` event.

use serde::{Deserialize, Serialize};

pub const TODO_STATUSES: &[&str] = &["pending", "in_progress", "completed"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TodoItem {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub status: String,
    /// The present-progress label shown while the item runs (Claude Code keeps
    /// it next to the imperative `content`).
    #[serde(default)]
    pub active_form: String,
}

/// Validates and replaces the session's list. Returns an error message naming
/// the first offending item instead of silently repairing the model's input.
pub fn replace_list(
    current: &mut Vec<TodoItem>,
    input: &serde_json::Value,
) -> Result<String, String> {
    let Some(items) = input["todos"].as_array() else {
        return Err("input 要有 todos 数组".into());
    };
    if items.len() > 50 {
        return Err(format!("todos 最多 50 项(收到 {})", items.len()));
    }
    let mut parsed = Vec::with_capacity(items.len());
    for (i, raw) in items.iter().enumerate() {
        let content = raw["content"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();
        if content.is_empty() {
            return Err(format!("todos[{}].content 不能为空", i));
        }
        let status = raw["status"].as_str().unwrap_or_default();
        if !TODO_STATUSES.contains(&status) {
            return Err(format!(
                "todos[{}].status 必须是 {} 之一(收到 {:?})",
                i,
                TODO_STATUSES.join("/"),
                status
            ));
        }
        let active = raw["active_form"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();
        let active = if active.is_empty() {
            content.clone()
        } else {
            active
        };
        parsed.push(TodoItem {
            content,
            status: status.to_string(),
            active_form: active,
        });
    }
    let in_progress = parsed.iter().filter(|t| t.status == "in_progress").count();
    if in_progress > 1 {
        return Err(format!("同时只能有一项 in_progress(收到 {})", in_progress));
    }
    let summary = summarize(&parsed);
    *current = parsed;
    Ok(summary)
}

/// One-line status the tool returns to the model.
fn summarize(todos: &[TodoItem]) -> String {
    if todos.is_empty() {
        return "(清单已清空)".into();
    }
    let done = todos.iter().filter(|t| t.status == "completed").count();
    let active = todos
        .iter()
        .find(|t| t.status == "in_progress")
        .map(|t| t.active_form.clone())
        .unwrap_or_default();
    let head = format!("清单已更新:{}/{} 完成", done, todos.len());
    if active.is_empty() {
        head
    } else {
        format!("{};当前:{active}", head)
    }
}

/// Renders the list for the `todos` event (the panel's own state source).
pub fn render(todos: &[TodoItem]) -> Vec<TodoItem> {
    todos.to_vec()
}

/// Reads the list back for the model (`TodoRead`).
///
/// Why a tool and not only the write summary: the list lives in the session,
/// not in the model's context, so after a compaction or a long stretch of tool
/// rounds the model cannot see what is still open. Reading it back is what
/// keeps the plan honest.
pub fn text(todos: &[TodoItem]) -> String {
    if todos.is_empty() {
        return "(清单为空)".into();
    }
    let done = todos.iter().filter(|t| t.status == "completed").count();
    let mut out = format!("清单:{done}/{} 完成\n", todos.len());
    for item in todos {
        let (mark, suffix) = match item.status.as_str() {
            "completed" => ("[x]", ""),
            "in_progress" => ("[>]", "  (进行中)"),
            _ => ("[ ]", ""),
        };
        out.push_str(&format!("- {mark} {}{suffix}\n", item.content));
    }
    out.trim_end().to_string()
}

/// The todo list of one session on disk: it survives a restart, so the panel
/// shows it again when the session is restored.
pub fn load(path: &std::path::Path) -> Vec<TodoItem> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(items) = serde_json::from_str::<Vec<TodoItem>>(&raw) else {
        // A hand-edited or truncated file must not take the session down.
        eprintln!(
            "[agent] unreadable todo file, starting empty: {}",
            path.display()
        );
        return Vec::new();
    };
    // The same invariants the writer enforces, since the file is editable.
    let mut seen_active = false;
    items
        .into_iter()
        .filter(|item| {
            if item.content.trim().is_empty() || !TODO_STATUSES.contains(&item.status.as_str()) {
                return false;
            }
            if item.status == "in_progress" {
                if seen_active {
                    return false;
                }
                seen_active = true;
            }
            true
        })
        .collect()
}

/// Writes the list atomically (temp file + rename): a crash mid-write must not
/// leave half a JSON that `load` would silently drop.
pub fn save(path: &std::path::Path, todos: &[TodoItem]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {e}"))?;
    }
    let body = serde_json::to_string_pretty(todos).map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("写入失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(todos: serde_json::Value) -> serde_json::Value {
        json!({ "todos": todos })
    }

    #[test]
    fn replaces_a_valid_list_and_summarizes() {
        let mut current = Vec::new();
        let out = replace_list(
            &mut current,
            &input(json!([
                {"content": "读代码", "status": "completed", "active_form": "读代码中"},
                {"content": "修 bug", "status": "in_progress"},
                {"content": "跑测试", "status": "pending"}
            ])),
        )
        .unwrap();
        assert_eq!(current.len(), 3);
        assert_eq!(
            current[1].active_form, "修 bug",
            "active_form falls back to content"
        );
        assert!(out.contains("1/3"), "{}", out);
        assert!(out.contains("当前:修 bug"), "{}", out);
        assert_eq!(render(&current).len(), 3);
    }

    #[test]
    fn rejects_empty_content_bad_status_and_double_in_progress() {
        let mut current = Vec::new();
        assert!(replace_list(
            &mut current,
            &input(json!([{"content": " ", "status": "pending"}]))
        )
        .unwrap_err()
        .contains("content"));
        assert!(replace_list(
            &mut current,
            &input(json!([{"content": "a", "status": "doing"}]))
        )
        .unwrap_err()
        .contains("status"));
        assert!(replace_list(
            &mut current,
            &input(json!([
                {"content": "a", "status": "in_progress"},
                {"content": "b", "status": "in_progress"}
            ]))
        )
        .unwrap_err()
        .contains("in_progress"));
        assert!(
            current.is_empty(),
            "a rejected input must not touch the list"
        );
    }

    fn item(content: &str, status: &str) -> TodoItem {
        TodoItem {
            content: content.into(),
            status: status.into(),
            active_form: content.into(),
        }
    }

    #[test]
    fn a_saved_list_comes_back_unchanged() {
        let dir = std::env::temp_dir().join(format!("bnote-todo-{}", std::process::id()));
        let path = dir.join("list.json");
        let todos = vec![item("读代码", "completed"), item("修 bug", "in_progress")];
        save(&path, &todos).expect("save");
        assert_eq!(load(&path), todos);
        assert!(
            !dir.join("list.json.tmp").exists(),
            "temp file is renamed away"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_or_broken_file_starts_empty() {
        let dir = std::env::temp_dir().join(format!("bnote-todo-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let missing = dir.join("none.json");
        assert!(load(&missing).is_empty());
        let broken = dir.join("broken.json");
        std::fs::write(&broken, "not json").expect("write");
        assert!(load(&broken).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_loaded_list_drops_items_the_writer_would_reject() {
        let dir = std::env::temp_dir().join(format!("bnote-todo-edit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("list.json");
        std::fs::write(
            &path,
            r#"[
              {"content":"ok","status":"pending"},
              {"content":"","status":"pending"},
              {"content":"bad status","status":"done"},
              {"content":"first active","status":"in_progress"},
              {"content":"second active","status":"in_progress"}
            ]"#,
        )
        .expect("write");
        let loaded = load(&path);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].content, "ok");
        assert_eq!(loaded[1].content, "first active");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_read_back_text_shows_every_state() {
        assert_eq!(text(&[]), "(清单为空)");
        let todos = vec![
            item("读代码", "completed"),
            item("修 bug", "in_progress"),
            item("跑测试", "pending"),
        ];
        let out = text(&todos);
        assert!(out.starts_with("清单:1/3 完成"), "{out}");
        assert!(out.contains("- [x] 读代码"), "{out}");
        assert!(out.contains("- [>] 修 bug  (进行中)"), "{out}");
        assert!(out.contains("- [ ] 跑测试"), "{out}");
    }

    #[test]
    fn clearing_the_list_is_expressed_by_an_empty_array() {
        let mut current = vec![TodoItem {
            content: "a".into(),
            status: "pending".into(),
            active_form: "a".into(),
        }];
        let out = replace_list(&mut current, &input(json!([]))).unwrap();
        assert!(current.is_empty());
        assert!(out.contains("清空"), "{}", out);
        assert!(
            replace_list(&mut current, &json!({})).is_err(),
            "missing todos key"
        );
    }
}
