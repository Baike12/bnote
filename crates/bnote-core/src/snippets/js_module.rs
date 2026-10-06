//! Reader for the vault snippet module — the static half of
//! `<vault>/.bnote/snippets.js`.
//!
//! The TS host `import()`s that file, so its values are real JS: a `trigger`
//! may be a **regex literal**, and a `replacement` may be a **function** (the
//! plugin ships one: the N×N identity-matrix generator). A Rust host cannot
//! run JS, so this module reads the same definitions *statically*: it parses
//! the subset of JS the file format is written in —
//!
//! ```js
//! // a comment
//! export default [
//!   { trigger: "#@", replacement: "$$\n…", options: "tA" },     // trailing commas ok
//!   { trigger: /iden(\d)/, replacement: (m) => { … }, priority: -1 },
//!   { trigger: 'single-quoted', replacement: "\\alpha", description: "…" },
//! ];
//! ```
//!
//! — namely: an optional `export default` / `module.exports =` wrapper; an
//! array (or the `{ default: [ … ] }` shape the JSON form used); objects with
//! bare or quoted keys; single- or double-quoted strings with JS escape
//! sequences (`\n`, `\t`, `\u{…}`, surrogate pairs, identity escapes); regex
//! literals with flags; numbers; booleans; `null`; arrow/`function` bodies
//! (kept verbatim, never evaluated); `//` and `/* */` comments; trailing
//! commas. Fields it does not know are parsed and ignored, so a file carrying
//! extra metadata still loads.
//!
//! Anything outside that subset is a **hard error carrying the line number**,
//! never a silent skip. What happens to the definitions afterwards — a
//! function replacement the engine has no native binding for, a trigger regex
//! the Rust dialect cannot compile — is [`super::load`]'s business.

use super::load::SnippetFileError;

/// A trigger as written in the module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JsTrigger {
    /// A string literal. In the file format the `r` option turns such a
    /// trigger into a regex at compile time (that is the engine's job); the
    /// reader keeps it literal.
    Literal(String),
    /// A regex literal `/source/flags`; the source is kept **verbatim** — JS
    /// hands it to the regex engine unchanged, and so does
    /// [`super::engine::parse_snippet`].
    Regex { source: String, flags: String },
}

impl JsTrigger {
    /// The trigger as the file spells it, for messages (`"dm"`, `/iden(\d)/`).
    pub fn display(&self) -> String {
        match self {
            JsTrigger::Literal(text) => format!("\"{text}\""),
            JsTrigger::Regex { source, flags } => format!("/{source}/{flags}"),
        }
    }
}

/// A replacement as written in the module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JsReplacement {
    /// A string literal, escapes decoded.
    Text(String),
    /// A function expression, kept as source. The engine cannot run it; the
    /// binding to a native implementation happens in [`super::load`].
    Function { source: String },
}

/// One snippet definition read from the module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsSnippetDef {
    pub trigger: JsTrigger,
    pub replacement: JsReplacement,
    pub options: String,
    pub priority: i32,
    pub description: String,
    /// 1-based line of the entry's `{`, for messages.
    pub line: usize,
}

/// Parses a whole snippet module (or the bare array/object the JSON form
/// used) into its definitions. See the module docs for the accepted subset;
/// every rejection names its line.
pub fn parse_snippet_module(src: &str) -> Result<Vec<JsSnippetDef>, SnippetFileError> {
    let mut parser = Parser::new(src);
    parser.skip_trivia()?;
    if parser.eat_ident("export") {
        parser.skip_trivia()?;
        if !parser.eat_ident("default") {
            return parser.err("export 后面应该是 default");
        }
    } else if parser.eat_ident("module") {
        parser.expect(b'.', "module.exports")?;
        if !parser.eat_ident("exports") {
            return parser.err("module.exports 拼写不对");
        }
        parser.skip_trivia()?;
        parser.expect(b'=', "module.exports = [ … ]")?;
    }

    let root = parser.parse_value()?;
    let root_line = root.line;
    let items = match root.value {
        Value::Array(items) => items,
        // The JSON stand-in shape: the array under a `default` key.
        Value::Object(entries) => match entries.into_iter().find(|(key, _)| key == "default") {
            Some((_, value)) => match value.value {
                Value::Array(items) => items,
                _ => return Err(not_an_array(root_line)),
            },
            None => return Err(not_an_array(root_line)),
        },
        _ => return Err(not_an_array(root_line)),
    };

    let mut defs: Vec<JsSnippetDef> = Vec::with_capacity(items.len());
    for item in items {
        defs.push(def_from_value(item)?);
    }
    Ok(defs)
}

fn not_an_array(line: usize) -> SnippetFileError {
    // The TS `normalizeSnippetExport` message: the export must be the array.
    error_at(line, "snippets.js 必须 default 导出片段数组(export default [...])")
}

/// The keys [`def_from_value`] reads. An object entry for any other key is
/// ignored metadata, and its value is parsed loosely (see
/// [`Parser::skip_expression_tail`]); for these keys the value must be a plain
/// literal, so a missing comma between two entries is still a hard error.
const KNOWN_KEYS: &[&str] =
    &["trigger", "replacement", "options", "priority", "description", "regex"];

fn def_from_value(item: Spanned) -> Result<JsSnippetDef, SnippetFileError> {
    let line = item.line;
    let Value::Object(entries) = item.value else {
        return Err(error_at(line, "片段必须是对象 { trigger: …, replacement: … }"));
    };

    // Last key wins, like a JS object literal.
    let mut trigger: Option<(usize, Value)> = None;
    let mut replacement: Option<(usize, Value)> = None;
    let mut options = String::new();
    let mut description = String::new();
    let mut priority: i32 = 0;
    let mut explicit_regex = false;
    for (key, value) in entries {
        match key.as_str() {
            "trigger" => trigger = Some((value.line, value.value)),
            "replacement" => replacement = Some((value.line, value.value)),
            "options" => options = string_field(&key, value)?,
            "description" => description = string_field(&key, value)?,
            "priority" => priority = number_field(&key, value)?,
            "regex" => explicit_regex = bool_field(&key, value)?,
            _ => {} // forward-compatible: unknown metadata is ignored
        }
    }

    let Some((trigger_line, trigger_value)) = trigger else {
        return Err(error_at(line, "片段缺少 trigger"));
    };
    let Some((replacement_line, replacement_value)) = replacement else {
        return Err(error_at(line, "片段缺少 replacement"));
    };

    let trigger = match trigger_value {
        Value::Str(text) => {
            // `regex: true` is the JSON shape's stand-in for a regex literal
            // (it cannot carry one), so normalize it to the same thing.
            if explicit_regex {
                JsTrigger::Regex { source: text, flags: String::new() }
            } else {
                JsTrigger::Literal(text)
            }
        }
        Value::Regex { source, flags } => JsTrigger::Regex { source, flags },
        other => {
            return Err(error_at(
                trigger_line,
                format!("trigger 必须是字符串或正则字面量,得到 {}", other.describe()),
            ))
        }
    };

    let replacement = match replacement_value {
        Value::Str(text) => JsReplacement::Text(text),
        Value::Function(source) => JsReplacement::Function { source },
        other => {
            return Err(error_at(
                replacement_line,
                format!("replacement 必须是字符串或函数,得到 {}", other.describe()),
            ))
        }
    };

    Ok(JsSnippetDef { trigger, replacement, options, priority, description, line })
}

fn error_at(line: usize, message: impl AsRef<str>) -> SnippetFileError {
    SnippetFileError { message: format!("第 {line} 行:{}", message.as_ref()) }
}

fn string_field(key: &str, value: Spanned) -> Result<String, SnippetFileError> {
    match value.value {
        Value::Str(text) => Ok(text),
        other => Err(error_at(
            value.line,
            format!("{key} 必须是字符串,得到 {}", other.describe()),
        )),
    }
}

fn number_field(key: &str, value: Spanned) -> Result<i32, SnippetFileError> {
    match value.value {
        Value::Number(n) if n.fract() == 0.0 && n >= i32::MIN as f64 && n <= i32::MAX as f64 => {
            Ok(n as i32)
        }
        other => Err(error_at(value.line, format!("{key} 必须是整数,得到 {}", other.describe()))),
    }
}

fn bool_field(key: &str, value: Spanned) -> Result<bool, SnippetFileError> {
    match value.value {
        Value::Bool(b) => Ok(b),
        other => Err(error_at(
            value.line,
            format!("{key} 必须是 true/false,得到 {}", other.describe()),
        )),
    }
}

// ---------------------------------------------------------------------------
// The value model
// ---------------------------------------------------------------------------

/// A parsed JS value, with the line it started on.
#[derive(Debug, Clone, PartialEq)]
struct Spanned {
    line: usize,
    value: Value,
}

#[derive(Debug, Clone, PartialEq)]
enum Value {
    Str(String),
    Regex { source: String, flags: String },
    Number(f64),
    Bool(bool),
    Null,
    /// Template literal contents, raw (never used by the mapping, but a file
    /// may carry one in a field this reader ignores).
    Template(String),
    /// A bare identifier: a constant reference the reader cannot resolve.
    Ident(String),
    /// A function expression's source, verbatim.
    Function(String),
    Array(Vec<Spanned>),
    Object(Vec<(String, Spanned)>),
}

impl Value {
    fn describe(&self) -> &'static str {
        match self {
            Value::Str(_) => "字符串",
            Value::Regex { .. } => "正则字面量",
            Value::Number(_) => "数字",
            Value::Bool(_) => "布尔值",
            Value::Null => "null",
            Value::Template(_) => "模板字符串",
            Value::Ident(_) => "标识符",
            Value::Function(_) => "函数",
            Value::Array(_) => "数组",
            Value::Object(_) => "对象",
        }
    }
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

struct Parser<'a> {
    src: &'a str,
    pos: usize,
    line: usize,
}

impl<'a> Parser<'a> {
    fn new(src: &'a str) -> Self {
        Self { src, pos: 0, line: 1 }
    }

    fn err<T>(&self, message: impl AsRef<str>) -> Result<T, SnippetFileError> {
        Err(error_at(self.line, message))
    }

    fn peek(&self) -> Option<u8> {
        self.src.as_bytes().get(self.pos).copied()
    }

    fn peek_at(&self, ahead: usize) -> Option<u8> {
        self.src.as_bytes().get(self.pos + ahead).copied()
    }

    /// Advances one character (never a byte of a multi-byte one) and keeps the
    /// line count.
    fn bump(&mut self) {
        let Some(ch) = self.src[self.pos..].chars().next() else {
            return;
        };
        if ch == '\n' {
            self.line += 1;
        }
        self.pos += ch.len_utf8();
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.bump();
            true
        } else {
            false
        }
    }

    fn expect(&mut self, byte: u8, what: &str) -> Result<(), SnippetFileError> {
        if self.eat(byte) {
            Ok(())
        } else {
            self.err(format!("期望 `{}`({what})", byte as char))
        }
    }

    /// Whitespace and comments.
    fn skip_trivia(&mut self) -> Result<(), SnippetFileError> {
        loop {
            match self.peek() {
                Some(b' ' | b'\t' | b'\r' | b'\n') => self.bump(),
                Some(b'/') if self.peek_at(1) == Some(b'/') => {
                    while let Some(byte) = self.peek() {
                        if byte == b'\n' {
                            break;
                        }
                        self.bump();
                    }
                }
                Some(b'/') if self.peek_at(1) == Some(b'*') => {
                    self.bump();
                    self.bump();
                    loop {
                        match self.peek() {
                            None => return self.err("块注释 /* 没有闭合"),
                            Some(b'*') if self.peek_at(1) == Some(b'/') => {
                                self.bump();
                                self.bump();
                                break;
                            }
                            _ => self.bump(),
                        }
                    }
                }
                _ => return Ok(()),
            }
        }
    }

    fn eat_ident(&mut self, name: &str) -> bool {
        if self.peek_ident_is(name) {
            self.bump_ident();
            true
        } else {
            false
        }
    }

    fn peek_ident_is(&self, name: &str) -> bool {
        let bytes = self.src.as_bytes();
        self.src[self.pos..].starts_with(name)
            && bytes.get(self.pos + name.len()).is_none_or(|b| !is_ident_byte(*b))
    }

    fn bump_ident(&mut self) {
        while let Some(byte) = self.peek() {
            if is_ident_byte(byte) {
                self.bump();
            } else {
                break;
            }
        }
    }

    fn parse_ident(&mut self) -> Result<String, SnippetFileError> {
        let start = self.pos;
        while let Some(byte) = self.peek() {
            if is_ident_byte(byte) {
                self.bump();
            } else {
                break;
            }
        }
        if start == self.pos {
            return self.err("期望一个名字");
        }
        Ok(self.src[start..self.pos].to_string())
    }

    fn parse_value(&mut self) -> Result<Spanned, SnippetFileError> {
        self.skip_trivia()?;
        let line = self.line;
        let Some(byte) = self.peek() else {
            return self.err("这里应该有一个值");
        };
        let value = match byte {
            b'"' | b'\'' => Value::Str(self.parse_string()?),
            b'/' => {
                let (source, flags) = self.parse_regex()?;
                Value::Regex { source, flags }
            }
            b'[' => self.parse_array()?,
            b'{' => self.parse_object()?,
            b'`' => Value::Template(self.parse_template()?),
            b'-' | b'0'..=b'9' => Value::Number(self.parse_number()?),
            b'(' => Value::Function(self.parse_function()?),
            _ if is_ident_byte(byte) => self.parse_word()?,
            other => return self.err(format!("读不懂的字符 `{}`", other as char)),
        };
        Ok(Spanned { line, value })
    }

    /// An identifier: `true`/`false`/`null`, the `function`/`async` heads of a
    /// function expression, a bare constant, or the parameter of an arrow
    /// function (`m => …`).
    fn parse_word(&mut self) -> Result<Value, SnippetFileError> {
        if self.peek_ident_is("function") {
            return Ok(Value::Function(self.parse_function()?));
        }

        let start = self.pos;
        let name = self.parse_ident()?;
        if name == "async" {
            // `async function …`, `async (…) => …`, `async m => …` — probe
            // ahead on a copy so the plain-identifier path stays untouched.
            let mut probe = Parser { src: self.src, pos: self.pos, line: self.line };
            probe.skip_trivia()?;
            let looks_like_function = probe.peek_ident_is("function")
                || probe.peek() == Some(b'(')
                || (probe.peek().is_some_and(is_ident_start) && {
                    probe.bump_ident();
                    probe.skip_trivia()?;
                    probe.peek() == Some(b'=') && probe.peek_at(1) == Some(b'>')
                });
            if looks_like_function {
                return Ok(Value::Function(self.parse_function()?));
            }
        }

        self.skip_trivia()?;
        // An arrow function: the identifier is its (only) parameter.
        if self.peek() == Some(b'=') && self.peek_at(1) == Some(b'>') {
            self.bump();
            self.bump();
            self.skip_function_body()?;
            return Ok(Value::Function(self.src[start..self.pos].to_string()));
        }
        Ok(match name.as_str() {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            "null" | "undefined" => Value::Null,
            _ => Value::Ident(name),
        })
    }

    /// A function expression: `function (…) {…}`, `async function …`,
    /// `(a, b) => …` or `async (a) => …`. The source is kept verbatim; the
    /// body is only *balanced*, never parsed.
    fn parse_function(&mut self) -> Result<String, SnippetFileError> {
        let start = self.pos;
        let _ = self.eat_ident("async");
        self.skip_trivia()?;
        if self.eat_ident("function") {
            self.skip_trivia()?;
            if self.peek().is_some_and(is_ident_start) {
                let _ = self.parse_ident()?;
                self.skip_trivia()?;
            }
        }
        if self.peek() != Some(b'(') {
            return self.err("函数表达式缺少参数列表");
        }
        self.skip_balanced(b'(', b')')?;
        self.skip_trivia()?;
        if self.peek() == Some(b'=') && self.peek_at(1) == Some(b'>') {
            self.bump();
            self.bump();
        } else if self.peek() != Some(b'{') {
            return self.err("箭头函数缺少 `=>`");
        }
        self.skip_function_body()?;
        Ok(self.src[start..self.pos].to_string())
    }

    /// The body of a function: a braced block, or an expression.
    fn skip_function_body(&mut self) -> Result<(), SnippetFileError> {
        self.skip_trivia()?;
        if self.peek() == Some(b'{') {
            self.skip_balanced(b'{', b'}')
        } else {
            // Expression body (`m => m[1].toUpperCase()`): consume it up to the
            // enclosing `,` / closer.
            self.skip_expression_tail()
        }
    }

    /// Consumes whatever keeps the value just parsed an expression — binary
    /// operators, method calls, ternaries, a following `{` block — up to the
    /// enclosing `,` / `}` / `]` / `)`. Well-formed data has nothing to consume
    /// here; it is what lets an entry the reader ignores carry an arbitrary
    /// expression (`count: 40 / 2`, `f: (a) => a[1].x`) without breaking the
    /// object parse. It never runs for the keys the format defines, so a
    /// missing comma between two snippet entries is still an error.
    fn skip_expression_tail(&mut self) -> Result<(), SnippetFileError> {
        loop {
            self.skip_trivia()?;
            let Some(byte) = self.peek() else {
                return Ok(());
            };
            match byte {
                b',' | b'}' | b']' | b')' | b';' => return Ok(()),
                b'(' | b'[' | b'{' => self.skip_balanced(byte, closing_bracket(byte))?,
                b'"' | b'\'' => {
                    self.parse_string()?;
                }
                b'`' => {
                    self.parse_template()?;
                }
                b'/' if matches!(self.peek_at(1), Some(b'/') | Some(b'*')) => {
                    self.skip_trivia()?;
                }
                b'/' if self.regex_may_start() => {
                    self.parse_regex()?;
                }
                _ => self.bump(),
            }
        }
    }

    fn parse_string(&mut self) -> Result<String, SnippetFileError> {
        let quote = self.peek().expect("caller checked");
        self.bump();
        let mut out = String::new();
        loop {
            let Some(byte) = self.peek() else {
                return self.err("字符串没有闭合");
            };
            if byte == quote {
                self.bump();
                return Ok(out);
            }
            match byte {
                b'\n' => return self.err("字符串里不能直接换行(换行写 \\n)"),
                b'\\' => {
                    self.bump();
                    out.push_str(&self.parse_escape()?);
                }
                _ => {
                    let ch = self.src[self.pos..].chars().next().expect("char boundary");
                    out.push(ch);
                    self.bump();
                }
            }
        }
    }

    /// One escape sequence, the backslash already consumed. JS semantics: the
    /// known escapes decode, every other escaped character stands for itself
    /// (`\\'`, `\\/`, `\\$`, …).
    fn parse_escape(&mut self) -> Result<String, SnippetFileError> {
        let Some(ch) = self.src[self.pos..].chars().next() else {
            return self.err("转义符后面没有字符");
        };
        self.bump();
        Ok(match ch {
            'n' => "\n".to_string(),
            't' => "\t".to_string(),
            'r' => "\r".to_string(),
            'b' => "\u{8}".to_string(),
            'f' => "\u{c}".to_string(),
            'v' => "\u{b}".to_string(),
            '0' => "\0".to_string(),
            '\n' => String::new(), // a backslash-newline continues the line
            'x' => self.hex_escape(2)?,
            'u' => self.unicode_escape()?,
            other => other.to_string(),
        })
    }

    fn hex_escape(&mut self, digits: usize) -> Result<String, SnippetFileError> {
        let value = self.hex_digits(digits)?;
        match char::from_u32(value) {
            Some(ch) => Ok(ch.to_string()),
            None => self.err(format!("\\x/\\u 转义 {value:04X} 不是合法字符")),
        }
    }

    fn unicode_escape(&mut self) -> Result<String, SnippetFileError> {
        if self.eat(b'{') {
            let start = self.pos;
            let mut value: u32 = 0;
            let mut count = 0;
            while let Some(byte) = self.peek() {
                if byte == b'}' {
                    break;
                }
                let digit = hex_value(byte)
                    .ok_or_else(|| error_at(self.line, "\\u{…} 里不是十六进制数字"))?;
                value = value.wrapping_mul(16).wrapping_add(digit);
                count += 1;
                if count > 6 {
                    return self.err("\\u{…} 最多 6 位十六进制");
                }
                self.bump();
            }
            if count == 0 || self.pos == start {
                return self.err("\\u{…} 是空的");
            }
            self.expect(b'}', "\\u{…}")?;
            return match char::from_u32(value) {
                Some(ch) => Ok(ch.to_string()),
                None => self.err(format!("\\u{{{value:X}}} 不是合法字符")),
            };
        }

        let first = self.hex_digits(4)?;
        // A high surrogate is only legal as the first half of a pair; JS
        // writes emoji as `\uD83D\uDE00`.
        if (0xD800..=0xDBFF).contains(&first) {
            if self.peek() == Some(b'\\') && self.peek_at(1) == Some(b'u') {
                let save_pos = self.pos;
                let save_line = self.line;
                self.bump();
                self.bump();
                if let Ok(second) = self.hex_digits(4) {
                    if (0xDC00..=0xDFFF).contains(&second) {
                        let combined = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00);
                        if let Some(ch) = char::from_u32(combined) {
                            return Ok(ch.to_string());
                        }
                    }
                }
                self.pos = save_pos;
                self.line = save_line;
            }
            return self.err("孤立的代理项转义(\\uD800–\\uDBFF 后面要跟低位代理)");
        }
        match char::from_u32(first) {
            Some(ch) => Ok(ch.to_string()),
            None => self.err(format!("\\u{first:04X} 不是合法字符")),
        }
    }

    fn hex_digits(&mut self, digits: usize) -> Result<u32, SnippetFileError> {
        let mut value: u32 = 0;
        for _ in 0..digits {
            let Some(byte) = self.peek() else {
                return self.err(format!("\\u 转义需要 {digits} 位十六进制数字"));
            };
            let digit = hex_value(byte)
                .ok_or_else(|| error_at(self.line, "\\x/\\u 转义里不是十六进制数字"))?;
            value = value * 16 + digit;
            self.bump();
        }
        Ok(value)
    }

    fn parse_number(&mut self) -> Result<f64, SnippetFileError> {
        let start = self.pos;
        self.eat(b'-');
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.bump();
        }
        if self.peek() == Some(b'.') {
            self.bump();
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.bump();
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            let save = self.pos;
            self.bump();
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.bump();
            }
            if self.peek().is_some_and(|b| b.is_ascii_digit()) {
                while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                    self.bump();
                }
            } else {
                self.pos = save; // `1e` is not an exponent; stop before it
            }
        }
        let text = &self.src[start..self.pos];
        text.parse::<f64>()
            .map_err(|_| error_at(self.line, format!("数字 `{text}` 读不出来")))
    }

    fn parse_regex(&mut self) -> Result<(String, String), SnippetFileError> {
        self.bump(); // the opening `/`
        let start = self.pos;
        let mut in_class = false;
        loop {
            let Some(byte) = self.peek() else {
                return self.err("正则字面量没有闭合");
            };
            match byte {
                b'\\' => {
                    self.bump();
                    self.bump();
                }
                b'\n' => return self.err("正则字面量里不能直接换行"),
                b'[' => {
                    in_class = true;
                    self.bump();
                }
                b']' => {
                    in_class = false;
                    self.bump();
                }
                b'/' if !in_class => {
                    let source = self.src[start..self.pos].to_string();
                    self.bump();
                    let flags_start = self.pos;
                    while self.peek().is_some_and(|b| b.is_ascii_alphabetic()) {
                        self.bump();
                    }
                    return Ok((source, self.src[flags_start..self.pos].to_string()));
                }
                _ => self.bump(),
            }
        }
    }

    fn parse_template(&mut self) -> Result<String, SnippetFileError> {
        self.bump(); // the opening backtick
        let start = self.pos;
        let mut depth = 0usize;
        loop {
            let Some(byte) = self.peek() else {
                return self.err("模板字符串没有闭合");
            };
            match byte {
                b'\\' => {
                    self.bump();
                    self.bump();
                }
                b'`' if depth == 0 => {
                    let raw = self.src[start..self.pos].to_string();
                    self.bump();
                    return Ok(raw);
                }
                b'$' if self.peek_at(1) == Some(b'{') => {
                    self.bump();
                    self.bump();
                    depth += 1;
                }
                b'}' if depth > 0 => {
                    self.bump();
                    depth -= 1;
                }
                _ => self.bump(),
            }
        }
    }

    fn parse_array(&mut self) -> Result<Value, SnippetFileError> {
        self.expect(b'[', "数组起始")?;
        let mut items = Vec::new();
        loop {
            self.skip_trivia()?;
            if self.eat(b']') {
                return Ok(Value::Array(items));
            }
            items.push(self.parse_value()?);
            self.skip_trivia()?;
            if self.eat(b',') {
                continue;
            }
            self.skip_trivia()?;
            if self.eat(b']') {
                return Ok(Value::Array(items));
            }
            return self.err("数组元素之间少了逗号");
        }
    }

    fn parse_object(&mut self) -> Result<Value, SnippetFileError> {
        self.expect(b'{', "对象起始")?;
        let mut entries: Vec<(String, Spanned)> = Vec::new();
        loop {
            self.skip_trivia()?;
            if self.eat(b'}') {
                return Ok(Value::Object(entries));
            }
            let key = match self.peek() {
                Some(b'"' | b'\'') => self.parse_string()?,
                Some(byte) if byte.is_ascii_digit() => {
                    format!("{}", self.parse_number()? as i64)
                }
                Some(byte) if is_ident_start(byte) => self.parse_ident()?,
                Some(other) => {
                    return self.err(format!("对象的键读不出来(碰到 `{}`)", other as char))
                }
                None => return self.err("对象没有闭合"),
            };
            self.skip_trivia()?;
            self.expect(b':', "键后面的冒号")?;
            let value = self.parse_value()?;
            if !KNOWN_KEYS.contains(&key.as_str()) {
                // An unknown field may be any expression; the def mapping
                // ignores it either way.
                self.skip_expression_tail()?;
            }
            if let Some(slot) = entries.iter_mut().find(|(name, _)| *name == key) {
                slot.1 = value; // last key wins, like a JS object literal
            } else {
                entries.push((key, value));
            }
            self.skip_trivia()?;
            if self.eat(b',') {
                continue;
            }
            self.skip_trivia()?;
            if self.eat(b'}') {
                return Ok(Value::Object(entries));
            }
            return self.err("对象成员之间少了逗号");
        }
    }

    /// Skips a bracketed region (`{…}`, `(…)`) without interpreting it. Inside
    /// it, strings, templates, comments and regex literals are stepped over so
    /// their contents cannot unbalance the brackets; a `/` is read as a regex
    /// only where a value may start (after `(`, `,`, `=`, `:`, an operator …),
    /// so `n / 2` stays a division.
    fn skip_balanced(&mut self, open: u8, close: u8) -> Result<(), SnippetFileError> {
        self.expect(open, "成对括号")?;
        let mut depth = 1usize;
        loop {
            let Some(byte) = self.peek() else {
                return self.err(format!("`{}` 没有闭合", open as char));
            };
            if byte == close {
                depth -= 1;
                self.bump();
                if depth == 0 {
                    return Ok(());
                }
                continue;
            }
            if byte == open {
                depth += 1;
                self.bump();
                continue;
            }
            match byte {
                b'"' | b'\'' => {
                    self.parse_string()?;
                }
                b'`' => {
                    self.parse_template()?;
                }
                b'/' if matches!(self.peek_at(1), Some(b'/') | Some(b'*')) => {
                    self.skip_trivia()?;
                }
                b'/' if self.regex_may_start() => {
                    self.parse_regex()?;
                }
                _ => self.bump(),
            }
        }
    }

    /// Whether a `/` at the cursor can only start a regex literal: the last
    /// significant byte before it is not one that ends a value.
    fn regex_may_start(&self) -> bool {
        let before = self.src[..self.pos].bytes().rev().find(|b| !b.is_ascii_whitespace());
        match before {
            None => true,
            Some(byte) => !(byte.is_ascii_alphanumeric()
                || matches!(byte, b')' | b']' | b'}' | b'_' | b'$' | b'"' | b'\'' | b'`')),
        }
    }
}

fn is_ident_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$'
}

fn closing_bracket(open: u8) -> u8 {
    match open {
        b'(' => b')',
        b'[' => b']',
        _ => b'}',
    }
}

fn is_ident_byte(byte: u8) -> bool {
    is_ident_start(byte) || byte.is_ascii_digit()
}

fn hex_value(byte: u8) -> Option<u32> {
    match byte {
        b'0'..=b'9' => Some((byte - b'0') as u32),
        b'a'..=b'f' => Some((byte - b'a' + 10) as u32),
        b'A'..=b'F' => Some((byte - b'A' + 10) as u32),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(def: &JsSnippetDef) -> &str {
        match &def.replacement {
            JsReplacement::Text(text) => text,
            other => panic!("expected a text replacement, got {other:?}"),
        }
    }

    /// The module's own shape: `export default [ … ]`, `//` comments, trailing
    /// commas, every field the format has.
    #[test]
    fn the_module_shape_parses() {
        let src = r##"
// bnote 仓库级 LaTeX 片段
export default [
  // ── 数学环境骨架 ──
  { trigger: "#@", replacement: "$$\n\\begin{align}\n$0\n\\end{align}\n$$", options: "tA" },
  { trigger: /iden(\d)/, replacement: (m) => { return "x"; }, options: "mA", priority: -1, description: "N×N 单位阵" },
];
"##;
        let defs = parse_snippet_module(src).unwrap();
        assert_eq!(defs.len(), 2);
        assert_eq!(defs[0].trigger, JsTrigger::Literal("#@".into()));
        assert_eq!(text(&defs[0]), "$$\n\\begin{align}\n$0\n\\end{align}\n$$");
        assert_eq!(defs[0].options, "tA");
        assert_eq!(defs[0].priority, 0);
        assert_eq!(defs[1].trigger, JsTrigger::Regex { source: r"iden(\d)".into(), flags: "".into() });
        assert!(matches!(defs[1].replacement, JsReplacement::Function { .. }));
        assert_eq!(defs[1].priority, -1);
        assert_eq!(defs[1].description, "N×N 单位阵");
        assert_eq!(defs[1].line, 6);
    }

    /// JS string escapes decode the way the TS host's `import()` decodes them;
    /// everything else is an identity escape.
    #[test]
    fn string_escapes_decode_like_js() {
        let src = r#"export default [
  { trigger: "a\"b", replacement: "tab\there", options: "m" },
  { trigger: 'single', replacement: 'a\\$b', options: "m" },
  { trigger: "u", replacement: "\u0041\u{1F600}\uD83D\uDE00", options: "m" },
  { trigger: "/", replacement: "slash \/ and quote \$ and bs \\", options: "m" },
];"#;
        let defs = parse_snippet_module(src).unwrap();
        assert_eq!(defs[0].trigger, JsTrigger::Literal("a\"b".into()));
        assert_eq!(text(&defs[0]), "tab\there");
        assert_eq!(defs[1].trigger, JsTrigger::Literal("single".into()));
        assert_eq!(text(&defs[1]), "a\\$b");
        assert_eq!(text(&defs[2]), "A😀😀");
        assert_eq!(text(&defs[3]), "slash / and quote $ and bs \\");
    }

    /// Regex literals keep their source verbatim (the engine, not the reader,
    /// translates the dialect), flags included; a `/` inside a character class
    /// does not end the literal.
    #[test]
    fn regex_literals_keep_source_and_flags() {
        let src = r#"export default [
  { trigger: /(?<!\\)log/, replacement: "\\log", options: "mA" },
  { trigger: /[/\]]+(\d)/gi, replacement: "x", options: "mA" },
];"#;
        let defs = parse_snippet_module(src).unwrap();
        assert_eq!(
            defs[0].trigger,
            JsTrigger::Regex { source: r"(?<!\\)log".into(), flags: "".into() }
        );
        assert_eq!(defs[1].trigger, JsTrigger::Regex { source: r"[/\]]+(\d)".into(), flags: "gi".into() });
        assert_eq!(defs[0].trigger.display(), r"/(?<!\\)log/");
    }

    /// A function replacement is kept as source, braces, backticks and nested
    /// templates included — and it does not unbalance the object around it.
    #[test]
    fn a_function_replacement_is_kept_verbatim() {
        let src = r#"export default [
  { trigger: /iden(\d)/, replacement: (match) => {
      const n = Number(match[1]);
      const rows = [];
      for (let j = 0; j < n; j++) {
        rows.push(Array.from({ length: n }, (_, i) => (i === j ? "1" : "0")).join(" & "));
      }
      return `\\begin{pmatrix}\n${rows.join(String.raw` \\` + "\n")}\n\\end{pmatrix}`;
    }, options: "mA", description: "N×N 单位阵" },
  { trigger: "after", replacement: "ok", options: "m" },
];"#;
        let defs = parse_snippet_module(src).unwrap();
        assert_eq!(defs.len(), 2);
        let JsReplacement::Function { source } = &defs[0].replacement else {
            panic!("expected a function replacement");
        };
        assert!(source.contains(r"String.raw` \\`"), "{source}");
        assert!(source.starts_with("(match) => {"));
        assert!(source.ends_with('}'));
        // The entry after it still parses: the block's braces balanced.
        assert_eq!(defs[1].trigger, JsTrigger::Literal("after".into()));
    }

    /// The `function` keyword and the two other arrow heads (`async`,
    /// `async (…)`) are recognized too.
    #[test]
    fn the_function_heads_are_recognized() {
        let src = r#"export default [
  { trigger: "a", replacement: function (m) { return m[0]; } },
  { trigger: "b", replacement: async (m) => { return "x"; } },
  { trigger: "c", replacement: async function named(m) { return m; } },
  { trigger: "d", replacement: m => m[1] },
];"#;
        let defs = parse_snippet_module(src).unwrap();
        for def in &defs {
            assert!(matches!(def.replacement, JsReplacement::Function { .. }), "{def:?}");
        }
    }

    /// Unknown fields of any shape parse and are ignored (forward compatible).
    #[test]
    fn unknown_fields_are_ignored() {
        let src = r#"export default [
  { trigger: "u", replacement: "x", when: SOME_CONST, extra: (a) => a, list: [1, "two", null], tpl: `a ${b} c`, nested: { a: { b: [true, false] } } },
];"#;
        let defs = parse_snippet_module(src).unwrap();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].trigger, JsTrigger::Literal("u".into()));
    }

    /// A `//` inside a string is not a comment, and neither is a `/*` inside a
    /// template or a regex.
    #[test]
    fn slashes_inside_values_are_not_comments() {
        let src = r#"export default [
  { trigger: "url", replacement: "https://x/y/*z*/", options: "m" },
  { trigger: /\/\/comment/, replacement: "re", options: "m" },
  { trigger: "t", replacement: "x", note: `a // b`, options: "m" },
  { trigger: "n", replacement: "y", count: 40 / 2, options: "m" },
];"#;
        let defs = parse_snippet_module(src).unwrap();
        assert_eq!(text(&defs[0]), "https://x/y/*z*/");
        assert_eq!(defs[1].trigger, JsTrigger::Regex { source: r"\/\/comment".into(), flags: "".into() });
        assert_eq!(text(&defs[3]), "y");
    }

    /// Block comments, including one inside an object.
    #[test]
    fn block_comments_are_skipped() {
        let src = r#"export default [
  /* leading */
  { trigger: "a", /* between */ replacement: "x", options: "m" },
];"#;
        assert_eq!(parse_snippet_module(src).unwrap().len(), 1);
        let broken = parse_snippet_module("export default [ /* not closed").unwrap_err();
        assert!(broken.message.contains("没有闭合"), "{broken:?}");
    }

    /// The file may also be plain JSON or a CommonJS module — same reader.
    #[test]
    fn the_json_and_cjs_shapes_parse_too() {
        let json = r#"[{ "trigger": "uq", "replacement": "USER$0", "options": "A" }]"#;
        assert_eq!(parse_snippet_module(json).unwrap()[0].trigger, JsTrigger::Literal("uq".into()));

        let esm = r#"{ "default": [{ "trigger": "uq", "replacement": "USER$0" }] }"#;
        assert_eq!(parse_snippet_module(esm).unwrap().len(), 1);

        let cjs = r#"module.exports = [{ trigger: "uq", replacement: "x" }];"#;
        assert_eq!(parse_snippet_module(cjs).unwrap().len(), 1);
    }

    /// The JSON shape's `regex: true` stand-in normalizes to the same thing a
    /// regex literal produces.
    #[test]
    fn explicit_regex_true_normalizes_to_a_regex_trigger() {
        let src = r#"[{ "trigger": "iden(\\d)", "replacement": "X", "options": "mA", "regex": true }]"#;
        let defs = parse_snippet_module(src).unwrap();
        assert_eq!(
            defs[0].trigger,
            JsTrigger::Regex { source: r"iden(\d)".into(), flags: "".into() }
        );
    }

    /// An empty array is a legal (deliberate) empty set, not an error.
    #[test]
    fn an_empty_array_is_legal() {
        assert!(parse_snippet_module("export default [];").unwrap().is_empty());
    }

    /// Every rejection names the line and what went wrong — no silent skips.
    #[test]
    fn errors_carry_the_line_and_the_reason() {
        let cases: &[(&str, usize, &str)] = &[
            ("export default [\n  { replacement: \"x\" },\n];", 2, "缺少 trigger"),
            ("export default [\n  { trigger: \"a\" },\n];", 2, "缺少 replacement"),
            ("export default [\n  { trigger: 3, replacement: \"x\" },\n];", 2, "trigger 必须是字符串"),
            ("export default [\n  { trigger: \"a\", replacement: 3 },\n];", 2, "replacement 必须是"),
            ("export default [\n  { trigger: \"a\", replacement: \"x\", priority: 1.5 },\n];", 2, "必须是整数"),
            ("export default [\n  { trigger: \"a\", replacement: \"oops },\n];", 2, "不能直接换行"),
            ("export default [\n  { trigger: \"a\", replacement: \"x\" }\n  { trigger: \"b\", replacement: \"y\" }\n];", 3, "少了逗号"),
            ("export default {}", 1, "片段数组"),
            ("export default [\n  { trigger: \"a\", replacement: \"x\"", 2, "少了逗号"),
            ("export default [\n  { trigger: \"a\", replacement: \"x\", garbage: @ },\n];", 2, "读不懂的字符"),
        ];
        for (src, line, needle) in cases {
            let err = parse_snippet_module(src).unwrap_err();
            assert!(err.message.contains(needle), "for {src:?}: {}", err.message);
            assert!(
                err.message.starts_with(&format!("第 {line} 行")),
                "for {src:?}: {}",
                err.message
            );
        }
    }

    /// `export default` followed by something that is not an array is the
    /// explicit shape error, and a module that is not a module at all fails on
    /// its first token.
    #[test]
    fn a_wrong_root_shape_is_an_explicit_error() {
        assert!(parse_snippet_module("export default \"nope\"").unwrap_err().message.contains("片段数组"));
        assert!(parse_snippet_module("export default").is_err());
        assert!(parse_snippet_module("const SNIPPETS = [];").is_err());
    }
}
