//! Local long-term memory and durable reflection inbox. No chat UI or network access here.
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager};

type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn init(db: &Connection) -> Result<()> {
    db.busy_timeout(Duration::from_secs(3)).map_err(err)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), migrated INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 0, dream_revision INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO state(id) VALUES(1);").map_err(err)
}
fn open(app: &AppHandle) -> Result<Connection> {
    let dir = app.path().app_data_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    let db = Connection::open(dir.join("assistant-memory.sqlite3")).map_err(err)?;
    init(&db)?;
    Ok(db)
}
fn put(tx: &Transaction, row: &Value) -> Result<()> {
    let id = row["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("记忆缺少编号")?;
    if !row["content"]
        .as_str()
        .is_some_and(|t| !t.trim().is_empty())
    {
        return Err("记忆内容为空".into());
    }
    tx.execute("INSERT INTO memory(id,body) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        params![id, row.to_string()]).map_err(err)?;
    Ok(())
}
fn migrate(db: &mut Connection, legacy: Vec<Value>) -> Result<()> {
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(err)?;
    let migrated: bool = tx
        .query_row("SELECT migrated FROM state", [], |r| r.get(0))
        .map_err(err)?;
    if !migrated {
        for row in legacy {
            put(&tx, &row)?;
        }
        tx.execute("UPDATE state SET migrated=1, revision=revision+1", [])
            .map_err(err)?;
    }
    tx.commit().map_err(err)
}
fn json_rows(db: &Connection, sql: &str) -> Result<Vec<Value>> {
    let mut stmt = db.prepare(sql).map_err(err)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
    rows.map(|r| serde_json::from_str(&r.map_err(err)?).map_err(err))
        .collect()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: i64,
    dream_revision: i64,
    entries: Vec<Value>,
}
fn snapshot(db: &mut Connection) -> Result<Snapshot> {
    let tx = db.transaction().map_err(err)?;
    let (revision, dream_revision) = tx
        .query_row("SELECT revision,dream_revision FROM state", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(err)?;
    let entries = json_rows(&tx, "SELECT body FROM memory ORDER BY rowid")?;
    tx.commit().map_err(err)?;
    Ok(Snapshot {
        revision,
        dream_revision,
        entries,
    })
}
#[derive(Serialize)]
pub struct Pending {
    id: i64,
    body: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    revision: i64,
    entries: Vec<Value>,
    done: Vec<i64>,
    dream: bool,
}
fn commit(db: &mut Connection, change: Change) -> Result<bool> {
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(err)?;
    let revision: i64 = tx
        .query_row("SELECT revision FROM state", [], |r| r.get(0))
        .map_err(err)?;
    if change.revision != revision {
        return Ok(false);
    }
    for id in change.done {
        if tx
            .execute("DELETE FROM inbox WHERE id=?1", [id])
            .map_err(err)?
            != 1
        {
            return Ok(false);
        }
    }
    let next = revision + i64::from(!change.entries.is_empty());
    for row in change.entries {
        put(&tx, &row)?;
    }
    if change.dream {
        tx.execute("UPDATE state SET revision=?1,dream_revision=?1", [next])
            .map_err(err)?;
    } else if next != revision {
        tx.execute("UPDATE state SET revision=?1", [next])
            .map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(true)
}

#[tauri::command]
pub async fn memory_load(app: AppHandle, legacy: Vec<Value>) -> Result<Snapshot> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut db = open(&app)?;
        migrate(&mut db, legacy)?;
        snapshot(&mut db)
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn memory_enqueue(app: AppHandle, body: Value) -> Result<i64> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = open(&app)?;
        db.execute("INSERT INTO inbox(body) VALUES(?1)", [body.to_string()])
            .map_err(err)?;
        Ok(db.last_insert_rowid())
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn memory_pending(app: AppHandle) -> Result<Vec<Pending>> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = open(&app)?;
        let mut stmt = db
            .prepare("SELECT id,body FROM inbox ORDER BY id LIMIT 6")
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get::<_, String>(1)?)))
            .map_err(err)?;
        rows.map(|r| {
            let (id, body) = r.map_err(err)?;
            Ok(Pending {
                id,
                body: serde_json::from_str(&body).map_err(err)?,
            })
        })
        .collect()
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn memory_pending_corrections(app: AppHandle) -> Result<Vec<Pending>> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = open(&app)?;
        let mut stmt = db
            .prepare("SELECT id,body FROM inbox WHERE json_extract(body,'$.intent')='correction'")
            .map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get::<_, String>(1)?)))
            .map_err(err)?;
        rows.map(|r| {
            let (id, body) = r.map_err(err)?;
            Ok(Pending {
                id,
                body: serde_json::from_str(&body).map_err(err)?,
            })
        })
        .collect()
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn memory_commit(app: AppHandle, change: Change) -> Result<bool> {
    tauri::async_runtime::spawn_blocking(move || commit(&mut open(&app)?, change))
        .await
        .map_err(err)?
}
pub fn clear_inbox(app: &AppHandle) -> Result<()> {
    open(app)?.execute("DELETE FROM inbox", []).map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn migrate_once_and_consume_inbox_atomically() {
        let mut db = Connection::open_in_memory().unwrap();
        init(&db).unwrap();
        migrate(
            &mut db,
            vec![json!({"id":"a","content":"旧事实","status":"archived"})],
        )
        .unwrap();
        migrate(&mut db, vec![json!({"id":"b","content":"不应再迁移"})]).unwrap();
        let start = snapshot(&mut db).unwrap();
        assert_eq!(start.entries.len(), 1);
        db.execute("INSERT INTO inbox(body) VALUES('{}')", [])
            .unwrap();
        let id = db.last_insert_rowid();
        assert!(!commit(
            &mut db,
            Change {
                revision: start.revision,
                entries: vec![],
                done: vec![id, id + 1],
                dream: false
            }
        )
        .unwrap());
        assert!(commit(
            &mut db,
            Change {
                revision: start.revision,
                entries: vec![json!({"id":"a","content":"新事实"})],
                done: vec![id],
                dream: false
            }
        )
        .unwrap());
        assert!(!commit(
            &mut db,
            Change {
                revision: start.revision,
                entries: vec![],
                done: vec![],
                dream: true
            }
        )
        .unwrap());
        let next = snapshot(&mut db).unwrap();
        assert_eq!(next.entries[0]["content"], "新事实");
        assert!(commit(
            &mut db,
            Change {
                revision: next.revision,
                entries: vec![],
                done: vec![],
                dream: true
            }
        )
        .unwrap());
        assert_eq!(snapshot(&mut db).unwrap().dream_revision, next.revision);
    }
}
