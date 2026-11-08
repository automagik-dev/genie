//! Explicit, project-local attribution. Lifecycle identity stays immutable: unlink removes only
//! the overlay. Link events and lifecycle events share sequence order, not a state machine.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::export;
use crate::store::{Error, Listed, Store, StoredEvent};
use crate::{TaskState, VerbError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Pr(String),
    Branch(String),
}

impl Target {
    pub fn parts(&self) -> (&str, &str) {
        match self {
            Self::Pr(url) => (url, ""),
            Self::Branch(branch) => ("", branch),
        }
    }

    pub fn validate(&self) -> Result<(), VerbError> {
        let (url, branch) = self.parts();
        let value = if url.is_empty() { branch } else { url };
        if value.is_empty() || value.chars().any(char::is_whitespace) || value.chars().any(char::is_control) {
            return Err(VerbError::Refused(
                "link target must be nonempty and contain no whitespace or control bytes".into(),
            ));
        }
        if !url.is_empty()
            && (!url.starts_with("https://") && !url.starts_with("http://")
                || url.split('/').nth(2).is_none_or(|h| h.is_empty() || h.contains('@')))
        {
            return Err(VerbError::Refused("--pr needs an http(s) URL without credentials".into()));
        }
        Ok(())
    }
}

pub fn valid_id(id: &str) -> bool {
    let digits = ["gh-", "gl-", "gn-"].iter().find_map(|prefix| id.strip_prefix(prefix)).unwrap_or("");
    !digits.is_empty() && !digits.starts_with('0') && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Current bindings; a v1 database that has never been written by this build has none.
pub(crate) fn bindings(conn: &Connection, project: &str) -> Result<Bindings, Error> {
    let mut stmt = match conn.prepare("SELECT url, branch, task FROM v7_links WHERE project = ?1") {
        Ok(s) => s,
        Err(rusqlite::Error::SqliteFailure(_, Some(message))) if message.contains("no such table") => {
            return Ok(BTreeMap::new());
        }
        Err(e) => return Err(e.into()),
    };
    Ok(stmt.query_map([project], |r| Ok(((r.get(0)?, r.get(1)?), r.get(2)?)))?.collect::<rusqlite::Result<_>>()?)
}

type Bindings = BTreeMap<(String, String), String>;
type Branches = BTreeMap<String, BTreeSet<String>>;

fn attribution<'a>(links: &'a Bindings, branches: &Branches, url: &str, branch: &str) -> Option<&'a str> {
    let pr = links.get(&(url.to_string(), String::new()));
    let b = links.get(&(String::new(), branch.to_string()));
    match (pr, b) {
        (Some(p), Some(b)) if p != b => Some(""), // contradictory targets never guess
        (Some(p), _) => Some(p),
        (_, Some(_)) if branches.get(branch).is_some_and(|urls| urls.len() > 1) => Some(""),
        (_, Some(b)) => Some(b),
        _ => None,
    }
}

fn branches(rows: &[Listed]) -> Branches {
    let mut result = Branches::new();
    for t in rows.iter().map(|l| &l.row).filter(|t| !t.url.is_empty()) {
        result.entry(t.branch.clone()).or_default().insert(t.url.clone());
    }
    result
}

pub(crate) fn project(store: &Store, mut rows: Vec<Listed>) -> Result<Vec<Listed>, Error> {
    let links = bindings(&store.conn, store.project())?;
    if links.is_empty() {
        return Ok(rows);
    }
    let branches = branches(&rows);
    for listed in &mut rows {
        let t = &mut listed.row;
        if let Some(id) = attribution(&links, &branches, &t.url, &t.branch) {
            t.task = id.to_string();
        }
    }
    // A started card and its linked PR are one task; retain the PR's state and its stable key.
    let started: BTreeMap<_, _> = rows
        .iter()
        .filter(|l| l.row.state == TaskState::Created && l.row.url.is_empty())
        .map(|l| (l.row.task.clone(), l.clone()))
        .collect();
    let mut joined = BTreeSet::new();
    for row in rows.iter_mut().filter(|l| !l.row.url.is_empty() && !l.row.task.is_empty()) {
        if let Some(start) = started.get(&row.row.task) {
            joined.insert(row.row.task.clone());
            row.lifecycle.created_at.clone_from(&start.lifecycle.created_at);
            row.lifecycle.worktree.clone_from(&start.lifecycle.worktree);
            row.age_min = start.age_min;
            if row.row.lead.is_empty() {
                row.row.lead.clone_from(&start.row.lead);
            }
        }
    }
    rows.retain(|l| !(l.row.url.is_empty() && joined.contains(&l.row.task)));
    Ok(rows)
}

#[derive(Debug, Serialize)]
pub struct Changed {
    pub task: String,
    pub event: &'static str,
    pub url: String,
    pub branch: String,
    pub changed: bool,
}

fn refuse(message: impl Into<String>) -> VerbError {
    VerbError::Refused(message.into())
}

fn validate_request(store: &Store, id: &str, target: &Target, unlink: bool) -> Result<bool, VerbError> {
    let started = if id.starts_with("gn-") {
        match store.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM v7_task_events WHERE project = ?1 AND task_key = ?2 AND event = 'created')",
            params![store.project(), id],
            |r| r.get::<_, bool>(0),
        ) {
            Ok(found) => found,
            Err(rusqlite::Error::SqliteFailure(_, Some(message))) if message.contains("no such table") => false,
            Err(e) => return Err(Error::from(e).into()),
        }
    } else {
        true
    };
    if !started {
        return Err(refuse(format!("{id} was not started in project {}", store.project())));
    }
    let links = bindings(&store.conn, store.project())?;
    let (url, branch) = target.parts();
    let key = (url.to_string(), branch.to_string());
    let current = links.get(&key);
    if let Some(other) = current.filter(|other| other.as_str() != id) {
        return Err(refuse(format!("target is linked to {other}; unlink {other} first")));
    }
    if unlink {
        return Ok(current.is_some());
    }
    if current.is_some() {
        return Ok(false);
    }
    let rows = store.raw_listed()?;
    let matching: Vec<_> =
        rows.iter().filter(|l| if url.is_empty() { l.row.branch == branch } else { l.row.url == url }).collect();
    if url.is_empty()
        && matching.iter().filter(|l| !l.row.url.is_empty()).map(|l| &l.row.url).collect::<BTreeSet<_>>().len() > 1
    {
        return Err(refuse("branch is reused by multiple PRs; link a specific --pr URL"));
    }
    for row in matching {
        let t = &row.row;
        let peer_key = if url.is_empty() { (t.url.clone(), String::new()) } else { (String::new(), t.branch.clone()) };
        if let Some(other) = links.get(&peer_key).filter(|other| other.as_str() != id) {
            return Err(refuse(format!("target is linked to {other}; unlink {other} first")));
        }
    }
    Ok(current.is_none())
}

/// Refuse or complete a no-op through a read handle before any schema installation/migration.
/// The write transaction rechecks the request, so concurrent link changes still cannot overwrite.
pub fn change_at(project: &Path, home: &Path, id: &str, target: &Target, unlink: bool) -> Result<Changed, VerbError> {
    if !valid_id(id) {
        return Err(refuse(format!("malformed task id '{id}'; expected gh-N, gl-N or gn-N")));
    }
    target.validate()?;
    let read = crate::store::open_store_read_at(project, home)?;
    if !validate_request(&read, id, target, unlink)? {
        let (url, branch) = target.parts();
        return Ok(Changed {
            task: id.into(),
            event: if unlink { "unlink" } else { "link" },
            url: url.into(),
            branch: branch.into(),
            changed: false,
        });
    }
    drop(read);
    let write = crate::open_store_at(project, home)?;
    change(&write, id, target, unlink)
}

/// Idempotent changes; conflicts refuse inside BEGIN IMMEDIATE before any event/projection write.
pub fn change(store: &Store, id: &str, target: &Target, unlink: bool) -> Result<Changed, VerbError> {
    if !valid_id(id) {
        return Err(refuse(format!("malformed task id '{id}'; expected gh-N, gl-N or gn-N")));
    }
    target.validate()?;
    let (url, branch) = target.parts();
    let event = if unlink { "unlink" } else { "link" };
    store.conn.execute_batch("BEGIN IMMEDIATE").map_err(Error::from)?;
    let result = (|| -> Result<Option<LinkEvent>, VerbError> {
        if !validate_request(store, id, target, unlink)? {
            return Ok(None);
        }
        let seq = next_seq(&store.conn)?;
        let at = store.clock.now();
        let framed = [store.project(), id, event, url, branch, &seq.to_string()].join("\0");
        let dedupe_key: String = Sha256::digest(framed.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        store.conn.execute("INSERT INTO v7_link_events (seq, project, task, event, url, branch, at, dedupe_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)", params![seq, store.project(), id, event, url, branch, at, dedupe_key]).map_err(Error::from)?;
        if unlink {
            store
                .conn
                .execute(
                    "DELETE FROM v7_links WHERE project = ?1 AND url = ?2 AND branch = ?3",
                    params![store.project(), url, branch],
                )
                .map_err(Error::from)?;
        } else {
            store
                .conn
                .execute(
                    "INSERT INTO v7_links (project, url, branch, task) VALUES (?1, ?2, ?3, ?4)",
                    params![store.project(), url, branch, id],
                )
                .map_err(Error::from)?;
        }
        Ok(Some(LinkEvent {
            seq,
            project: store.project().into(),
            task: id.into(),
            event: event.into(),
            url: url.into(),
            branch: branch.into(),
            at,
            dedupe_key,
        }))
    })();
    let stored = match result {
        Ok(stored) => match store.conn.execute_batch("COMMIT") {
            Ok(()) => stored,
            Err(e) => {
                let _ = store.conn.execute_batch("ROLLBACK");
                return Err(Error::from(e).into());
            }
        },
        Err(e) => {
            let _ = store.conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    };
    if let Some(e) = &stored {
        export::append(store.genie_home(), &e.line()).map_err(|source| Error::Export { seq: e.seq, source })?;
    }
    Ok(Changed { task: id.into(), event, url: url.into(), branch: branch.into(), changed: stored.is_some() })
}

pub(crate) fn next_seq(conn: &Connection) -> Result<i64, Error> {
    Ok(conn.query_row("SELECT max(coalesce((SELECT max(seq) FROM v7_task_events), 0), coalesce((SELECT max(seq) FROM v7_link_events), 0)) + 1", [], |r| r.get(0))?)
}

pub(crate) struct LinkEvent {
    pub seq: i64,
    project: String,
    task: String,
    event: String,
    url: String,
    branch: String,
    at: String,
    dedupe_key: String,
}

impl LinkEvent {
    pub(crate) fn line(&self) -> String {
        format!(
            "{}\n",
            serde_json::json!({"v": 1, "seq": self.seq, "event": self.event, "project": self.project, "task": self.task, "original_task": null, "branch": self.branch, "forge": "", "url": self.url, "type": "", "at": self.at, "commit": "", "lead": "", "counted": false, "exclude_reason": "attribution", "pushed_after_open": null, "dedupe_key": self.dedupe_key})
        )
    }
}

pub(crate) fn read_links(conn: &Connection, project: &str) -> Result<Vec<LinkEvent>, Error> {
    let exists: Option<String> = conn
        .query_row("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'v7_link_events'", [], |r| r.get(0))
        .optional()?;
    if exists.is_none() {
        return Ok(vec![]);
    }
    let mut stmt = conn.prepare("SELECT seq, project, task, event, url, branch, at, dedupe_key FROM v7_link_events WHERE project = ?1 ORDER BY seq")?;
    Ok(stmt
        .query_map([project], |r| {
            Ok(LinkEvent {
                seq: r.get(0)?,
                project: r.get(1)?,
                task: r.get(2)?,
                event: r.get(3)?,
                url: r.get(4)?,
                branch: r.get(5)?,
                at: r.get(6)?,
                dedupe_key: r.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Rebuild uses the same historical order as appends. A link event changes attribution for prior
/// PR rows in a consumer's replay; it does not retroactively rewrite their lifecycle evidence.
pub(crate) fn export_lines(conn: &Connection, project: &str, events: Vec<StoredEvent>) -> Result<Vec<String>, Error> {
    enum Event {
        Life(StoredEvent),
        Link(LinkEvent),
    }
    let mut ordered = BTreeMap::new();
    for e in events {
        ordered.insert(e.seq, Event::Life(e));
    }
    for e in read_links(conn, project)? {
        ordered.insert(e.seq, Event::Link(e));
    }
    let mut links = Bindings::new();
    let mut branches = Branches::new();
    let mut lines = Vec::new();
    for event in ordered.into_values() {
        match event {
            Event::Link(e) => {
                let key = (e.url.clone(), e.branch.clone());
                if e.event == "unlink" {
                    links.remove(&key);
                } else {
                    links.insert(key, e.task.clone());
                }
                lines.push(e.line());
            }
            Event::Life(e) => {
                if !e.url.is_empty() {
                    branches.entry(e.branch.clone()).or_default().insert(e.url.clone());
                }
                lines.push(export::attributed_line(&e, attribution(&links, &branches, &e.url, &e.branch)));
            }
        }
    }
    Ok(lines)
}

pub(crate) fn lifecycle_line(store: &Store, e: &StoredEvent) -> Result<String, Error> {
    let links = bindings(&store.conn, store.project())?;
    if links.is_empty() {
        return Ok(export::line(e));
    }
    let mut branches = Branches::new();
    let mut stmt =
        store.conn.prepare("SELECT DISTINCT url FROM v7_tasks WHERE project = ?1 AND branch = ?2 AND url != ''")?;
    let urls = stmt
        .query_map(params![store.project(), e.branch], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    branches.insert(e.branch.clone(), urls);
    Ok(export::attributed_line(e, attribution(&links, &branches, &e.url, &e.branch)))
}
