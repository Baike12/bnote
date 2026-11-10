//! The provider → model → thinking-level catalog.
//!
//! `agent.json` used to describe exactly one model (protocol, base URL, key,
//! context window). A user now configures several suppliers, each with several
//! models, and each model declares its own thinking levels — so the catalog is
//! one list of providers and every session/report resolves a
//! [`ModelSelection`] through it.
//!
//! A thinking level is a name plus an RFC 7396 merge patch applied to the
//! request body (`{"thinking": {"type": "enabled", "budget_tokens": 8192}}`).
//! The patches are hand-written and editable in the settings page; a new model
//! starts with the mapping that used to be guessed from the model name and the
//! gateway host ([`default_levels`]). Keeping the mapping in data instead of
//! code means a gateway whose reasoning field differs needs no Rust change.
//!
//! This module is pure: no IO, no session state. `AgentConfig` owns the file
//! and calls [`normalize`] / [`resolve`]; `Provider` turns a [`ResolvedModel`]
//! into requests.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// The level every model gets when it does not declare its own list, lowest
/// first. Labels are the frontend's business; the ids are what the wire and
/// the records carry.
pub const LEVEL_OFF: &str = "off";

fn default_context_window() -> u64 {
    128_000
}

fn default_max_tokens() -> u32 {
    8_192
}

/// One thinking level: its id and the merge patch it applies to the request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "snake_case")]
pub struct ThinkingLevel {
    pub id: String,
    /// An RFC 7396 object; `null` values delete the field. A malformed value
    /// (anything but an object) normalizes to `{}` — an empty patch is the
    /// honest reading of "no mapping".
    pub patch: Value,
}

impl Default for ThinkingLevel {
    fn default() -> Self {
        ThinkingLevel {
            id: String::new(),
            patch: json!({}),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "snake_case")]
pub struct ModelEntry {
    /// The wire model id (`deepseek-chat`, `claude-sonnet-5`) and the stable
    /// key a selection refers to.
    pub id: String,
    /// Display name; falls back to `id`.
    pub name: String,
    /// Context window in tokens: the occupancy display and auto-compact.
    pub context_window: u64,
    /// Output ceiling of one reply (the request's `max_tokens`).
    pub max_tokens: u32,
    /// Accepts images (the panel shows a 「视觉」 tag).
    pub vision: bool,
    /// Ordered lowest → highest.
    pub thinking: Vec<ThinkingLevel>,
    /// The level a new session picks; falls back to the highest.
    pub default_thinking: String,
}

impl Default for ModelEntry {
    fn default() -> Self {
        ModelEntry {
            id: String::new(),
            name: String::new(),
            context_window: default_context_window(),
            max_tokens: default_max_tokens(),
            vision: false,
            thinking: Vec::new(),
            default_thinking: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "snake_case")]
pub struct ProviderEntry {
    pub id: String,
    pub name: String,
    /// `anthropic` | `openai` (the two protocols the provider module speaks).
    pub protocol: String,
    /// Empty = the protocol's official endpoint.
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<ModelEntry>,
}

impl Default for ProviderEntry {
    fn default() -> Self {
        ProviderEntry {
            id: String::new(),
            name: String::new(),
            protocol: "anthropic".into(),
            base_url: String::new(),
            api_key: String::new(),
            models: Vec::new(),
        }
    }
}

/// What a session (or a subagent) runs on. Provider and model are ids, not
/// copies: the catalog stays the single source of keys and URLs.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "snake_case")]
pub struct ModelSelection {
    pub provider_id: String,
    pub model_id: String,
    /// A level id; empty normalizes to the model's default level.
    pub thinking: String,
}

/// Which models subagents run on. `default` = the global choice, an entry in
/// `by_definition` overrides it per agent definition. Absent = inherit the
/// parent session (Claude Code's default).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "snake_case")]
pub struct SubagentModels {
    pub default: Option<ModelSelection>,
    pub by_definition: BTreeMap<String, ModelSelection>,
}

/// A selection resolved against the catalog: everything a request needs.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedModel {
    pub provider_id: String,
    pub provider_name: String,
    pub model_id: String,
    pub model_name: String,
    pub protocol: String,
    pub base_url: String,
    pub api_key: String,
    /// The wire model id (the request's `model`).
    pub model: String,
    pub max_tokens: u32,
    pub context_window: u64,
    pub vision: bool,
    pub thinking_level: String,
    /// The patch of `thinking_level` (an object).
    pub patch: Value,
    /// The patch of the model's `off` level, `{}` when it declares none. A
    /// request with the reasoning channel switched off applies this (the
    /// gateway-specific "disabled" field).
    pub off_patch: Value,
}

impl ResolvedModel {
    /// The catalog selection this resolution came from (what a session stores
    /// and what a restore resolves again).
    pub fn selection(&self) -> ModelSelection {
        ModelSelection {
            provider_id: self.provider_id.clone(),
            model_id: self.model_id.clone(),
            thinking: self.thinking_level.clone(),
        }
    }

    /// The snapshot the panel and the session record carry.
    pub fn snapshot(&self) -> SessionModelConfig {
        SessionModelConfig {
            provider: self.protocol.clone(),
            model: self.model.clone(),
            base_url: self.base_url.clone(),
            max_tokens: self.max_tokens,
            context_window: self.context_window,
            thinking: self.thinking_level.clone(),
            provider_id: self.provider_id.clone(),
            model_id: self.model_id.clone(),
        }
    }
}

/// The session-level model snapshot (the first line of the session record and
/// the `model` field of `agent_start_session`).
///
/// `provider`/`model`/`base_url` keep their pre-catalog meaning so records
/// written by an older build still restore; `thinking`/`provider_id`/
/// `model_id` are what a restore resolves against the catalog.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionModelConfig {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub max_tokens: u32,
    pub context_window: u64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub thinking: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub provider_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub model_id: String,
}

/// The seeded thinking levels of a model: the mapping this app used to guess
/// from the protocol, the model name and the gateway host.
pub fn default_levels(
    protocol: &str,
    model: &str,
    base_url: &str,
    max_tokens: u32,
) -> Vec<ThinkingLevel> {
    let model_l = model.to_ascii_lowercase();
    let base_l = base_url.to_ascii_lowercase();
    let level = |id: &str, patch: Value| ThinkingLevel {
        id: id.to_string(),
        patch,
    };
    // The old anthropic budget: half the reply ceiling, clamped. The ladder
    // keeps `high` exactly there so a migrated config sends what it sent.
    //
    // Every budget stays below `max_tokens`: Anthropic rejects a request whose
    // `thinking.budget_tokens` is not smaller than its `max_tokens` (400), and
    // the request body carries the model's `max_tokens` verbatim.
    let ceiling = u64::from(max_tokens.saturating_sub(1).max(1));
    let budget = |desired: u64| desired.max(1024).min(ceiling).max(1);
    let high = budget(((max_tokens.max(1024) as f64 / 2.0) as u64).clamp(1024, 16384));
    if protocol == "anthropic" {
        return vec![
            // Anthropic has no "disabled" value worth sending: omitting the
            // field is the off switch, so the patch deletes it.
            level(LEVEL_OFF, json!({"thinking": null})),
            level(
                "low",
                json!({"thinking": {"type": "enabled", "budget_tokens": budget(high / 4)}}),
            ),
            level(
                "medium",
                json!({"thinking": {"type": "enabled", "budget_tokens": budget(high / 2)}}),
            ),
            level(
                "high",
                json!({"thinking": {"type": "enabled", "budget_tokens": high}}),
            ),
            level(
                "max",
                json!({"thinking": {"type": "enabled", "budget_tokens": budget(high * 2)}}),
            ),
        ];
    }
    // OpenAI-compatible surfaces disagree on the field name; identify the
    // gateway the way the provider used to.
    if model_l.contains("glm") || base_l.contains("bigmodel") || base_l.contains("zhipu") {
        return bool_levels("thinking", true);
    }
    if model_l.contains("qwen") || base_l.contains("dashscope") {
        return bool_levels("enable_thinking", false);
    }
    if base_l.contains("ollama") || model_l.starts_with("ollama/") {
        return bool_levels("think", false);
    }
    if model_l.contains("deepseek") {
        return bool_levels("thinking", true);
    }
    // A plain OpenAI surface takes `reasoning_effort`; every other compatible
    // gateway gets no field at all until the user maps one (the model's own
    // default governs).
    let effort = |id: &str, value: &str| level(id, json!({"reasoning_effort": value}));
    if model_l.starts_with("gpt")
        || model_l.starts_with("o1")
        || model_l.starts_with("o3")
        || model_l.starts_with("o4")
    {
        return vec![
            level(LEVEL_OFF, json!({})),
            effort("low", "low"),
            effort("medium", "medium"),
            effort("high", "high"),
            effort("max", "high"),
        ];
    }
    vec![
        level(LEVEL_OFF, json!({})),
        level("low", json!({})),
        level("medium", json!({})),
        level("high", json!({})),
        level("max", json!({})),
    ]
}

/// Levels whose wire field is one boolean/enum `field` (the GLM / Qwen /
/// Ollama / DeepSeek shapes).
fn bool_levels(field: &str, enabled_is_object: bool) -> Vec<ThinkingLevel> {
    let enabled = if enabled_is_object {
        json!({ "type": "enabled" })
    } else {
        json!(true)
    };
    let disabled = if enabled_is_object {
        json!({ "type": "disabled" })
    } else {
        json!(false)
    };
    let build = |id: &str, value: Value| {
        let mut map = serde_json::Map::new();
        map.insert(field.to_string(), value);
        ThinkingLevel {
            id: id.to_string(),
            patch: Value::Object(map),
        }
    };
    let mut out = vec![build(LEVEL_OFF, disabled)];
    for id in ["low", "medium", "high", "max"] {
        out.push(build(id, enabled.clone()));
    }
    out
}

/// RFC 7396 merge patch: objects merge key by key, `null` deletes a key, every
/// other value replaces.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    let Some(patch_obj) = patch.as_object() else {
        // RFC 7396 replaces the target with a non-object patch. A level's own
        // patch is always an object (`normalize` guarantees it), so this arm
        // only matters for a scalar nested inside one.
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = json!({});
    }
    let Some(target_obj) = target.as_object_mut() else {
        return;
    };
    for (key, value) in patch_obj {
        if value.is_null() {
            target_obj.remove(key);
            continue;
        }
        let slot = target_obj.entry(key.clone()).or_insert(Value::Null);
        merge_patch(slot, value);
    }
}

/// The patch of `level`, falling back to the model's default level and then to
/// the highest one; `{}` when the model declares no levels at all.
fn patch_for(model: &ModelEntry, level: &str) -> (String, Value) {
    let pick = |id: &str| model.thinking.iter().find(|l| l.id == id);
    let chosen = pick(level)
        .or_else(|| pick(model.default_thinking.trim()))
        .or_else(|| model.thinking.last());
    match chosen {
        Some(l) => (l.id.clone(), l.patch.clone()),
        None => (level.to_string(), json!({})),
    }
}

fn off_patch(model: &ModelEntry) -> Value {
    model
        .thinking
        .iter()
        .find(|l| l.id == LEVEL_OFF)
        .map(|l| l.patch.clone())
        .unwrap_or_else(|| json!({}))
}

/// Resolves a selection against the catalog. Every failure names the id the
/// user configured, because that is what the settings page has to correct.
pub fn resolve(
    providers: &[ProviderEntry],
    selection: &ModelSelection,
) -> Result<ResolvedModel, String> {
    let provider = providers
        .iter()
        .find(|p| p.id == selection.provider_id)
        .ok_or_else(|| format!("MODEL_NOT_FOUND: 供应商 {} 不存在", selection.provider_id))?;
    let model = provider
        .models
        .iter()
        .find(|m| m.id == selection.model_id)
        .ok_or_else(|| {
            format!(
                "MODEL_NOT_FOUND: 供应商 {} 下没有模型 {}",
                provider.id, selection.model_id
            )
        })?;
    let (thinking_level, patch) = patch_for(model, selection.thinking.trim());
    Ok(ResolvedModel {
        provider_id: provider.id.clone(),
        provider_name: provider.name.clone(),
        model_id: model.id.clone(),
        model_name: if model.name.trim().is_empty() {
            model.id.clone()
        } else {
            model.name.clone()
        },
        protocol: provider.protocol.clone(),
        base_url: provider.base_url.clone(),
        api_key: provider.api_key.clone(),
        model: model.id.clone(),
        max_tokens: model.max_tokens,
        context_window: model.context_window,
        vision: model.vision,
        thinking_level,
        off_patch: off_patch(model),
        patch,
    })
}

/// The selection a fresh session picks when the caller gave none.
pub fn default_selection(providers: &[ProviderEntry]) -> Option<ModelSelection> {
    let provider = providers.first()?;
    let model = provider.models.first()?;
    Some(ModelSelection {
        provider_id: provider.id.clone(),
        model_id: model.id.clone(),
        thinking: model.default_thinking.clone(),
    })
}

/// A selection that names `model_id`, preferring `preferred` (the parent
/// session's provider) and falling back to the first provider that lists it.
/// `None` = no provider knows the id, so it can only be a raw override.
pub fn selection_for_model(
    providers: &[ProviderEntry],
    preferred: &str,
    model_id: &str,
    thinking: &str,
) -> Option<ModelSelection> {
    let has_model = |provider: &ProviderEntry| provider.models.iter().any(|m| m.id == model_id);
    let provider = providers
        .iter()
        .find(|p| p.id == preferred && has_model(p))
        .or_else(|| providers.iter().find(|p| has_model(p)))?;
    Some(ModelSelection {
        provider_id: provider.id.clone(),
        model_id: model_id.to_string(),
        thinking: thinking.to_string(),
    })
}

/// Narrows a list of providers to one consistent catalog: unique non-empty
/// ids, valid protocols, a context window / output ceiling always set, at
/// least one thinking level per model and a default level inside that list.
pub fn normalize(providers: &mut Vec<ProviderEntry>, default: &mut Option<ModelSelection>) {
    // Provider ids are what a selection, a subagent override and a session
    // snapshot name; a duplicate makes every lookup (`resolve`, both pickers)
    // hit the first one, so the second provider can never be selected. The
    // settings page generates ids from a length that can repeat after a delete,
    // hence the dedupe here rather than only in the editor.
    let mut seen_providers: Vec<String> = Vec::new();
    for (index, provider) in providers.iter_mut().enumerate() {
        provider.id = provider.id.trim().to_string();
        if provider.id.is_empty() {
            provider.id = format!("provider-{}", index + 1);
        }
        if seen_providers.contains(&provider.id) {
            let base = provider.id.clone();
            let mut suffix = 2;
            while seen_providers.contains(&format!("{}-{}", base, suffix)) {
                suffix += 1;
            }
            provider.id = format!("{}-{}", base, suffix);
        }
        seen_providers.push(provider.id.clone());
        if provider.name.trim().is_empty() {
            provider.name = provider.id.clone();
        }
        if provider.protocol != "anthropic" && provider.protocol != "openai" {
            provider.protocol = "anthropic".into();
        }
        provider.base_url = provider.base_url.trim().to_string();
        let (protocol, base_url) = (provider.protocol.clone(), provider.base_url.clone());
        let mut seen: Vec<String> = Vec::new();
        for (model_index, model) in provider.models.iter_mut().enumerate() {
            model.id = model.id.trim().to_string();
            if model.id.is_empty() {
                model.id = format!("{}-model-{}", provider.id, model_index + 1);
            }
            if seen.contains(&model.id) {
                let mut suffix = 2;
                while seen.contains(&format!("{}-{}", model.id, suffix)) {
                    suffix += 1;
                }
                model.id = format!("{}-{}", model.id, suffix);
            }
            seen.push(model.id.clone());
            if model.name.trim().is_empty() {
                model.name = model.id.clone();
            }
            if model.context_window == 0 {
                model.context_window = default_context_window();
            }
            if model.max_tokens == 0 {
                model.max_tokens = default_max_tokens();
            }
            let seeded = default_levels(&protocol, &model.id, &base_url, model.max_tokens);
            model.thinking = normalize_levels(std::mem::take(&mut model.thinking), seeded);
            let ids: Vec<&str> = model.thinking.iter().map(|l| l.id.as_str()).collect();
            if !ids.contains(&model.default_thinking.trim()) {
                model.default_thinking = model
                    .thinking
                    .last()
                    .map(|l| l.id.clone())
                    .unwrap_or_default();
            }
        }
        // A provider without models cannot be selected; keep it configured
        // (the user is mid-edit) but never point a selection at it.
        if provider.models.is_empty() {
            provider.models.push(ModelEntry {
                id: format!("{}-model-1", provider.id),
                thinking: default_levels(
                    &provider.protocol,
                    "",
                    &provider.base_url,
                    default_max_tokens(),
                ),
                ..Default::default()
            });
            if let Some(model) = provider.models.first_mut() {
                model.name = model.id.clone();
                model.default_thinking = model
                    .thinking
                    .last()
                    .map(|l| l.id.clone())
                    .unwrap_or_default();
            }
        }
    }
    if providers.is_empty() {
        *default = None;
        return;
    }
    let valid = default
        .as_ref()
        .map(|selection| resolve(providers, selection).is_ok())
        .unwrap_or(false);
    if !valid {
        *default = default_selection(providers);
    }
}

/// Trims level ids, drops empties and duplicates, and seeds a model that has
/// none with the protocol default (`seeded`).
fn normalize_levels(
    mut levels: Vec<ThinkingLevel>,
    seeded: Vec<ThinkingLevel>,
) -> Vec<ThinkingLevel> {
    for level in levels.iter_mut() {
        level.id = level.id.trim().to_string();
        if !level.patch.is_object() {
            level.patch = json!({});
        }
    }
    levels.retain(|l| !l.id.is_empty());
    let mut seen: Vec<String> = Vec::new();
    levels.retain(|l| {
        if seen.contains(&l.id) {
            false
        } else {
            seen.push(l.id.clone());
            true
        }
    });
    if levels.is_empty() {
        return seeded;
    }
    levels
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_with(models: Vec<ModelEntry>) -> ProviderEntry {
        ProviderEntry {
            id: "p".into(),
            name: "P".into(),
            protocol: "openai".into(),
            base_url: "https://example.test/v1".into(),
            api_key: "k".into(),
            models,
        }
    }

    fn model(id: &str, levels: Vec<(&str, Value)>, default: &str) -> ModelEntry {
        ModelEntry {
            id: id.into(),
            name: id.into(),
            thinking: levels
                .into_iter()
                .map(|(id, patch)| ThinkingLevel {
                    id: id.into(),
                    patch,
                })
                .collect(),
            default_thinking: default.into(),
            ..Default::default()
        }
    }

    #[test]
    fn merge_patch_merges_objects_deletes_on_null_and_replaces_scalars() {
        let mut body = json!({
            "model": "m",
            "thinking": {"type": "enabled", "budget_tokens": 1024},
        });
        merge_patch(
            &mut body,
            &json!({"thinking": {"budget_tokens": 8192}, "reasoning_effort": "high"}),
        );
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 8192);
        assert_eq!(body["reasoning_effort"], "high");

        merge_patch(&mut body, &json!({"thinking": null, "model": null}));
        assert!(body.get("thinking").is_none());
        assert!(body.get("model").is_none());

        // A non-object patch replaces the value it lands on (RFC 7396).
        merge_patch(&mut body, &json!({"reasoning_effort": "low"}));
        assert_eq!(body["reasoning_effort"], "low");
        // A non-object target becomes an object first.
        let mut scalar = json!("x");
        merge_patch(&mut scalar, &json!({"a": 1}));
        assert_eq!(scalar, json!({"a": 1}));
    }

    #[test]
    fn resolve_walks_provider_and_model_and_keeps_the_requested_level() {
        let providers = vec![provider_with(vec![model(
            "m",
            vec![
                ("off", json!({"thinking": {"type": "disabled"}})),
                ("high", json!({"thinking": {"type": "enabled"}})),
            ],
            "high",
        )])];
        let resolved = resolve(
            &providers,
            &ModelSelection {
                provider_id: "p".into(),
                model_id: "m".into(),
                thinking: "high".into(),
            },
        )
        .unwrap();
        assert_eq!(resolved.model, "m");
        assert_eq!(resolved.thinking_level, "high");
        assert_eq!(resolved.patch["thinking"]["type"], "enabled");
        assert_eq!(resolved.off_patch["thinking"]["type"], "disabled");
    }

    #[test]
    fn an_unknown_or_empty_level_falls_back_to_the_default_then_the_highest() {
        let providers = vec![provider_with(vec![model(
            "m",
            vec![
                ("off", json!({})),
                ("medium", json!({"a": 1})),
                ("max", json!({"b": 2})),
            ],
            "medium",
        )])];
        let pick = |level: &str| {
            resolve(
                &providers,
                &ModelSelection {
                    provider_id: "p".into(),
                    model_id: "m".into(),
                    thinking: level.into(),
                },
            )
            .unwrap()
            .thinking_level
        };
        assert_eq!(pick(""), "medium");
        assert_eq!(pick("bogus"), "medium");

        // No default declared: normalize points it at the highest level.
        let mut providers = vec![provider_with(vec![model(
            "m",
            vec![("low", json!({})), ("high", json!({}))],
            "",
        )])];
        let mut default = None;
        normalize(&mut providers, &mut default);
        assert_eq!(providers[0].models[0].default_thinking, "high");
        let resolved = resolve(
            &providers,
            &ModelSelection {
                provider_id: "p".into(),
                model_id: "m".into(),
                thinking: "".into(),
            },
        )
        .unwrap();
        assert_eq!(resolved.thinking_level, "high");
    }

    #[test]
    fn a_missing_selection_reports_the_id_the_user_configured() {
        let providers = vec![provider_with(vec![model(
            "m",
            vec![("high", json!({}))],
            "high",
        )])];
        let err = resolve(
            &providers,
            &ModelSelection {
                provider_id: "nope".into(),
                model_id: "m".into(),
                thinking: "high".into(),
            },
        )
        .unwrap_err();
        assert!(err.contains("nope"), "{err}");
        let err = resolve(
            &providers,
            &ModelSelection {
                provider_id: "p".into(),
                model_id: "nope".into(),
                thinking: "high".into(),
            },
        )
        .unwrap_err();
        assert!(err.contains("nope"), "{err}");
    }

    /// Two providers with the same id make `resolve` and both pickers hit the
    /// first one, so the second can never be selected. The settings page derives
    /// ids from the list length, which repeats after a delete.
    #[test]
    fn normalize_makes_provider_ids_unique() {
        let mut providers = vec![
            ProviderEntry {
                id: "provider-2".into(),
                name: "".into(),
                protocol: "anthropic".into(),
                base_url: "".into(),
                api_key: "a".into(),
                models: vec![ModelEntry::default()],
            },
            ProviderEntry {
                id: "provider-2".into(),
                name: "".into(),
                protocol: "anthropic".into(),
                base_url: "".into(),
                api_key: "b".into(),
                models: vec![ModelEntry::default()],
            },
            ProviderEntry {
                id: "provider-2".into(),
                name: "".into(),
                protocol: "anthropic".into(),
                base_url: "".into(),
                api_key: "c".into(),
                models: vec![ModelEntry::default()],
            },
        ];
        let mut default = None;
        normalize(&mut providers, &mut default);
        let ids: Vec<&str> = providers.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["provider-2", "provider-2-2", "provider-2-3"]);
        // And selecting the third provider's model resolves to the third key.
        let third = providers[2].models[0].id.clone();
        let selection = ModelSelection {
            provider_id: "provider-2-3".into(),
            model_id: third,
            thinking: providers[2].models[0].default_thinking.clone(),
        };
        assert_eq!(resolve(&providers, &selection).unwrap().api_key, "c");
    }

    #[test]
    fn normalize_seeds_missing_fields_and_points_the_default_at_a_real_model() {
        let mut providers = vec![ProviderEntry {
            id: "  ".into(),
            name: "".into(),
            protocol: "bogus".into(),
            base_url: "https://example.test".into(),
            api_key: "k".into(),
            models: vec![ModelEntry::default()],
        }];
        let mut default = Some(ModelSelection {
            provider_id: "gone".into(),
            model_id: "gone".into(),
            thinking: "".into(),
        });
        normalize(&mut providers, &mut default);
        assert_eq!(providers[0].id, "provider-1");
        assert_eq!(providers[0].name, "provider-1");
        assert_eq!(providers[0].protocol, "anthropic");
        let model = &providers[0].models[0];
        assert_eq!(model.id, "provider-1-model-1");
        assert_eq!(model.context_window, 128_000);
        assert_eq!(model.max_tokens, 8_192);
        assert!(!model.thinking.is_empty());
        assert!(!model.default_thinking.is_empty());
        let default = default.unwrap();
        assert!(resolve(&providers, &default).is_ok());
    }

    #[test]
    fn anthropic_levels_scale_the_budget_and_off_deletes_the_field() {
        let levels = default_levels("anthropic", "claude-sonnet-5", "", 8192);
        let by_id = |id: &str| levels.iter().find(|l| l.id == id).unwrap().patch.clone();
        assert_eq!(by_id("high")["thinking"]["budget_tokens"], 4096);
        assert!(by_id("max")["thinking"]["budget_tokens"].as_u64().unwrap() > 4096);
        assert!(by_id(LEVEL_OFF)["thinking"].is_null());
    }

    /// Anthropic rejects a request whose `thinking.budget_tokens` is not smaller
    /// than `max_tokens`; the body carries the model's `max_tokens` verbatim, so
    /// every seeded level has to stay under it — the default model included.
    #[test]
    fn every_anthropic_budget_stays_below_the_reply_ceiling() {
        for max_tokens in [1024u32, 2048, 8192, 16_384, 64_000] {
            let levels = default_levels("anthropic", "claude-sonnet-5", "", max_tokens);
            for level in levels.iter().filter(|l| l.id != LEVEL_OFF) {
                let budget = level.patch["thinking"]["budget_tokens"]
                    .as_u64()
                    .unwrap_or(0);
                assert!(
                    budget < max_tokens as u64,
                    "level {} asked for budget {} with max_tokens {}",
                    level.id,
                    budget,
                    max_tokens
                );
                assert!(budget > 0, "level {} sent a zero budget", level.id);
            }
        }
    }

    #[test]
    fn openai_levels_follow_the_gateway_vocabulary() {
        let patch = |levels: Vec<ThinkingLevel>, id: &str| {
            levels.into_iter().find(|l| l.id == id).unwrap().patch
        };
        let glm = default_levels("openai", "glm-5.3", "", 8192);
        assert_eq!(patch(glm.clone(), "high")["thinking"]["type"], "enabled");
        assert_eq!(patch(glm, LEVEL_OFF)["thinking"]["type"], "disabled");

        let qwen = default_levels("openai", "qwen3.5", "", 8192);
        assert_eq!(patch(qwen.clone(), "low")["enable_thinking"], true);
        assert_eq!(patch(qwen, LEVEL_OFF)["enable_thinking"], false);

        let ollama = default_levels("openai", "llama4", "http://ollama.local/v1", 8192);
        assert_eq!(patch(ollama.clone(), "medium")["think"], true);
        assert_eq!(patch(ollama, LEVEL_OFF)["think"], false);

        let deepseek = default_levels("openai", "deepseek-chat", "https://api.deepseek.com", 8192);
        assert_eq!(
            patch(deepseek.clone(), "high")["thinking"]["type"],
            "enabled"
        );
        assert_eq!(patch(deepseek, LEVEL_OFF)["thinking"]["type"], "disabled");

        let gpt = default_levels("openai", "gpt-5", "", 8192);
        assert_eq!(patch(gpt.clone(), "high")["reasoning_effort"], "high");
        assert_eq!(patch(gpt.clone(), "max")["reasoning_effort"], "high");
        assert!(patch(gpt, LEVEL_OFF).as_object().unwrap().is_empty());

        // An unknown compatible gateway sends nothing; the user maps a field.
        let other = default_levels("openai", "custom-model", "", 8192);
        assert!(patch(other, "high").as_object().unwrap().is_empty());
    }

    #[test]
    fn the_snapshot_keeps_the_legacy_shape_and_adds_the_level() {
        let providers = vec![provider_with(vec![model(
            "m",
            vec![("high", json!({"thinking": {"type": "enabled"}}))],
            "high",
        )])];
        let resolved = resolve(
            &providers,
            &ModelSelection {
                provider_id: "p".into(),
                model_id: "m".into(),
                thinking: "high".into(),
            },
        )
        .unwrap();
        let snapshot = resolved.snapshot();
        assert_eq!(snapshot.provider, "openai");
        assert_eq!(snapshot.model, "m");
        assert_eq!(snapshot.thinking, "high");
        assert_eq!(snapshot.provider_id, "p");
        assert_eq!(snapshot.model_id, "m");
    }
}
