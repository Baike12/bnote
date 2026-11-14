//! Tauri commands for study-mode selection translation.
//!
//! The API key and request live in Rust (`translate.json` and `translate.rs`);
//! the frontend only sends the selected text and receives a classified result.

use tauri::State;

use super::CmdResult;
use crate::state::AppState;
use crate::translate::{self, SelectionResult, TranslateConfig};

/// One selection → one result. A single word consults the embedded dictionary
/// only; a sentence calls the configured API. A missing word is `Miss`, never
/// an automatic API fallback.
#[tauri::command]
pub async fn translate_selection(
    state: State<'_, AppState>,
    text: String,
) -> CmdResult<SelectionResult> {
    let dir = state.data_dir();
    translate::translate_selection(&dir, &text).await
}

#[tauri::command]
pub async fn translate_get_config(state: State<'_, AppState>) -> CmdResult<TranslateConfig> {
    let dir = state.data_dir();
    tauri::async_runtime::spawn_blocking(move || translate::load(&dir))
        .await
        .map_err(|e| format!("JOIN_FAILED: {}", e))
}

#[tauri::command]
pub async fn translate_save_config(
    state: State<'_, AppState>,
    config: TranslateConfig,
) -> CmdResult<()> {
    let dir = state.data_dir();
    tauri::async_runtime::spawn_blocking(move || translate::save(&dir, &config))
        .await
        .map_err(|e| format!("JOIN_FAILED: {}", e))?
}

/// Tests the (possibly unsaved) form values without writing them to disk.
#[tauri::command]
pub async fn translate_test(config: TranslateConfig) -> CmdResult<String> {
    let mut config = config;
    config.normalize();
    translate::translate_sentence(&config, "Hello, world. This is a connection test.").await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::{app, block_on};

    #[test]
    fn the_translate_config_round_trips_through_the_command_surface() {
        let fixture = app("translate-config");
        // No file yet: `load` normalizes, so the caller receives a usable
        // config (openai defaults) instead of an empty protocol string.
        let defaults = block_on(translate_get_config(fixture.state())).expect("defaults");
        assert_eq!(defaults.protocol, "openai");

        let mut config = TranslateConfig {
            protocol: "deepseek".into(),
            base_url: "https://api.deepseek.com".into(),
            ..Default::default()
        };
        config.normalize();
        block_on(translate_save_config(fixture.state(), config.clone())).expect("save");
        let loaded = block_on(translate_get_config(fixture.state())).expect("load");
        assert_eq!(loaded.protocol, "deepseek");
        assert_eq!(loaded.base_url, "https://api.deepseek.com");
        assert!(fixture.dir.join("translate.json").is_file());
    }

    #[test]
    fn a_word_selection_needs_no_api_configuration() {
        // The dictionary is embedded: an empty configuration must still answer
        // a word, and a miss must stay a miss (never an API fallback).
        let fixture = app("translate-word");
        match block_on(translate_selection(fixture.state(), "study".into()))
            .expect("a word is answered from the embedded dictionary")
        {
            crate::translate::SelectionResult::Word { entry } => {
                assert_eq!(entry.word.to_lowercase(), "study");
            }
            other => panic!("a dictionary word must not become {other:?}"),
        }

        match block_on(translate_selection(fixture.state(), "zzqqxx".into())).expect("miss") {
            crate::translate::SelectionResult::Miss { word } => assert_eq!(word, "zzqqxx"),
            other => panic!("an unknown word must be a Miss, got {other:?}"),
        }

        // Whitespace/punctuation only is "nothing selected", not a request.
        match block_on(translate_selection(fixture.state(), "   ".into())).expect("none") {
            crate::translate::SelectionResult::None => {}
            other => panic!("blank text must be None, got {other:?}"),
        }
    }

    #[test]
    fn a_sentence_without_a_model_is_a_configuration_error_before_the_network() {
        let fixture = app("translate-sentence");
        let err = block_on(translate_selection(
            fixture.state(),
            "This is a whole sentence with several words.".into(),
        ))
        .expect_err("unconfigured sentence must fail fast");
        assert!(err.contains("翻译 API 未配置"), "{err}");
        // A failed lookup must not leave a half-written config behind.
        assert!(!fixture.dir.join("translate.json").is_file());
    }
}
