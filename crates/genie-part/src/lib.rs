//! Unfold's part contract, mirrored field for field so a Genie crate can later be loaded by Unfold
//! as a part. The declarations below are compared, after normalization, against a frozen copy of
//! `rth-tools/src/{parts,authority,profile}.rs` (`tests/fixtures/rth-tools-part.txt`); the re-pin
//! step is in this crate's README. Only the declarations are mirrored: authorization, the part
//! ledger and the wire names stay Unfold's.

use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The manifest schema a part declares (`rth-tools/src/authority.rs`).
pub const SCHEMA: &str = "rth-part/v1";

/// Unfold's boxed future (`rth-tools/src/web.rs`), so `Part::call` keeps its exact signature.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What a tool call can change (`rth-tools/src/profile.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    /// Reads only: nothing outside the worker changes.
    None,
    /// Changes something the person can undo.
    Reversible,
    /// Changes something that cannot be taken back (a send, a delete, a payment).
    Irreversible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartTool {
    pub name: String,
    pub effect: Effect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// What a part declares it can do: its ceiling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartManifest {
    pub schema: String,
    pub id: String,
    pub version: String,
    pub title: String,
    pub tools: Vec<PartTool>,
}

/// A call's result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartOutput {
    pub text: String,
    /// The part ran the call and reported a failure.
    pub is_error: bool,
}

pub trait Part: Send + Sync {
    /// The part's ceiling: every tool it serves, with the effect the person marked.
    fn manifest(&self) -> &PartManifest;
    /// The digest the person approves when turning the part on.
    fn digest(&self) -> &str;
    /// A tool's description and JSON schema for the model.
    fn schema(&self, tool: &str) -> Option<(String, Value)>;
    /// Whether every call to `tool` waits for the person's tap.
    fn asks(&self, tool: &str) -> bool;
    fn call<'a>(&'a self, tool: &'a str, args: Map<String, Value>) -> BoxFuture<'a, Result<PartOutput, String>>;
}
