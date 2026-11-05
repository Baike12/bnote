//! The v2 task list (CC's TaskCreate/TaskUpdate/TaskList/TaskGet), separate
//! from the todo checklist: tasks carry ids, dependencies (`blocks` /
//! `blocked_by`) and an owner, and the model edits them one at a time instead
//! of replacing the whole list.
//!
//! Validation is strict for the same reason the todo list is: a malformed
//! update must leave the previous state untouched.

use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TaskItem {
    pub id: String,
    pub subject: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub active_form: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default)]
    pub blocks: Vec<String>,
    #[serde(default)]
    pub blocked_by: Vec<String>,
}

pub const STATUSES: &[&str] = &["pending", "in_progress", "completed"];

#[derive(Debug, Default, Clone)]
pub struct TaskList {
    next_id: u64,
    items: Vec<TaskItem>,
    /// `<agent home>/tasks/<task list id>` when the list is persisted. Claude
    /// Code writes one JSON file per task plus a high-water mark; the session
    /// that owns the list is the only writer (its `tasks` mutex serializes
    /// mutations), so no cross-process lock file is needed.
    dir: Option<PathBuf>,
}

impl TaskList {
    pub fn new() -> TaskList {
        TaskList::default()
    }

    /// Opens (or creates on first write) the list stored under `dir`.
    pub fn load(dir: PathBuf) -> TaskList {
        let mut items: Vec<TaskItem> = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Ok(raw) = std::fs::read_to_string(&path) else {
                    continue;
                };
                if let Ok(item) = serde_json::from_str::<TaskItem>(&raw) {
                    items.push(item);
                }
            }
        }
        items.sort_by_key(|t| t.id.parse::<u64>().unwrap_or(0));
        let next_id = items
            .iter()
            .filter_map(|t| t.id.parse::<u64>().ok())
            .max()
            .unwrap_or(0);
        TaskList {
            next_id,
            items,
            dir: Some(dir),
        }
    }

    fn persist(&self) {
        let Some(dir) = &self.dir else { return };
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("[bnote] task dir: {e}");
            return;
        }
        for item in &self.items {
            let Ok(json) = serde_json::to_string_pretty(item) else {
                continue;
            };
            // Write to a sibling temp file and rename: a crash mid-write must
            // not leave a half task that the loader then reports as corrupt.
            let path = dir.join(format!("{}.json", item.id));
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_err() {
                continue;
            }
            let _ = std::fs::rename(&tmp, &path);
        }
        let _ = std::fs::write(dir.join(".highwatermark"), self.next_id.to_string());
    }

    pub fn items(&self) -> &[TaskItem] {
        &self.items
    }

    pub fn create(&mut self, input: &Value) -> Result<String, String> {
        let subject = required_str(input, "subject")?;
        let description = input["description"].as_str().unwrap_or_default().to_string();
        if description.trim().is_empty() {
            return Err("description 不能为空".into());
        }
        let active_form = input["active_form"]
            .as_str()
            .map(|s| s.to_string())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| subject.clone());
        self.next_id += 1;
        let id = self.next_id.to_string();
        self.items.push(TaskItem {
            id: id.clone(),
            subject: subject.clone(),
            description,
            active_form,
            status: "pending".into(),
            owner: None,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
        });
        self.persist();
        Ok(format!("Task #{} created successfully: {}", id, subject))
    }

    pub fn update(&mut self, input: &Value) -> Result<String, String> {
        let id = required_str(input, "id")?;
        let Some(index) = self.items.iter().position(|t| t.id == id) else {
            return Err(format!("unknown task id: {}", id));
        };
        if let Some(status) = input.get("status").and_then(|v| v.as_str()) {
            if !STATUSES.contains(&status) {
                return Err(format!(
                    "status 必须是 {} 之一",
                    STATUSES.join(" / ")
                ));
            }
        }
        let blocks = string_list(input.get("add_blocks"))
            .or_else(|| string_list(input.get("blocks")));
        let blocked_by = string_list(input.get("add_blocked_by"))
            .or_else(|| string_list(input.get("blocked_by")));
        // All validation happens before the first mutation.
        if let Some(ids) = &blocks {
            for other in ids {
                if !self.items.iter().any(|t| &t.id == other) {
                    return Err(format!("unknown task id in add_blocks: {}", other));
                }
            }
        }
        if let Some(ids) = &blocked_by {
            for other in ids {
                if !self.items.iter().any(|t| &t.id == other) {
                    return Err(format!("unknown task id in add_blocked_by: {}", other));
                }
            }
        }
        {
            let item = &mut self.items[index];
            if let Some(status) = input.get("status").and_then(|v| v.as_str()) {
                item.status = status.to_string();
            }
            if let Some(subject) = input.get("subject").and_then(|v| v.as_str()) {
                if !subject.trim().is_empty() {
                    item.subject = subject.to_string();
                }
            }
            if let Some(description) = input.get("description").and_then(|v| v.as_str()) {
                item.description = description.to_string();
            }
            if let Some(active_form) = input.get("active_form").and_then(|v| v.as_str()) {
                if !active_form.trim().is_empty() {
                    item.active_form = active_form.to_string();
                }
            }
            if let Some(owner) = input.get("owner").and_then(|v| v.as_str()) {
                item.owner = if owner.trim().is_empty() {
                    None
                } else {
                    Some(owner.to_string())
                };
            }
            if let Some(ids) = &blocks {
                for other in ids {
                    if !item.blocks.contains(other) {
                        item.blocks.push(other.clone());
                    }
                }
            }
            if let Some(ids) = &blocked_by {
                for other in ids {
                    if !item.blocked_by.contains(other) {
                        item.blocked_by.push(other.clone());
                    }
                }
            }
        }
        // Keep both sides of every edge in sync in the same write.
        if let Some(ids) = blocks {
            for other in ids {
                if let Some(other_item) = self.items.iter_mut().find(|t| t.id == other) {
                    if !other_item.blocked_by.contains(&id) {
                        other_item.blocked_by.push(id.clone());
                    }
                }
            }
        }
        if let Some(ids) = blocked_by {
            for other in ids {
                if let Some(other_item) = self.items.iter_mut().find(|t| t.id == other) {
                    if !other_item.blocks.contains(&id) {
                        other_item.blocks.push(id.clone());
                    }
                }
            }
        }
        self.persist();
        Ok(format!("Task #{} updated successfully", id))
    }

    pub fn list(&self) -> String {
        if self.items.is_empty() {
            return "(the task list is empty)".into();
        }
        let mut out = String::new();
        for t in &self.items {
            out.push_str(&format!(
                "#{} [{}] {}{}\n",
                t.id,
                t.status,
                t.subject,
                if t.blocked_by.is_empty() {
                    String::new()
                } else {
                    format!(" (blocked by: {})", t.blocked_by.join(", "))
                }
            ));
        }
        out.trim_end().to_string()
    }

    pub fn get(&self, id: &str) -> Result<String, String> {
        let Some(task) = self.items.iter().find(|t| t.id == id) else {
            return Err(format!("unknown task id: {}", id));
        };
        Ok(serde_json::to_string_pretty(task).unwrap_or_else(|_| format!("{:?}", task)))
    }

    /// The event payload for the panel.
    pub fn render(&self) -> Vec<TaskItem> {
        self.items.clone()
    }
}

fn required_str(input: &Value, key: &str) -> Result<String, String> {
    let value = input[key].as_str().unwrap_or_default().trim().to_string();
    if value.is_empty() {
        return Err(format!("{} 不能为空", key));
    }
    Ok(value)
}

fn string_list(value: Option<&Value>) -> Option<Vec<String>> {
    let list = value?.as_array()?;
    Some(
        list.iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
    )
}

/// JSON schema shared by the task tools.
pub fn create_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "subject": {"type": "string", "description": "A brief title for the task"},
            "description": {"type": "string", "description": "What needs to be done"},
            "active_form": {"type": "string", "description": "Present continuous form shown while the task is in progress"}
        },
        "required": ["subject", "description"]
    })
}

pub fn update_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "status": {"enum": STATUSES},
            "subject": {"type": "string"},
            "description": {"type": "string"},
            "active_form": {"type": "string"},
            "owner": {"type": "string"},
            "add_blocks": {"type": "array", "items": {"type": "string"}},
            "add_blocked_by": {"type": "array", "items": {"type": "string"}}
        },
        "required": ["id"]
    })
}

pub fn get_schema() -> Value {
    json!({
        "type": "object",
        "properties": {"id": {"type": "string"}},
        "required": ["id"]
    })
}

pub fn list_schema() -> Value {
    json!({"type": "object", "properties": {}})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "bnote-tasks-{}-{}-{}",
            tag,
            std::process::id(),
            unique
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn tasks_persist_and_reload_with_a_continuing_id() {
        let dir = temp_dir("persist");
        {
            let mut list = TaskList::load(dir.clone());
            list.create(&json!({"subject": "A", "description": "first"}))
                .unwrap();
            list.update(&json!({"id": "1", "status": "in_progress"}))
                .unwrap();
        }
        let mut list = TaskList::load(dir.clone());
        assert_eq!(list.items().len(), 1);
        assert_eq!(list.items()[0].status, "in_progress");
        list.create(&json!({"subject": "B", "description": "second"}))
            .unwrap();
        assert_eq!(list.items()[1].id, "2", "ids continue after a reload");
        assert!(dir.join(".highwatermark").is_file());
        assert!(dir.join("2.json").is_file());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_then_update_keeps_both_sides_of_a_dependency() {
        let mut list = TaskList::new();
        let a = list
            .create(&json!({"subject": "A", "description": "first"}))
            .unwrap();
        assert!(a.contains("Task #1"));
        list.create(&json!({"subject": "B", "description": "second"}))
            .unwrap();
        list.update(&json!({"id": "1", "add_blocks": ["2"]}))
            .unwrap();
        assert_eq!(list.items()[0].blocks, vec!["2".to_string()]);
        assert_eq!(list.items()[1].blocked_by, vec!["1".to_string()]);
        list.update(&json!({"id": "2", "status": "in_progress"}))
            .unwrap();
        assert_eq!(list.items()[1].status, "in_progress");
        assert!(list.list().contains("blocked by: 1"));
    }

    #[test]
    fn an_invalid_update_leaves_the_list_untouched() {
        let mut list = TaskList::new();
        list.create(&json!({"subject": "A", "description": "first"}))
            .unwrap();
        let before = list.items().to_vec();
        assert!(list.update(&json!({"id": "1", "status": "done"})).is_err());
        assert!(list.update(&json!({"id": "9", "status": "pending"})).is_err());
        assert!(list.update(&json!({"id": "1", "add_blocks": ["9"]})).is_err());
        assert_eq!(list.items(), before.as_slice());
    }

    #[test]
    fn create_requires_a_description() {
        let mut list = TaskList::new();
        assert!(list
            .create(&json!({"subject": "A", "description": "   "}))
            .is_err());
        assert!(list.items().is_empty());
    }

    #[test]
    fn get_reports_an_unknown_id_instead_of_panicking() {
        let list = TaskList::new();
        assert!(list.get("42").is_err());
    }
}
