//! Normalized key input for the pure core. The host (adapter/interceptor)
//! translates GPUI `Keystroke`s into these; the core never sees platform
//! details. Printable characters ride in `Key::Char` using the *produced*
//! char (`key_char`), so `$`, `%`, `D` are layout-faithful.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Key {
    Char(char),
    Escape,
    Enter,
    Backspace,
    Delete,
    Tab,
    /// Arrow keys: vim treats them like h/j/k/l in every mode (with the
    /// wrap-at-EOL nuance of space/right ignored in v1).
    Up,
    Down,
    Left,
    Right,
    /// `<C-r>` (redo), `<C-a>`/`<C-x>` (numeric increment/decrement),
    /// `<C-o>` (jump list back): the ones the engine acts on. Any other
    /// ctrl chord rides in [`Key::Ctrl`] so `vimrc` mappings can bind it.
    Ctrl(char),
}

impl Key {
    /// The printable char, if any.
    pub fn char(self) -> Option<char> {
        match self {
            Key::Char(c) => Some(c),
            _ => None,
        }
    }
}
