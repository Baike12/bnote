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
