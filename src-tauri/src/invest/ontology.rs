//! The knowledge graph: entities, relations, mentions + one-hop queries.
//!
//! The model follows WeKnora's "a node carries the documents it came from"
//! (via `entity_mentions`) with the semantic-catalog framing of NVIDIA
//! auto-ontology: entities are typed, relations are typed and weighted, and
//! every query answer can be traced back to the document it came from.

use rusqlite::Connection;

use crate::invest::model::{Entity, GraphView, Relation};

pub fn ensure_entity(
    conn: &Connection,
    name: &str,
    kind: &str,
    scope: Option<&str>,
    description: &str,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO entities(name, type, scope, description, updated_at) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(name, type) DO UPDATE SET
           scope=COALESCE(excluded.scope, entities.scope),
           description=CASE WHEN excluded.description != '' THEN excluded.description ELSE entities.description END,
           updated_at=excluded.updated_at",
        rusqlite::params![name, kind, scope, description, now_secs()],
    )
    .map_err(|e| format!("DB_WRITE_FAILED: entity {}: {}", name, e))?;
    conn.query_row(
        "SELECT id FROM entities WHERE name=?1 AND type=?2",
        rusqlite::params![name, kind],
        |r| r.get(0),
    )
    .map_err(|e| format!("DB_QUERY_FAILED: entity {}: {}", name, e))
}

pub fn ensure_relation(
    conn: &Connection,
    src: i64,
    dst: i64,
    kind: &str,
    weight: f64,
    scope: &str,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO relations(src_id, dst_id, type, weight, scope) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(src_id, dst_id, type) DO UPDATE SET
           weight = relations.weight + 0.1",
        rusqlite::params![src, dst, kind, weight.clamp(0.0, 10.0), scope],
    )
    .map_err(|e| format!("DB_WRITE_FAILED: relation {}->{}: {}", src, dst, e))?;
    conn.query_row(
        "SELECT id FROM relations WHERE src_id=?1 AND dst_id=?2 AND type=?3",
        rusqlite::params![src, dst, kind],
        |r| r.get(0),
    )
    .map_err(|e| format!("DB_QUERY_FAILED: relation: {}", e))
}

/// Links an entity to the document it appeared in (the provenance edge).
pub fn mention(
    conn: &Connection,
    entity_id: i64,
    doc_id: i64,
    confidence: f64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO entity_mentions(entity_id, doc_id, confidence) VALUES (?1,?2,?3)
         ON CONFLICT(entity_id, doc_id) DO UPDATE SET confidence=excluded.confidence",
        rusqlite::params![entity_id, doc_id, confidence.clamp(0.0, 1.0)],
    )
    .map_err(|e| format!("DB_WRITE_FAILED: mention: {}", e))?;
    Ok(())
}

fn row_entity(r: &rusqlite::Row) -> rusqlite::Result<Entity> {
    Ok(Entity {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        scope: r.get(3)?,
        description: r.get(4)?,
    })
}

fn row_relation(r: &rusqlite::Row) -> rusqlite::Result<Relation> {
    Ok(Relation {
        id: r.get(0)?,
        src_id: r.get(1)?,
        dst_id: r.get(2)?,
        kind: r.get(3)?,
        weight: r.get(4)?,
        description: r.get(5)?,
    })
}

/// One-hop neighbourhood of an entity (by name + type), sorted by weight.
pub fn graph_view(conn: &Connection, name: &str, kind: &str) -> Result<Option<GraphView>, String> {
    let center: Option<Entity> = match conn.query_row(
        "SELECT id, name, type, scope, description FROM entities WHERE name=?1 AND type=?2",
        rusqlite::params![name, kind],
        row_entity,
    ) {
        Ok(entity) => Some(entity),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(format!("DB_QUERY_FAILED: {}", e)),
    };
    let Some(center) = center else {
        return Ok(None);
    };

    let mut stmt = conn
        .prepare(
            "SELECT id, src_id, dst_id, type, weight, description FROM relations
             WHERE src_id=?1 OR dst_id=?1 ORDER BY weight DESC LIMIT 50",
        )
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let rel_rows = stmt
        .query_map(rusqlite::params![center.id], row_relation)
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut relations = Vec::new();
    let mut neighbour_ids: Vec<i64> = Vec::new();
    for row in rel_rows {
        let rel = row.map_err(|e| format!("DB_READ_FAILED: {}", e))?;
        let other = if rel.src_id == center.id {
            rel.dst_id
        } else {
            rel.src_id
        };
        if !neighbour_ids.contains(&other) {
            neighbour_ids.push(other);
        }
        relations.push(rel);
    }

    let mut entities = vec![center.clone()];
    for id in &neighbour_ids {
        let e: Entity = conn
            .query_row(
                "SELECT id, name, type, scope, description FROM entities WHERE id=?1",
                rusqlite::params![id],
                row_entity,
            )
            .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
        entities.push(e);
    }
    Ok(Some(GraphView {
        center,
        entities,
        relations,
    }))
}

/// Documents where one entity was mentioned (provenance trace).
pub fn docs_of_entity(
    conn: &Connection,
    entity_id: i64,
    limit: usize,
) -> Result<Vec<crate::invest::model::DocInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT d.rel_path, d.scope, d.kind, d.title, d.mtime
             FROM entity_mentions m JOIN docs d ON d.id = m.doc_id
             WHERE m.entity_id=?1 ORDER BY d.mtime DESC LIMIT ?2",
        )
        .map_err(|e| format!("DB_PREPARE_FAILED: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params![entity_id, limit.clamp(1, 100)], |r| {
            Ok(crate::invest::model::DocInfo {
                rel_path: r.get(0)?,
                scope: r.get(1)?,
                kind: r.get(2)?,
                title: r.get(3)?,
                mtime: r.get(4)?,
            })
        })
        .map_err(|e| format!("DB_QUERY_FAILED: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("DB_READ_FAILED: {}", e))?);
    }
    Ok(out)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::invest::db;

    #[test]
    fn entities_relations_mentions_and_one_hop() {
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();

        let liquor = ensure_entity(&conn, "白酒", "concept", None, "白酒概念").unwrap();
        let maotai =
            ensure_entity(&conn, "贵州茅台", "instrument", Some("stock:600519"), "").unwrap();
        let wuliangye =
            ensure_entity(&conn, "五粮液", "instrument", Some("stock:000858"), "").unwrap();
        // Idempotent: re-ensure keeps one row.
        let again = ensure_entity(&conn, "贵州茅台", "instrument", None, "").unwrap();
        assert_eq!(maotai, again);

        ensure_relation(&conn, maotai, liquor, "belongs_to", 1.0, "stock:600519").unwrap();
        ensure_relation(&conn, wuliangye, liquor, "belongs_to", 1.0, "stock:000858").unwrap();
        ensure_relation(&conn, maotai, wuliangye, "peer", 0.5, "stock:600519").unwrap();

        // Register the doc the mentions came from.
        crate::invest::docs::index_doc(
            &conn,
            "stocks/600519/analysis.md",
            "stock:600519",
            "analysis",
            "茅台分析",
            "正文",
            1,
            "h",
        )
        .unwrap();
        let doc_id: i64 = conn
            .query_row(
                "SELECT id FROM docs WHERE rel_path='stocks/600519/analysis.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        mention(&conn, maotai, doc_id, 1.0).unwrap();
        mention(&conn, maotai, doc_id, 0.8).unwrap(); // idempotent update

        let view = graph_view(&conn, "贵州茅台", "instrument")
            .unwrap()
            .unwrap();
        assert_eq!(view.center.name, "贵州茅台");
        assert_eq!(view.entities.len(), 3, "center + 白酒 + 五粮液");
        assert_eq!(view.relations.len(), 2);

        let docs = docs_of_entity(&conn, maotai, 10).unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].rel_path, "stocks/600519/analysis.md");

        assert!(graph_view(&conn, "不存在", "instrument").unwrap().is_none());
    }
}
