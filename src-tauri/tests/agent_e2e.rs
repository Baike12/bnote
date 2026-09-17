//! Agent E2E: MCP stdio roundtrip (offline) and a live provider turn
//! (`--ignored` test using credentials from ~/.claude/settings.json).

use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// MCP stdio roundtrip against a tiny python JSON-RPC server
// ---------------------------------------------------------------------------

const PY_SERVER: &str = r#"
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    method = req.get("method")
    resp = {"jsonrpc": "2.0", "id": req.get("id")}
    if method == "initialize":
        resp["result"] = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "py-test", "version": "0.0.1"}}
    elif method == "tools/list":
        resp["result"] = {"tools": [{
            "name": "echo",
            "description": "Echo back the input text",
            "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        }]}
    elif method == "tools/call":
        text = req["params"]["arguments"].get("text", "")
        resp["result"] = {"content": [{"type": "text", "text": "echo:" + text}]}
    else:
        resp["result"] = {}
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()
"#;

#[tokio::test]
async fn mcp_stdio_roundtrip() {
    let dir = std::env::temp_dir().join("bnote-mcp-test");
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("server.py");
    std::fs::write(&script, PY_SERVER).unwrap();

    let cfg = bnote_lib::agent::AgentConfig {
        mcp_servers: [("pytest".to_string(), serde_json::from_value(json!({
            "type": "stdio",
            "command": "python3",
            "args": [script.to_string_lossy().to_string()],
        })).unwrap())]
        .into_iter()
        .collect(),
        ..Default::default()
    };
    let manager = bnote_lib::agent::mcp::McpManager::connect_all(&cfg).await;
    assert!(manager.errors.is_empty(), "mcp errors: {:?}", manager.errors);
    assert_eq!(manager.tools.len(), 1);
    assert_eq!(manager.tools[0].name, "mcp__pytest__echo");

    let out = manager
        .call("pytest", "echo", &json!({"text": "hello bnote"}))
        .await
        .expect("call echo");
    assert_eq!(out, "echo:hello bnote");
}

// ---------------------------------------------------------------------------
// Live provider turn (needs network + credentials; run with `cargo test --ignored`)
// ---------------------------------------------------------------------------

fn claude_creds() -> Option<(String, String)> {
    let home = std::env::var("HOME").ok()?;
    let raw = std::fs::read_to_string(format!("{}/.claude/settings.json", home)).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let token = v["env"]["ANTHROPIC_AUTH_TOKEN"].as_str()?.to_string();
    let base = v["env"]["ANTHROPIC_BASE_URL"].as_str().unwrap_or("").to_string();
    Some((token, base))
}

#[tokio::test]
#[ignore]
async fn live_provider_turn_with_tool() {
    let Some((token, base)) = claude_creds() else {
        panic!("no ~/.claude/settings.json credentials");
    };
    let provider = bnote_lib::agent::Provider::new("anthropic", &base, &token, "claude-sonnet-4-5", 2048);

    let tools = vec![bnote_lib::agent::types::ToolDef {
        name: "read_file".into(),
        description: "Read a file; returns its text".into(),
        input_schema: json!({
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"]
        }),
        mcp_server: None,
    }];

    // The model should call read_file on the poem, then report its content.
    let file = std::env::temp_dir().join("bnote-e2e-note.md");
    std::fs::write(&file, "风急天高猿啸哀\n").unwrap();

    let events: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let items = vec![bnote_lib::agent::types::ChatItem::user_text(&format!(
        "用 read_file 工具读取文件 {} 的内容,然后原样引用其中的那句诗。",
        file.to_string_lossy()
    ))];
    // First turn: expect a tool call.
    let turn = provider
        .stream_turn(
            "You must use tools to answer. Always call read_file first.",
            &items,
            &tools,
            &|e| {
                events
                    .lock()
                    .unwrap()
                    .push(format!("{:?}", e));
            },
        )
        .await
        .expect("stream turn 1");
    assert!(!turn.tool_calls.is_empty(), "expected a tool call, got: {}", turn.text);
    let (id, name, input) = match &turn.tool_calls[0] {
        bnote_lib::agent::types::Content::ToolUse { id, name, input } => {
            (id.clone(), name.clone(), input.clone())
        }
        other => panic!("unexpected content: {:?}", other),
    };
    assert_eq!(name, "read_file");

    // Execute the tool call ourselves and feed the result back.
    let path = input["path"].as_str().unwrap_or_default();
    assert!(path.contains("bnote-e2e-note"), "model should read the temp file, got path: {}", path);
    let content = std::fs::read_to_string(path).expect("tool read should succeed");
    let items2 = vec![
        items[0].clone(),
        bnote_lib::agent::types::ChatItem::Message {
            role: "assistant".into(),
            content: vec![bnote_lib::agent::types::Content::ToolUse {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            }],
        },
        bnote_lib::agent::types::ChatItem::Message {
            role: "user".into(),
            content: vec![bnote_lib::agent::types::Content::ToolResult {
                tool_use_id: id,
                content,
                is_error: false,
            }],
        },
    ];
    let final_turn = provider
        .stream_turn(
            "You must use tools to answer. Always call read_file first.",
            &items2,
            &tools,
            &|_| {},
        )
        .await
        .expect("stream turn 2");
    assert!(
        final_turn.tool_calls.is_empty(),
        "final turn should be plain text, got another tool round: {:?}",
        final_turn.tool_calls
    );
    assert!(
        final_turn.text.contains("风急天高"),
        "final answer should quote the poem, got: {}",
        final_turn.text
    );
}
