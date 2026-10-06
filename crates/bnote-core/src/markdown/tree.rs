//! Port of `src/lib/tree.ts` — the file-tree model the sidebar and quick
//! switcher share. Pure traversal over [`FileNode`]; no IO.

/// One node of the file tree, mirroring the TS `FileNode` from
/// `src/lib/tauri.ts`. `children == None` means "directory not read yet"; an
/// empty `Some(vec![])` is a read, empty directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileNode {
    pub name: String,
    pub rel_path: String,
    pub kind: NodeKind,
    pub children: Option<Vec<FileNode>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    File,
    Dir,
}

impl FileNode {
    pub fn file(rel_path: &str) -> FileNode {
        FileNode {
            name: file_name(rel_path),
            rel_path: rel_path.to_string(),
            kind: NodeKind::File,
            children: None,
        }
    }

    pub fn dir(rel_path: &str, children: Option<Vec<FileNode>>) -> FileNode {
        FileNode {
            name: file_name(rel_path),
            rel_path: rel_path.to_string(),
            kind: NodeKind::Dir,
            children,
        }
    }
}

fn file_name(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[i + 1..].to_string(),
        None => path.to_string(),
    }
}

/// Port of `src/lib/tree.ts::flattenVisible` — visible rows in display order
/// (expanded folders traversed depth-first).
pub fn flatten_visible<'a>(tree: &'a [FileNode], expanded: &std::collections::HashSet<String>) -> Vec<&'a FileNode> {
    let mut out = Vec::new();
    fn walk<'a>(
        nodes: &'a [FileNode],
        expanded: &std::collections::HashSet<String>,
        out: &mut Vec<&'a FileNode>,
    ) {
        for n in nodes {
            out.push(n);
            if n.kind == NodeKind::Dir && expanded.contains(&n.rel_path) {
                if let Some(children) = &n.children {
                    walk(children, expanded, out);
                }
            }
        }
    }
    walk(tree, expanded, &mut out);
    out
}

/// Port of `src/lib/tree.ts::findNode` — recursive hit on a deep node,
/// `None` when missing (unread directories are opaque).
pub fn find_node<'a>(tree: &'a [FileNode], rel_path: &str) -> Option<&'a FileNode> {
    for n in tree {
        if n.rel_path == rel_path {
            return Some(n);
        }
        if n.kind == NodeKind::Dir {
            if let Some(children) = &n.children {
                if let Some(hit) = find_node(children, rel_path) {
                    return Some(hit);
                }
            }
        }
    }
    None
}

/// Port of `src/lib/tree.ts::chainLoadPlan`.
///
/// 把「rel_path 这一行露出来」拆成可重复求值的施工计划——纯函数,只看树现在长
/// 什么样,不看异步过程,所以可以每次树变化都重算一遍而不怕重复。
///
/// - `load`:已经进树、但子节点还没读的祖先目录,调用方去 loadDirChildren。
/// - `pending`:链上还有层没进树——树本身还没就绪(首帧、刚换库)。此时
///   「树里没有这一行」不构成「条目不存在」的证据,不能据此放弃露出请求。
///
/// 父层没进树时子层必然也找不到,所以一次遍历就够:父层读完后重算这一层
/// 自然会出现,收敛由树的更新驱动。
pub fn chain_load_plan(tree: &[FileNode], rel_path: &str) -> (Vec<String>, bool) {
    let mut load: Vec<String> = Vec::new();
    let mut pending = false;
    // ancestorDirs("a/b/c") → ["a", "a/b"] — root-first proper ancestors.
    let parts: Vec<&str> = rel_path.split('/').collect();
    for i in 1..parts.len() {
        let dir = parts[..i].join("/");
        match find_node(tree, &dir) {
            None => pending = true,
            Some(node) => {
                if node.kind == NodeKind::Dir && node.children.is_none() {
                    load.push(dir);
                }
            }
        }
    }
    (load, pending)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn tree() -> Vec<FileNode> {
        vec![
            FileNode::dir(
                "a",
                Some(vec![
                    FileNode::file("a/1.md"),
                    FileNode::dir("a/b", Some(vec![FileNode::file("a/b/2.md")])),
                ]),
            ),
            FileNode::file("z.md"),
        ]
    }

    #[test]
    fn only_expanded_dirs_expand_depth_first() {
        let t = tree();
        assert_eq!(
            flatten_visible(&t, &set(&[])).iter().map(|n| n.rel_path.as_str()).collect::<Vec<_>>(),
            ["a", "z.md"]
        );
        assert_eq!(
            flatten_visible(&t, &set(&["a"])).iter().map(|n| n.rel_path.as_str()).collect::<Vec<_>>(),
            ["a", "a/1.md", "a/b", "z.md"]
        );
        assert_eq!(
            flatten_visible(&t, &set(&["a", "a/b"])).iter().map(|n| n.rel_path.as_str()).collect::<Vec<_>>(),
            ["a", "a/1.md", "a/b", "a/b/2.md", "z.md"]
        );
    }

    #[test]
    fn unread_dir_does_not_expand_and_find_node_stops_there() {
        let unread = vec![FileNode::dir("a", None)];
        assert_eq!(
            flatten_visible(&unread, &set(&["a"])).iter().map(|n| n.rel_path.as_str()).collect::<Vec<_>>(),
            ["a"]
        );
        assert_eq!(find_node(&unread, "a").unwrap().children, None);
        assert!(find_node(&unread, "a/b").is_none());
    }

    #[test]
    fn find_node_recurses_deep_and_returns_none_when_missing() {
        let t = tree();
        assert_eq!(find_node(&t, "a/b/2.md").unwrap().kind, NodeKind::File);
        assert!(find_node(&t, "a/b/3.md").is_none());
    }

    #[test]
    fn chain_load_root_file_needs_nothing() {
        let t = vec![FileNode::file("z.md")];
        assert_eq!(chain_load_plan(&t, "z.md"), (vec![], false));
    }

    #[test]
    fn chain_load_all_ancestors_read_chain_complete() {
        let t = vec![FileNode::dir("a", Some(vec![FileNode::dir("a/b", Some(vec![]))]))];
        assert_eq!(chain_load_plan(&t, "a/b/2.md"), (vec![], false));
    }

    #[test]
    fn chain_load_unread_node_defers_to_caller_and_marks_pending() {
        let t = vec![FileNode::dir("a", None)];
        assert_eq!(
            chain_load_plan(&t, "a/b/2.md"),
            (vec!["a".to_string()], true)
        );
    }

    #[test]
    fn chain_load_missing_ancestor_is_pending_not_absent() {
        // 树还没就绪(首帧/刚换库):祖先不在树里 → pending,不许下「条目不存在」的结论
        assert_eq!(chain_load_plan(&[], "a/b/2.md"), (vec![], true));
        // 父层读完了,中间层还没进树:继续等,不是「文件没了」
        let t = vec![FileNode::dir("a", Some(vec![FileNode::file("a/1.md")]))];
        assert_eq!(chain_load_plan(&t, "a/b/2.md"), (vec![], true));
    }

    #[test]
    fn chain_load_order_is_driven_by_the_tree() {
        let before = vec![FileNode::dir("a", None)];
        assert_eq!(chain_load_plan(&before, "a/b/2.md").0, vec!["a".to_string()]);
        let after = vec![FileNode::dir("a", Some(vec![FileNode::dir("a/b", None)]))];
        assert_eq!(
            chain_load_plan(&after, "a/b/2.md"),
            (vec!["a/b".to_string()], false)
        );
    }
}
