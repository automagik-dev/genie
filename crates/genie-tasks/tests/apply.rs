//! T3: the transition table, the derived lanes, and a repeated identical event as a no-op.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use genie_tasks::{EventRow, FixedClock, Lane, Recorded, TaskEvent as E, TaskState as S, apply, open_store_at, record};

const NOW: &str = "2026-11-03T04:20:05Z";

fn run(from: Option<S>, event: E) -> Result<S, genie_tasks::Refusal> {
    apply(from, &event, &FixedClock(NOW.into()))
}

#[test]
fn every_cell_of_the_table() {
    use E::*;
    let accepted: &[(Option<S>, E)] = &[
        // A task first seen by forge-sync starts wherever the forge says.
        (None, Created),
        (None, Opened),
        (None, Merged),
        (None, Closed),
        // created -> opened -> merged, and the forge may skip opened between two syncs.
        (Some(S::Created), Opened),
        (Some(S::Created), Merged),
        (Some(S::Created), Closed),
        (Some(S::Opened), Merged),
        (Some(S::Opened), Closed),
        // A PR closed without merging can be started again (R-M5).
        (Some(S::Closed), Created),
    ];
    let refused: &[(Option<S>, E)] = &[
        // A second created while the task is still at created.
        (Some(S::Created), Created),
        // M2: an id whose PR is open or merged cannot be started.
        (Some(S::Opened), Created),
        (Some(S::Merged), Created),
        (Some(S::Opened), Opened),
        // merged is final.
        (Some(S::Merged), Opened),
        (Some(S::Merged), Merged),
        (Some(S::Merged), Closed),
        // closed is final for forge events (Decision 12: a reopen's merge is skipped).
        (Some(S::Closed), Opened),
        (Some(S::Closed), Merged),
        (Some(S::Closed), Closed),
    ];
    assert_eq!(accepted.len() + refused.len(), 20, "every (state, event) cell is decided");
    for &(from, event) in accepted {
        assert_eq!(run(from, event), Ok(event.target()), "{from:?} -> {event:?} is accepted");
    }
    for &(from, event) in refused {
        let refusal = run(from, event).expect_err(&format!("{from:?} -> {event:?} is refused"));
        assert_eq!(
            (refusal.from, refusal.event, refusal.at.as_str()),
            (from, event, NOW),
            "the refusal names the cell"
        );
    }
}

#[test]
fn whole_lifecycles() {
    let walk = |events: &[E]| events.iter().try_fold(None, |s, e| run(s, *e).map(Some));
    assert_eq!(walk(&[E::Created, E::Opened, E::Merged]), Ok(Some(S::Merged)));
    assert_eq!(walk(&[E::Created, E::Opened, E::Closed, E::Created, E::Opened]), Ok(Some(S::Opened)));
    assert!(walk(&[E::Opened, E::Merged, E::Opened]).is_err());
}

#[test]
fn lanes_are_derived() {
    assert_eq!(S::Created.lane(), Lane::Working);
    assert_eq!(S::Opened.lane(), Lane::Review);
    assert_eq!(S::Merged.lane(), Lane::Merged);
    assert_eq!(S::Closed.lane(), Lane::Closed, "L1: none -> closed has a lane");
}

static N: AtomicUsize = AtomicUsize::new(0);

/// A git repository whose `.genie/genie.db` TS has initialized (`user_version = 1`).
fn initialized_repo(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "genie-tasks-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(".genie")).unwrap();
    assert!(Command::new("git").args(["init", "-q", "-b", "main"]).current_dir(&dir).status().unwrap().success());
    let db = rusqlite::Connection::open(dir.join(".genie/genie.db")).unwrap();
    db.execute_batch(
        "PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); PRAGMA user_version = 1;",
    )
    .unwrap();
    dir
}

fn lines(home: &Path) -> usize {
    std::fs::read_to_string(home.join("tasks.jsonl")).map_or(0, |t| t.lines().count())
}

#[test]
fn a_repeated_identical_event_is_a_no_op() {
    let repo = initialized_repo("apply");
    let home = repo.join("home");
    let store = open_store_at(&repo, &home).unwrap().with_clock(Box::new(FixedClock(NOW.into())));
    let mut row = EventRow::new(E::Opened);
    row.task = "gh-5".into();
    row.forge = "github".into();
    row.url = "https://github.com/o/r/pull/5".into();
    row.commit = "a".repeat(40);
    let first = record(&store, store.project(), &row).unwrap();
    assert!(matches!(first, Recorded::Appended { state: S::Opened, .. }));
    let again = record(&store, store.project(), &row).unwrap();
    assert!(matches!(again, Recorded::Duplicate { .. }), "the identical event is not refused: {again:?}");
    assert_eq!(store.events().unwrap().len(), 1);
    assert_eq!(lines(&home), 1, "a duplicate writes no export row");
    // A different opened for the same task is a refusal, and it writes nothing either.
    row.commit = "b".repeat(40);
    let err = record(&store, store.project(), &row).unwrap_err();
    assert_eq!(err.exit_code(), 2, "{err}");
    assert_eq!((store.events().unwrap().len(), lines(&home)), (1, 1));
    std::fs::remove_dir_all(&repo).unwrap();
}
