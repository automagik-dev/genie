//! Genie's one-shot forge poller. `forge-sync` lists a project's PRs/MRs through the operator's own
//! `gh` or `glab` (read-only; no token is read or stored), records `opened`, `merged` and `closed`
//! (without merge) through `genie-tasks`, and exits. Library first, and also an Unfold part with
//! one tool, `forge_sync`, effect `Reversible`.

pub mod client;
pub mod sync;

use std::fmt;
use std::io;
use std::path::PathBuf;

use genie_part::{BoxFuture, Effect, Part, PartManifest, PartOutput, PartTool, SCHEMA};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

pub use client::{Forge, Pr, PrState, Remote, parse_remote, parse_time};
pub use sync::{CACHE_TTL_SECS, Report, Skip, SyncOptions, classify, sync, task_id};

#[derive(Debug)]
pub enum Error {
    /// The store refused or failed; its own exit code (2 for a refusal that changed nothing).
    Store(genie_tasks::Error),
    /// `gh`/`glab` is missing, logged out or failed.
    Cli(String),
    /// The forge reply cannot be used: not JSON, a missing field, a NUL byte in a dedupe part.
    Reply(String),
    /// No usable `origin` remote.
    Remote(String),
    Io(io::Error),
}

impl Error {
    /// Decision 4: every external-input failure is 1, even when nothing was written.
    pub fn exit_code(&self) -> i32 {
        match self {
            Error::Store(e) => e.exit_code(),
            Error::Cli(_) | Error::Reply(_) | Error::Remote(_) | Error::Io(_) => 1,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Store(e) => write!(f, "{e}"),
            Error::Cli(why) | Error::Reply(why) | Error::Remote(why) => write!(f, "{why}"),
            Error::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<genie_tasks::Error> for Error {
    fn from(e: genie_tasks::Error) -> Self {
        Error::Store(e)
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}

pub const TOOL: &str = "forge_sync";
const DESCRIPTION: &str = "Record the project's opened, merged and closed PRs/MRs in its v7 task log, one pass";

/// forge-sync as an Unfold part.
pub struct ForgeSyncPart {
    manifest: PartManifest,
    digest: String,
    genie_home: PathBuf,
}

impl ForgeSyncPart {
    pub fn new(genie_home: PathBuf) -> ForgeSyncPart {
        let manifest = PartManifest {
            schema: SCHEMA.to_string(),
            id: "genie-forge".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            title: "Genie forge sync".to_string(),
            tools: vec![PartTool {
                name: TOOL.to_string(),
                effect: Effect::Reversible,
                description: Some(DESCRIPTION.to_string()),
            }],
        };
        let bytes = serde_json::to_vec(&manifest).unwrap_or_default();
        let digest = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        ForgeSyncPart { manifest, digest, genie_home }
    }
}

impl Part for ForgeSyncPart {
    fn manifest(&self) -> &PartManifest {
        &self.manifest
    }

    fn digest(&self) -> &str {
        &self.digest
    }

    fn schema(&self, tool: &str) -> Option<(String, Value)> {
        (tool == TOOL).then(|| {
            let params = json!({
                "type": "object",
                "properties": {"project": {"type": "string", "description": "A folder of the repository (default: the current folder)"}},
                "additionalProperties": false
            });
            (DESCRIPTION.to_string(), params)
        })
    }

    fn asks(&self, _tool: &str) -> bool {
        false
    }

    fn call<'a>(&'a self, tool: &'a str, args: Map<String, Value>) -> BoxFuture<'a, Result<PartOutput, String>> {
        Box::pin(async move {
            if tool != TOOL {
                return Err(format!("genie-forge has no tool {tool}"));
            }
            let project = match args.get("project").and_then(Value::as_str) {
                Some(p) => PathBuf::from(p),
                None => std::env::current_dir().map_err(|e| e.to_string())?,
            };
            let opts = SyncOptions { project, genie_home: self.genie_home.clone(), path: None, now: None };
            Ok(match sync(&opts) {
                Ok(report) => PartOutput { text: json!(report).to_string(), is_error: false },
                Err(e) => PartOutput { text: e.to_string(), is_error: true },
            })
        })
    }
}
