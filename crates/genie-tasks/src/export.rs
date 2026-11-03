//! The machine-wide export `<GENIE_HOME>/tasks.jsonl`, one row per committed event, read by
//! usagemeter. Appends hold a shared lock on the `tasks.jsonl.lock` sidecar and write each row with
//! one `write(2)` on an `O_APPEND` descriptor; `rebuild` holds the lock exclusive, reads the events
//! only then, and replaces the file by temp + fsync + rename. The sidecar survives the rename,
//! which a lock on the data file would not. Locks are `std::fs::File` locks; no crate.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::store::{Error, Location, StoredEvent, locate, read_events};

pub const FILE: &str = "tasks.jsonl";
pub const LOCK: &str = "tasks.jsonl.lock";

/// The row agreed with usagemeter. Field order is the serialized order.
#[derive(Serialize)]
struct Row<'a> {
    v: u8,
    event: &'a str,
    project: &'a str,
    /// JSON null for a PR with no task id (M3); the dedupe framing still uses `''`.
    task: Option<&'a str>,
    branch: &'a str,
    forge: &'a str,
    url: &'a str,
    #[serde(rename = "type")]
    kind: &'a str,
    at: &'a str,
    commit: &'a str,
    lead: &'a str,
    counted: bool,
    exclude_reason: &'a str,
    pushed_after_open: i64,
    dedupe_key: &'a str,
}

/// The event's export row, newline-terminated.
pub fn line(e: &StoredEvent) -> String {
    let row = Row {
        v: 1,
        event: e.event.as_str(),
        project: &e.project,
        task: (!e.task.is_empty()).then_some(e.task.as_str()),
        branch: &e.branch,
        forge: &e.forge,
        url: &e.url,
        kind: &e.kind,
        at: &e.at,
        commit: &e.commit,
        lead: &e.lead,
        counted: e.counted,
        exclude_reason: &e.exclude_reason,
        pushed_after_open: e.pushed_after_open,
        dedupe_key: &e.dedupe_key,
    };
    let mut out = serde_json::to_string(&row).expect("a row of strings serializes");
    out.push('\n');
    out
}

fn lock_file(genie_home: &Path) -> io::Result<File> {
    fs::create_dir_all(genie_home)?;
    OpenOptions::new().read(true).write(true).create(true).truncate(false).open(genie_home.join(LOCK))
}

/// Append one row: one `write(2)` under the shared sidecar lock. A short write is an error.
pub fn append(genie_home: &Path, line: &str) -> io::Result<()> {
    let lock = lock_file(genie_home)?;
    lock.lock_shared()?;
    let mut file = OpenOptions::new().append(true).create(true).open(genie_home.join(FILE))?;
    let written = file.write(line.as_bytes())?;
    if written != line.len() {
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            format!("short write to {FILE}: {written} of {}", line.len()),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebuildReport {
    /// Each rebuilt project with the number of rows written for it.
    pub projects: Vec<(String, usize)>,
    /// Rows of other projects, kept as they were.
    pub kept: usize,
}

/// Rewrite the rows of the named projects from their `v7_task_events`, keeping every other row.
/// The projects are resolved (git) before the lock; their events are read only under it.
pub fn rebuild(genie_home: &Path, projects: &[PathBuf]) -> Result<RebuildReport, Error> {
    let mut located: Vec<Location> = Vec::new();
    for repo in projects {
        let loc = locate(repo, genie_home)?;
        if !located.iter().any(|l| l.project == loc.project) {
            located.push(loc);
        }
    }
    let lock = lock_file(genie_home)?;
    lock.lock()?;
    let mut rebuilt = String::new();
    let mut report = RebuildReport { projects: Vec::new(), kept: 0 };
    for loc in &located {
        let conn = Connection::open_with_flags(
            &loc.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(crate::store::BUSY_TIMEOUT)?;
        let events = read_events(&conn, &loc.project)?;
        report.projects.push((loc.project.clone(), events.len()));
        for e in &events {
            rebuilt.push_str(&line(e));
        }
    }
    let names: HashSet<&str> = located.iter().map(|l| l.project.as_str()).collect();
    let path = genie_home.join(FILE);
    let mut kept = String::new();
    match fs::read_to_string(&path) {
        Ok(text) => {
            for row in text.lines().filter(|l| !l.is_empty()) {
                let project = serde_json::from_str::<serde_json::Value>(row)
                    .ok()
                    .and_then(|v| v.get("project").and_then(|p| p.as_str()).map(str::to_owned));
                if project.as_deref().is_some_and(|p| names.contains(p)) {
                    continue;
                }
                kept.push_str(row);
                kept.push('\n');
                report.kept += 1;
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let tmp = genie_home.join(format!("{FILE}.tmp-{}-{nanos}", process::id()));
    let written = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(kept.as_bytes())?;
        file.write_all(rebuilt.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp, &path)?;
        File::open(genie_home)?.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(report)
}
