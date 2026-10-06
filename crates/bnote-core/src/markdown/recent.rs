//! Port of `src/vault/recent.ts` — the recent-vaults MRU model (modeled after
//! zed's recent projects: dedupe by identity key, filter the current entry on
//! read). Pure functions, inputs untouched.
//!
//! The identity key is the canonicalized path string the backend
//! `set_vault` command produces — no second normalization here.

/// 硬上限:config.json 是单个 JSON,超出就丢最旧的(zed 无上限、靠 GC;这里列表小,cap 足够)。
pub const RECENT_VAULTS_CAP: usize = 10;

/// 打开/切换到某个仓库:提到队首,同路径去重,超出上限丢尾部。纯函数,不改入参。
/// Port of `src/vault/recent.ts::touchRecentVault`.
pub fn touch_recent_vault(list: &[String], path: &str) -> Vec<String> {
    if path.is_empty() {
        return list.to_vec();
    }
    let mut out: Vec<String> = Vec::with_capacity(list.len() + 1);
    out.push(path.to_string());
    out.extend(list.iter().filter(|p| p.as_str() != path).cloned());
    out.truncate(RECENT_VAULTS_CAP);
    out
}

/// Port of `src/vault/recent.ts::recentVaultTarget`.
///
/// 切换目标:MRU 里第一个非当前仓的路径。当前仓不写入而是读取时过滤
/// (zed 同款),列表里始终保留它——两仓来回 toggle 才成立。空列表、或只有
/// 当前仓时返回 None;未开仓(current 为 None)时返回最近一个,从欢迎页一键
/// 回到上次仓库。
pub fn recent_vault_target(list: &[String], current: Option<&str>) -> Option<String> {
    list.iter()
        .find(|p| Some(p.as_str()) != current && !p.is_empty())
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn l(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn new_path_goes_to_front() {
        assert_eq!(
            touch_recent_vault(&l(&["/a", "/b"]), "/c"),
            l(&["/c", "/a", "/b"])
        );
    }

    #[test]
    fn duplicate_path_dedupes_and_moves_to_front() {
        assert_eq!(
            touch_recent_vault(&l(&["/a", "/b", "/c"]), "/b"),
            l(&["/b", "/a", "/c"])
        );
    }

    #[test]
    fn over_cap_drops_the_oldest_tail() {
        let full: Vec<String> = (0..RECENT_VAULTS_CAP).map(|i| format!("/v{i}")).collect();
        let next = touch_recent_vault(&full, "/new");
        assert_eq!(next.len(), RECENT_VAULTS_CAP);
        assert_eq!(next[0], "/new");
        assert!(!next.contains(&"/v9".to_string()));
        assert!(next.contains(&"/v0".to_string()));
    }

    #[test]
    fn empty_path_never_enters_the_list() {
        assert_eq!(touch_recent_vault(&l(&["/a"]), ""), l(&["/a"]));
    }

    #[test]
    fn pure_function_input_untouched() {
        let list = l(&["/a", "/b"]);
        let _ = touch_recent_vault(&list, "/a");
        assert_eq!(list, l(&["/a", "/b"]));
    }

    #[test]
    fn target_is_first_entry_that_is_not_current() {
        assert_eq!(recent_vault_target(&l(&["/a", "/b"]), Some("/x")), Some("/a".into()));
    }

    #[test]
    fn current_at_front_is_skipped_two_vault_toggle() {
        assert_eq!(recent_vault_target(&l(&["/a", "/b"]), Some("/a")), Some("/b".into()));
        assert_eq!(recent_vault_target(&l(&["/b", "/a"]), Some("/a")), Some("/b".into()));
    }

    #[test]
    fn only_current_returns_none() {
        assert_eq!(recent_vault_target(&l(&["/a"]), Some("/a")), None);
    }

    #[test]
    fn empty_list_returns_none() {
        assert_eq!(recent_vault_target(&l(&[]), Some("/a")), None);
        assert_eq!(recent_vault_target(&l(&[]), None), None);
    }

    #[test]
    fn no_current_vault_returns_the_most_recent() {
        assert_eq!(recent_vault_target(&l(&["/a", "/b"]), None), Some("/a".into()));
    }
}
