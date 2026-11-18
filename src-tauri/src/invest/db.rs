//! The invest mode's local SQLite database.
//!
//! One file per vault: `<vault>/.bnote/invest/invest.db`. WAL + a busy
//! timeout + foreign keys; the schema below is idempotent (`CREATE TABLE IF
//! NOT EXISTS`), so opening an older vault never fails and re-running the
//! migration is a no-op.
//!
//! The connection lives in `AppState::invest_db` behind a std Mutex. The
//! discipline mirrors the rest of AppState (AGENTS.md Rust rule 5): a command
//! locks briefly, clones what it needs or runs one bounded query, and never
//! holds the guard across network work or `.await` points. The ingest and
//! backtest runners therefore read their inputs into memory first and only
//! re-lock to write results.

use std::path::Path;

use rusqlite::Connection;

/// The shared connection handle every invest caller holds (`AppState::invest_db`).
pub type Db = std::sync::Arc<std::sync::Mutex<Option<Connection>>>;

/// Runs one synchronous closure against the shared connection — the single
/// owner of the lock discipline (short lock, never across `.await` or
/// network work). Tests, `db_task` in `commands/invest.rs` and the tool
/// paths all funnel through here so the guard's lifetime rule lives in
/// exactly one place.
pub fn with_conn<T>(
    db: &Db,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let guard = db
        .lock()
        .map_err(|_| "LOCK_FAILED: invest db mutex poisoned".to_string())?;
    match guard.as_ref() {
        Some(conn) => f(conn),
        None => Err("NO_VAULT: the invest database opens with the vault".to_string()),
    }
}

/// Opens (creating when missing) the invest database and applies the schema.
pub fn open(db_path: &Path) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("WRITE_FAILED: {} ({})", parent.display(), e))?;
    }
    let conn = Connection::open(db_path)
        .map_err(|e| format!("DB_OPEN_FAILED: {} ({})", db_path.display(), e))?;
    // One writer at a time; WAL keeps readers cheap and the busy timeout
    // absorbs the brief contention between the UI thread and the ingest run.
    // A vault on an external volume (exFAT/NTFS) has no POSIX mmap locks, so
    // WAL may fail there — degrade to the rollback journal instead of
    // refusing to open (the busy timeout still serializes the writers).
    if let Err(_e) = conn.pragma_update(None, "journal_mode", "WAL") {
        let _ = conn.pragma_update(None, "journal_mode", "TRUNCATE");
    }
    conn.pragma_update(None, "busy_timeout", 5000)
        .map_err(|e| format!("DB_PRAGMA_FAILED: {}", e))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("DB_PRAGMA_FAILED: {}", e))?;
    migrate(&conn)?;
    Ok(conn)
}

/// The full schema. Every statement is idempotent so the migration is safe to
/// run on every open (no version table: the volume of schema here is small
/// and local-first evolution rewrites the file, cf. hoshi's IF NOT EXISTS
/// discipline).
pub fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("DB_MIGRATE_FAILED: {}", e))?;
    add_column_if_missing(conn, "backtests", "trades", "TEXT NOT NULL DEFAULT '[]'")?;
    // E24: the quote limit/amplitude columns arrived after the first schema.
    for (column, decl) in [
        ("limit_up", "REAL"),
        ("limit_down", "REAL"),
        ("amplitude", "REAL"),
        ("volume_ratio", "REAL"),
        ("currency", "TEXT"),
    ] {
        add_column_if_missing(conn, "snapshots", column, decl)?;
    }
    dedupe_forecasts(conn)?;
    Ok(())
}

/// D21 (blind test Q-P1-10): replaying the same window twice must not double
/// count in the accuracy stats — keep the newest row per
/// (scope, skill_version, as_of, target_date, mode) and enforce it with a
/// unique index, so `record` can upsert instead of blind-inserting.
fn dedupe_forecasts(conn: &Connection) -> Result<(), String> {
    let indexed: bool = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_forecasts_unique'")
        .and_then(|mut stmt| stmt.exists([]))
        .map_err(|e| format!("DB_MIGRATE_FAILED: {}", e))?;
    if indexed {
        return Ok(());
    }
    conn.execute_batch(
        "DELETE FROM forecasts WHERE id NOT IN (
             SELECT MAX(id) FROM forecasts
             GROUP BY scope, skill_version, as_of, target_date, mode);",
    )
    .map_err(|e| format!("DB_MIGRATE_FAILED: dedupe forecasts: {}", e))?;
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_forecasts_unique
             ON forecasts(scope, skill_version, as_of, target_date, mode);",
    )
    .map_err(|e| format!("DB_MIGRATE_FAILED: unique forecasts: {}", e))
}

/// Adds a column when an older vault's DB predates it. `CREATE TABLE IF NOT
/// EXISTS` never alters an existing table, so the additive migrations go
/// through here; a duplicate-column error from a concurrent migration is
/// treated as done.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> Result<(), String> {
    let exists: bool = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut stmt| {
            stmt.query_map([], |r| r.get::<_, String>(1))
                .map(|rows| rows.filter_map(Result::ok).any(|name| name == column))
        })
        .map_err(|e| format!("DB_MIGRATE_FAILED: {}: {}", table, e))?;
    if exists {
        return Ok(());
    }
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {decl}");
    conn.execute_batch(&sql)
        .map_err(|e| format!("DB_MIGRATE_FAILED: {}: {}", sql, e))
}

const SCHEMA: &str = r#"
-- 标的主数据（hoshi stock_master 的对应物；A股以 6 位代码为主键之一）
CREATE TABLE IF NOT EXISTS instruments (
  code TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'cn',
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  sector_code TEXT,
  sector_sub TEXT,
  kind TEXT NOT NULL DEFAULT 'stock',
  note TEXT NOT NULL DEFAULT '',
  watch INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (market, code)
);
CREATE INDEX IF NOT EXISTS idx_instruments_industry ON instruments(industry);
CREATE INDEX IF NOT EXISTS idx_instruments_name ON instruments(name);

-- 日 K 线（volume 量纲：存“股”；展示层 CN ÷100 为“手”，见 DESIGN.md §3）
CREATE TABLE IF NOT EXISTS kline_daily (
  market TEXT NOT NULL, code TEXT NOT NULL, ts TEXT NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume REAL NOT NULL, amount REAL,
  source TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (market, code, ts)
);
CREATE INDEX IF NOT EXISTS idx_kline_daily_recent ON kline_daily(market, code, ts DESC);

-- 板块（默认骨架：申万一级行业；概念板块由导入扩充）
CREATE TABLE IF NOT EXISTS sectors (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  parent TEXT,
  summary TEXT NOT NULL DEFAULT ''
);

-- 板块日 K 线（板块指数）
CREATE TABLE IF NOT EXISTS sector_kline_daily (
  code TEXT NOT NULL, ts TEXT NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume REAL NOT NULL, amount REAL,
  PRIMARY KEY (code, ts)
);

-- 标的快照（最新行情，腾讯源字段子集）
CREATE TABLE IF NOT EXISTS snapshots (
  market TEXT NOT NULL, code TEXT NOT NULL,
  price REAL, prev_close REAL, open REAL, high REAL, low REAL,
  volume REAL, amount REAL, turnover REAL,
  pe REAL, pb REAL, market_cap REAL, float_cap REAL,
  limit_up REAL, limit_down REAL, amplitude REAL, volume_ratio REAL,
  currency TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (market, code)
);

-- 资金流（新浪 moneyflow 字段子集，按日）
CREATE TABLE IF NOT EXISTS fund_flow (
  market TEXT NOT NULL, code TEXT NOT NULL, date TEXT NOT NULL,
  close REAL, change_ratio REAL, turnover REAL,
  net_amount REAL, net_ratio REAL, main_net REAL, main_ratio REAL,
  PRIMARY KEY (market, code, date)
);

-- 财务摘要（hoshi 15 指标精选，报告期维度；扩展字段放 data JSON）
CREATE TABLE IF NOT EXISTS financials (
  market TEXT NOT NULL, code TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL, fiscal_period TEXT NOT NULL,
  revenue REAL, revenue_yoy REAL, net_profit REAL, net_profit_yoy REAL,
  deduct_profit REAL, op_cashflow REAL, eps REAL,
  gross_margin REAL, net_margin REAL, roe REAL, roa REAL,
  debt_ratio REAL, current_ratio REAL,
  data TEXT,
  PRIMARY KEY (market, code, fiscal_year, fiscal_period)
);

-- 事件流（摄取管线沉淀的结构化事件）
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  sentiment TEXT,
  dedup_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(scope, dedup_hash)
);
CREATE INDEX IF NOT EXISTS idx_events_scope_date ON events(scope, date DESC);

-- 文档索引（Markdown 本体在文件夹里，这里是索引与作用域登记）
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_path TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  file_hash TEXT NOT NULL,
  indexed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_docs_scope ON docs(scope, kind);

-- 检索平面：FTS5 contentless（WeKnora 的 CJK bigram 方案：unicode61 + 应用层 bigram）
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, body, content='', contentless_delete=1, tokenize='unicode61'
);

-- 本体：实体 / 关系 / 提及（WeKnora“节点挂文档” + auto-ontology 语义目录）
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  scope TEXT,
  description TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(name, type)
);
CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  description TEXT NOT NULL DEFAULT '',
  scope TEXT,
  UNIQUE(src_id, dst_id, type)
);
CREATE TABLE IF NOT EXISTS entity_mentions (
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  confidence REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (entity_id, doc_id)
);

-- 预测记录（Skill 回放/实盘输出；hard/soft/score 见 forecast.rs）
CREATE TABLE IF NOT EXISTS forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  as_of TEXT NOT NULL,
  target_date TEXT NOT NULL,
  direction TEXT NOT NULL,
  expected_move REAL,
  confidence REAL NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  actual_direction TEXT, actual_move REAL,
  score REAL,
  mode TEXT NOT NULL DEFAULT 'replay',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forecasts_scope ON forecasts(scope, target_date DESC);

-- 回测运行记录
CREATE TABLE IF NOT EXISTS backtests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  skill_version TEXT,
  strategy TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  metrics TEXT NOT NULL,
  equity TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 预设的申万一级行业骨架（2021 版 31 个，业界通行的 A 股行业分类）。
-- INSERT OR IGNORE：用户对板块的改动不会被覆盖。
INSERT OR IGNORE INTO sectors(code, name, level) VALUES
  ('801010','农林牧渔',1),('801030','基础化工',1),('801040','钢铁',1),
  ('801050','有色金属',1),('801080','电子',1),('801110','家用电器',1),
  ('801120','食品饮料',1),('801130','纺织服饰',1),('801140','轻工制造',1),
  ('801150','医药生物',1),('801160','公用事业',1),('801170','交通运输',1),
  ('801180','房地产',1),('801200','商贸零售',1),('801210','社会服务',1),
  ('801230','综合',1),('801710','建筑材料',1),('801720','建筑装饰',1),
  ('801730','电力设备',1),('801740','国防军工',1),('801750','计算机',1),
  ('801760','传媒',1),('801770','通信',1),('801780','银行',1),
  ('801790','非银金融',1),('801880','汽车',1),('801890','机械设备',1),
  ('801950','煤炭',1),('801960','石油石化',1),('801970','环保',1),
  ('801980','美容护理',1);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_is_idempotent_and_complete() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // Running it twice must not fail (the INSERT OR IGNORE seed row keeps
        // its primary key and every CREATE TABLE IF NOT EXISTS is a no-op).
        migrate(&conn).unwrap();

        let count: i64 = conn
            .query_row("SELECT count(*) FROM sectors", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 31,
            "the seeded sector skeleton has all 31 SW industries"
        );
    }

    /// The ALTER branch is the only path an older vault ever takes: its tables
    /// already exist, so every CREATE TABLE IF NOT EXISTS is a no-op and the
    /// missing columns must come from add_column_if_missing. A fresh
    /// in-memory schema exercises none of it (the E24 columns already exist),
    /// which is exactly how the shipped `add_column_if_missing` went
    /// untested for its whole life.
    #[test]
    fn a_pre_e24_library_gains_its_columns_and_keeps_its_rows() {
        let conn = Connection::open_in_memory().unwrap();
        // The E24-era snapshots table: no limit/amplitude/volume_ratio/currency.
        conn.execute_batch(
            "CREATE TABLE snapshots (
                 market TEXT NOT NULL, code TEXT NOT NULL,
                 price REAL, fetched_at INTEGER NOT NULL,
                 PRIMARY KEY (market, code)
             );
             CREATE TABLE backtests (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 scope TEXT NOT NULL, skill_version TEXT NOT NULL,
                 as_of TEXT NOT NULL, target_date TEXT NOT NULL,
                 mode TEXT NOT NULL, started_at INTEGER NOT NULL,
                 summary TEXT
             );
             INSERT INTO snapshots VALUES ('cn', '600519', 1500.0, 100);
             INSERT INTO backtests (scope, skill_version, as_of, target_date, mode, started_at)
                 VALUES ('stock:cn:600519', 'v1', '2026-01-01', '2026-01-02', 'ma_cross', 1);",
        )
        .unwrap();

        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // the ALTER branch is idempotent too

        let columns: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(snapshots)").unwrap();
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .filter_map(Result::ok);
            rows.collect()
        };
        for column in [
            "limit_up",
            "limit_down",
            "amplitude",
            "volume_ratio",
            "currency",
        ] {
            assert!(columns.contains(&column.to_string()), "missing {column}");
        }
        // NOT NULL DEFAULT applies to the pre-existing rows, and they survive.
        let trades: String = conn
            .query_row("SELECT trades FROM backtests", [], |r| r.get(0))
            .unwrap();
        assert_eq!(trades, "[]");
        let currencies: i64 = conn
            .query_row(
                "SELECT count(*) FROM snapshots WHERE currency IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(currencies, 1, "the pre-E24 row is still there");
    }

    /// Replaying a window twice must not double count: migrate collapses
    /// duplicate forecast rows (newest id wins) and installs the unique
    /// index that lets `record` upsert.
    #[test]
    fn migrate_dedupes_duplicate_forecast_rows_and_installs_the_unique_index() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        // Simulate the pre-D21 library: duplicates on disk, no unique index.
        conn.execute_batch(
            "DROP INDEX idx_forecasts_unique;
             INSERT INTO forecasts (scope, skill_version, as_of, target_date, direction, confidence, mode, created_at)
                 VALUES ('stock:cn:600519', 'v1', '2026-01-01', '2026-01-02', 'up', 0.6, 'replay', 1),
                        ('stock:cn:600519', 'v1', '2026-01-01', '2026-01-02', 'up', 0.6, 'replay', 2),
                        ('stock:cn:600519', 'v1', '2026-01-01', '2026-01-03', 'up', 0.6, 'replay', 3);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM forecasts
                  WHERE scope='stock:cn:600519' AND target_date='2026-01-02'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "the duplicate pair collapses to the newest row");
        let kept_id: i64 = conn
            .query_row(
                "SELECT id FROM forecasts WHERE scope='stock:cn:600519' AND target_date='2026-01-02'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            kept_id, 2,
            "the newest row survives, the older one is dropped"
        );
        // The upsert path (record) can now run without a constraint error.
        let indexed: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_forecasts_unique')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(indexed);
    }
}
