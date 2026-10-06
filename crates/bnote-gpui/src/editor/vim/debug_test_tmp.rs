#![cfg(test)]
#[test]
fn probe_all() {
    use crate::editor::vim::core::ops::CursorPlan;
    use crate::editor::vim::core::exec::feed;
    use crate::editor::vim::core::ops::{HostContext, Outcome};
    use crate::editor::vim::core::VimState;
    use crate::editor::vim::core::key::Key;

    fn run(doc: &str, cursor: usize, keys: &str) -> (String, usize, String) {
        let mut text = doc.to_string();
        let mut st = VimState::new();
        let mut cur = cursor;
        for k in keys.chars().map(Key::Char) {
            let ctx = HostContext { cursor: cur, ..Default::default() };
            let out = feed(&mut st, &text, k, &ctx);
            if let Outcome::Executed(e) = out {
                for edit in e.edits.iter().rev() { text.replace_range(edit.range.clone(), &edit.text); }
                match e.cursor {
                    Some(CursorPlan::Collapse(p)) => { cur = p.min(text.len()); st.mode = e.mode_after.unwrap_or(st.mode); }
                    Some(CursorPlan::Select { anchor, head }) => { cur = head.min(text.len()); st.mode = e.mode_after.unwrap_or(st.mode); let _ = anchor; }
                    None => {}
                }
            }
        }
        (text, cur, format!("{:?}", st.mode))
    }

    let doc = "a\nb\n\nc";
    println!("doc len = {} bytes", doc.len());
    println!("}} from 0: {:?}", run(doc, 0, "}"));
    println!("}}}} from 0: {:?}", run(doc, 0, "}}"));
    println!("{{ from 6: {:?}", run(doc, 6, "{"));
    println!("{{{{ from 6: {:?}", run(doc, 6, "{{"));
    println!("k from 7 (foo/  bar): {:?}", run("foo\n  bar", 7, "k"));
    println!("space from 3 (ab//cd): {:?}", run("ab\n\ncd", 3, " "));
    println!("fX;; from 0: {:?}", run("aXbXcX", 0, "fX;;"));
    println!("g_ from 10: {:?}", run("  foo   bar", 10, "g_"));
    println!("w from 3 (foo.bar): {:?}", run("foo.bar", 3, "w"));
    println!("rx from 0: {:?}", run("abc", 0, "rx"));
    println!("3rz from 0: {:?}", run("abc", 0, "3rz"));
    println!("daw from 6: {:?}", run("foo   bar", 6, "daw"));
    println!("daw from 4 (foo bar baz): {:?}", run("foo bar baz", 4, "daw"));
    println!("di( from 7: {:?}", run("f(a, (bc), d)", 7, "di("));
    println!("da( from 7: {:?}", run("f(a, (bc), d)", 7, "da("));
    println!("d2iw from 4: {:?}", run("foo bar baz qux", 4, "d2iw"));
    println!("dw lastword: {:?}", run("foo bar\nbaz", 4, "dw"));
    println!("2dw: {:?}", run("foo bar baz", 0, "2dw"));
    println!("d2w: {:?}", run("foo bar baz", 0, "d2w"));
    println!("2d3w: {:?}", run("foo bar baz", 0, "2d3w"));
    println!("guw: {:?}", run("ABC DEF", 0, "guw"));
    println!("g~~: {:?}", run("aBc", 0, "g~~"));
    println!("yyp: {:?}", run("foo bar", 0, "yyp"));
    println!("yy cursor: {:?}", run("foo\nbar", 0, "yy"));
    println!("yh3p: {:?}", run("hi", 1, "yh3p"));
    println!("J foo/bar: {:?}", run("foo\nbar", 3, "J"));
    println!("J trailing: {:?}", run("foo \nbar", 4, "J"));
    println!("vjJ: {:?}", run("a\nb\nc", 3, "vjJ"));
    println!("vw r X: {:?}", run("f(oob)r", 3, "vwrX"));
    println!("vhd from 7: {:?}", run("foo bar baz", 7, "vhd"));
    println!("viwd: {:?}", run("foo bar baz", 4, "viwd"));
    println!("cycle: {:?}", run("the quick brown fox", 0, "yiwwdwP"));
    println!("numbered: {:?}", run("l1\nl2\nl3", 0, "dd\"1p"));
}
