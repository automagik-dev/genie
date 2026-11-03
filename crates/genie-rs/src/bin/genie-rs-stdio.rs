//! Test seam only, after Unfold's `rth-tasks-stdio`: the real `genie-rs` dispatch behind a line
//! protocol, so a test drives several verbs from one process with no shell in between. One JSON op
//! per stdin line, `{"argv": ["list", "--json"]}`; one JSON answer per stdout line,
//! `{"code": 0, "stdout": "...", "stderr": "..."}`. The first line out is `{"ready": true}`.
//!
//!   genie-rs-stdio

use std::io::{BufRead, Write};

use serde_json::{Value, json};

fn argv(line: &str) -> Option<Vec<String>> {
    let op: Value = serde_json::from_str(line).ok()?;
    op.get("argv")?.as_array()?.iter().map(|v| v.as_str().map(String::from)).collect()
}

fn main() {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", json!({"ready": true}));
    let _ = out.flush();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = match argv(&line) {
            Some(args) => {
                let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
                let code = genie_rs::run(&args, &mut stdout, &mut stderr);
                json!({
                    "code": code,
                    "stdout": String::from_utf8_lossy(&stdout),
                    "stderr": String::from_utf8_lossy(&stderr),
                })
            }
            None => json!({"error": "bad op: expected {\"argv\": [\"<verb>\", ...]}"}),
        };
        let _ = writeln!(out, "{answer}");
        let _ = out.flush();
    }
}
