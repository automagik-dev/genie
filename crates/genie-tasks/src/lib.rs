//! Genie's v7 task record. A pure state machine (`state`), its Rust-owned `v7_` tables inside the
//! per-repo `.genie/genie.db` (`store`, DDL in `schema.sql`), the machine-wide
//! `<GENIE_HOME>/tasks.jsonl` export (`export`), and the `start` / `push` verbs that cut a task
//! worktree and push only its branch. Library first, so Unfold can load it as a part.

pub mod export;
pub mod link;
pub mod meter;
pub mod push;
pub mod start;
pub mod state;
pub mod store;

pub use export::{RebuildReport, rebuild};
pub use meter::{
    BranchUsageSummary, KNOWN_PREVIOUS_REPO_SLUGS, MAX_METER_OUTPUT_BYTES, METER_CALL_TIMEOUT, MeterActivity,
    MeterBotKey, MeterBotRow, MeterBranchRow, MeterCost, MeterCostState, MeterQueryError, MeterRowState,
    MeterTaskActor, MeterTaskRow, MeterTokens, normalize_repo_slug, query_repo_by_bot, query_repo_by_branches,
    query_repo_by_task, repo_aliases_for_query, repo_slug_of_project, resolve_usagemeter_bin,
};
pub use push::{Pushed, push};
pub use start::{StartOptions, Started, VerbError, start};
pub use state::{Clock, FixedClock, Lane, Refusal, SystemClock, TaskEvent, TaskState, apply};
pub use store::{
    Error, EventRow, Location, Recorded, SCHEMA_SQL, SCHEMA_VERSION, Store, StoredEvent, TaskRow, dedupe_key,
    genie_home, lifecycle_dedupe_key, locate, open_store, open_store_at, project_root, record, task_key,
};
