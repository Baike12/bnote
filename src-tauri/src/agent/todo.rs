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
