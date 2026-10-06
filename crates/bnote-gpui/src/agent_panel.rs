//! Agent chat panel over bnote-core's agent backend. Sessions, provider
//! streaming, tools, MCP and skills all live in core; this view only renders
//! conversation items and forwards input. Turn events arrive through the app
//! event bus (`agent-event`) — the workspace loop hands them to
//! [`AgentPanel::on_agent_event`].

use std::sync::Arc;

use bnote_core::agent::AgentConfig;
use bnote_core::state::AppState;
use ::gpui::{AppContext as _, Context, Entity, Focusable, Window, px};
use ::gpui::prelude::FluentBuilder as _;
use gpui_kit::*;
use gpui_kit::component::button::ButtonVariants as _;
use gpui_kit::component::{
    ActiveTheme as _, button::{Button, ButtonVariant}, h_flex, v_flex,
    input::{Editor, EditorState, InputEvent},
    label::Label,
};

#[derive(Clone, Debug, PartialEq)]
enum Role {
    User,
    Assistant,
    Tool,
    System,
}

#[derive(Clone, Debug, PartialEq)]
struct Item {
    role: Role,
    text: String,
    /// Tool items: None = still running.
    ok: Option<bool>,
}

pub struct AgentPanel {
    state: Arc<AppState>,
    session_id: Option<String>,
    items: Vec<Item>,
    draft: Entity<EditorState>,
    /// Text typed before a lazily-started session was ready.
    pending_send: Option<String>,
    busy: bool,
    model: String,
    error: Option<String>,
    _subscriptions: Vec<gpui::Subscription>,
}

impl AgentPanel {
    pub fn new(state: Arc<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let draft = cx.new(|cx| {
            EditorState::new(window, cx)
                .soft_wrap(true)
                .placeholder("问点什么…(Enter 发送)")
        });
        let model = AgentConfig::load(&state.data_dir()).model;
        let subscriptions = vec![cx.subscribe_in(
            &draft,
            window,
            |this, _draft, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { secondary: false, .. }) {
                    this.send(window, cx);
                }
            },
        )];
        Self {
            state,
            session_id: None,
            items: Vec::new(),
            draft,
            pending_send: None,
            busy: false,
            model,
            error: None,
            _subscriptions: subscriptions,
        }
    }

    fn start_session(&mut self, cx: &mut Context<Self>) {
        if self.session_id.is_some() {
            return;
        }
        let state = self.state.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    bnote_core::commands::agent::agent_start_session(&state, None)
                })
                .await;
            this.update(cx, |this, cx| match result {
                Ok(value) => {
                    this.session_id =
                        value.get("sessionId").and_then(|v| v.as_str()).map(String::from);
                    let tools = value
                        .get("mcpTools")
                        .and_then(|v| v.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0);
                    this.items.push(Item {
                        role: Role::System,
                        text: format!("会话就绪:{}(MCP 工具 {} 个)", this.model, tools),
                        ok: None,
                    });
                    if let Some(text) = this.pending_send.take() {
                        this.items.push(Item { role: Role::User, text, ok: None });
                        this.items
                            .push(Item { role: Role::Assistant, text: String::new(), ok: None });
                        this.busy = true;
                        this.dispatch_send(cx);
                    }
                    cx.notify();
                }
                Err(e) => {
                    this.error = Some(e);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// UI entry: push the user bubble, then dispatch (starting a session
    /// first if needed).
    pub fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.draft.read(cx).value().trim().to_string();
        if text.is_empty() {
            return;
        }
        self.draft.update(cx, |d, cx| d.set_value("", window, cx));
        if self.session_id.is_none() {
            self.pending_send = Some(text);
            self.start_session(cx);
            return;
        }
        self.items.push(Item { role: Role::User, text: text.clone(), ok: None });
        // The reply item streams in via text_delta events.
        self.items.push(Item { role: Role::Assistant, text: String::new(), ok: None });
        self.busy = true;
        self.error = None;
        self.dispatch_send_with(text, cx);
        cx.notify();
    }

    /// Send the pending bubble captured in `items` (used when the session
    /// became ready after `send`).
    fn dispatch_send(&mut self, cx: &mut Context<Self>) {
        let text = self.pending_send.clone().unwrap_or_default();
        self.pending_send = None;
        self.dispatch_send_with(text, cx);
    }

    fn dispatch_send_with(&mut self, text: String, cx: &mut Context<Self>) {
        let Some(session) = self.session_id.clone() else { return };
        let state = self.state.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    bnote_core::commands::agent::agent_send(&state, session, text)
                })
                .await;
            if let Err(e) = result {
                this.update(cx, |this, cx| {
                    this.error = Some(e);
                    this.busy = false;
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn new_session(&mut self, cx: &mut Context<Self>) {
        self.session_id = None;
        self.busy = false;
        self.items.clear();
        self.start_session(cx);
        cx.notify();
    }

    fn abort(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self.session_id.clone() else { return };
        let state = self.state.clone();
        self.busy = false;
        cx.spawn(async move |this, cx| {
            let _ = cx
                .background_executor()
                .spawn(async move {
                    bnote_core::commands::agent::agent_abort(&state, session)
                })
                .await;
            this.update(cx, |this, cx| {
                this.items.push(Item { role: Role::System, text: "已中止".into(), ok: None });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Deliver one `agent-event` payload (already filtered to agent events by
    /// the workspace loop).
    pub fn on_agent_event(
        &mut self,
        session: &str,
        event: &serde_json::Value,
        cx: &mut Context<Self>,
    ) {
        if self.session_id.is_none() {
            self.session_id = Some(session.to_string());
        } else if self.session_id.as_deref() != Some(session) {
            return;
        }
        match event.get("type").and_then(|v| v.as_str()) {
            Some("text_delta") => {
                let text = event.get("text").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(last) = self.items.last_mut() {
                    if last.role == Role::Assistant {
                        last.text.push_str(text);
                    }
                }
            }
            Some("tool_start") => {
                let name = event.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                self.items.push(Item { role: Role::Tool, text: name.to_string(), ok: None });
            }
            Some("tool_end") => {
                let ok = event.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                if let Some(last) = self.items.last_mut() {
                    if last.role == Role::Tool && last.ok.is_none() {
                        last.ok = Some(ok);
                    }
                }
            }
            Some("turn_end") => self.busy = false,
            Some("error") => {
                self.error = Some(
                    event.get("message").and_then(|v| v.as_str()).unwrap_or("未知错误").into(),
                );
                self.busy = false;
            }
            _ => {}
        }
        cx.notify();
    }

    fn render_item(&self, item: &Item, cx: &Context<Self>) -> gpui::AnyElement {
        let theme = cx.theme().clone();
        match item.role {
            Role::Tool => {
                let status = match item.ok {
                    None => "…",
                    Some(true) => "✓",
                    Some(false) => "✗",
                };
                h_flex()
                    .px_2()
                    .py_0p5()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(format!("🔧 {} {}", item.text, status))
                    .into_any_element()
            }
            Role::System => v_flex()
                .px_2()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(item.text.clone())
                .into_any_element(),
            Role::User => v_flex()
                .px_3()
                .py_2()
                .rounded_md()
                .bg(theme.accent.opacity(0.15))
                .text_color(theme.foreground)
                .child(item.text.clone())
                .into_any_element(),
            Role::Assistant => v_flex()
                .px_1()
                .text_color(theme.foreground)
                .child(item.text.clone())
                .into_any_element(),
        }
    }
}

impl ::gpui::Render for AgentPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl gpui::IntoElement {
        let theme = cx.theme().clone();
        let items: Vec<gpui::AnyElement> =
            self.items.iter().map(|i| self.render_item(i, cx)).collect();

        v_flex()
            .w_full()
            .h_full()
            .border_l_1()
            .border_color(theme.border)
            .bg(theme.background)
            .child(
                h_flex()
                    .justify_between()
                    .px_3()
                    .py_2()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Label::new("Agent")
                                    .font_weight(::gpui::FontWeight::MEDIUM),
                            )
                            .child(
                                Label::new(self.model.clone())
                                    .text_xs()
                                    .text_color(theme.muted_foreground),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_1()
                            .child(
                                Button::new("agent-new")
                                    .label("新会话")
                                    .compact()
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.new_session(cx);
                                    })),
                            )
                            .when(self.busy, |row| {
                                row.child(
                                    Button::new("agent-abort")
                                        .label("中止")
                                        .compact()
                                        .with_variant(ButtonVariant::Danger)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.abort(cx);
                                        })),
                                )
                            }),
                    ),
            )
            .child(
                v_flex()
                    .id("agent-items")
                    .flex_1()
                    .overflow_y_scroll()
                    .gap_2()
                    .p_2()
                    .children(items),
            )
            .children(
                self.error
                    .clone()
                    .map(|e| Label::new(e).text_xs().text_color(theme.danger).px_3()),
            )
            .child(
                h_flex()
                    .p_2()
                    .border_t_1()
                    .border_color(theme.border)
                    .child(Editor::new(&self.draft).bordered(true).h(px(72.)).flex_1()),
            )
    }
}

impl Focusable for AgentPanel {
    fn focus_handle(&self, cx: &gpui::App) -> gpui::FocusHandle {
        self.draft.focus_handle(cx)
    }
}
