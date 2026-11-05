//! The tool boundary Claude Code enforces with zod: every tool input is
//! validated against the schema that was sent to the model before the tool
//! body runs.
//!
//! Without it a malformed `input_json_delta` (or a model inventing a field)
//! used to reach the tool as `{}`: `read_file` then silently read nothing and
//! the model got an empty success. A validation failure must instead come back
//! as an `is_error` tool result naming the offending path, which is what this
//! validator produces.
//!
//! Scope: the subset the built-in schemas use — `type` (string or list),
//! `properties`, `required`, `items`, `enum`, `additionalProperties` is not
//! enforced. Anything outside the subset is treated as valid, so a future
//! schema keyword can never make every call fail.

use serde_json::Value;

/// Validates `input` against `schema`; `Err` carries a path-qualified message.
pub fn validate(schema: &Value, input: &Value) -> Result<(), String> {
    validate_at(schema, input, "")
}

fn validate_at(schema: &Value, input: &Value, path: &str) -> Result<(), String> {
    let Some(obj) = schema.as_object() else {
        return Ok(());
    };
    if let Some(types) = obj.get("type") {
        let allowed: Vec<&str> = match types {
            Value::String(s) => vec![s.as_str()],
            Value::Array(list) => list.iter().filter_map(|v| v.as_str()).collect(),
            _ => Vec::new(),
        };
        if !allowed.is_empty() && !allowed.iter().any(|t| matches_type(t, input)) {
            return Err(format!(
                "{}: expected {}, got {}",
                field(path),
                allowed.join(" or "),
                describe(input)
            ));
        }
    }
    if let Some(values) = obj.get("enum").and_then(|v| v.as_array()) {
        if !values.iter().any(|v| v == input) {
            let list = values
                .iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!("{}: must be one of {}", field(path), list));
        }
    }
    match input {
        Value::Object(map) => {
            if let Some(required) = obj.get("required").and_then(|v| v.as_array()) {
                for name in required.iter().filter_map(|v| v.as_str()) {
                    if !map.contains_key(name) {
                        return Err(format!("{}missing required field: {}", prefix(path), name));
                    }
                }
            }
            if let Some(props) = obj.get("properties").and_then(|v| v.as_object()) {
                for (name, sub) in props {
                    if let Some(value) = map.get(name) {
                        let child_path = if path.is_empty() {
                            name.clone()
                        } else {
                            format!("{}.{}", path, name)
                        };
                        validate_at(sub, value, &child_path)?;
                    }
                }
            }
        }
        Value::Array(items) => {
            if let Some(sub) = obj.get("items") {
                for (i, item) in items.iter().enumerate() {
                    let child_path = if path.is_empty() {
                        format!("[{}]", i)
                    } else {
                        format!("{}[{}]", path, i)
                    };
                    validate_at(sub, item, &child_path)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn matches_type(expected: &str, value: &Value) -> bool {
    match expected {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.is_i64() || value.is_u64(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn describe(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn field(path: &str) -> &str {
    if path.is_empty() {
        "input"
    } else {
        path
    }
}

fn prefix(path: &str) -> String {
    if path.is_empty() {
        String::new()
    } else {
        format!("{}: ", path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bash_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "timeout_secs": {"type": "integer"},
                "run_in_background": {"type": "boolean"}
            },
            "required": ["command"]
        })
    }

    #[test]
    fn a_valid_input_passes() {
        assert!(validate(
            &bash_schema(),
            &json!({"command": "ls", "timeout_secs": 5, "run_in_background": false})
        )
        .is_ok());
    }

    #[test]
    fn a_missing_required_field_names_it() {
        let err = validate(&bash_schema(), &json!({})).unwrap_err();
        assert!(err.contains("command"), "{}", err);
        assert!(err.contains("missing required field"), "{}", err);
    }

    #[test]
    fn a_wrong_type_names_the_path_and_both_types() {
        let err = validate(&bash_schema(), &json!({"command": 42})).unwrap_err();
        assert!(err.contains("command"), "{}", err);
        assert!(err.contains("expected string"), "{}", err);
        assert!(err.contains("number"), "{}", err);
    }

    #[test]
    fn nested_arrays_and_objects_are_checked() {
        let schema = json!({
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"content": {"type": "string"}},
                        "required": ["content"]
                    }
                }
            }
        });
        let err = validate(
            &schema,
            &json!({"todos": [{"content": "a"}, {"status": "x"}]}),
        )
        .unwrap_err();
        assert!(err.contains("todos[1]"), "{}", err);
    }

    #[test]
    fn enum_membership_is_enforced() {
        let schema =
            json!({"type": "object", "properties": {"status": {"enum": ["pending", "completed"]}}});
        assert!(validate(&schema, &json!({"status": "pending"})).is_ok());
        assert!(validate(&schema, &json!({"status": "done"})).is_err());
    }

    #[test]
    fn an_unknown_keyword_never_fails_the_call() {
        let schema = json!({"type": "object", "oneOf": [{"type": "string"}], "properties": {}});
        assert!(validate(&schema, &json!({"anything": 1})).is_ok());
    }
}
