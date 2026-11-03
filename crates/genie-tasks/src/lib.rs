//! Genie's v7 task record. A pure state machine (`state`), its Rust-owned `v7_` tables inside the
//! per-repo `.genie/genie.db` (`store`, DDL in `schema.sql`) and the machine-wide
//! `<GENIE_HOME>/tasks.jsonl` export (`export`). Library first, so Unfold can load it as a part.

pub mod export;
pub mod state;
pub mod store;

pub use export::{RebuildReport, rebuild};
pub use state::{Clock, FixedClock, Lane, Refusal, SystemClock, TaskEvent, TaskState, apply};
pub use store::{
    Error, EventRow, Location, Recorded, SCHEMA_SQL, SCHEMA_VERSION, Store, StoredEvent, TaskRow, dedupe_key,
    genie_home, locate, open_store, open_store_at, project_root, record, task_key,
};
