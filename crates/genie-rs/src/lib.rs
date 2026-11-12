//! The `genie-rs` front door: one binary, dispatching with hand-rolled `std::env::args` (no clap).
//! The dispatch lives here so the stdio test seam (`src/bin/genie-rs-stdio.rs`) runs the same code.
//!
//! Exit codes (Decision 4): 0 ok. 1 a failure, external input included, even when nothing was
//! written (a forge reply with a NUL byte, a missing or logged-out `gh`/`glab`). 2 a refusal of the
//! operator's own request that changed nothing (a usage error, a missing or `user_version = 0`
//! `genie.db`, `<GENIE_HOME>/genie.db`, an unknown task, `start` of an opened or merged task,
//! `push` to any branch but the recorded task branch). A failed `git fetch` in `start` is 1. A
//! forge event `apply` refuses is neither:
//! forge-sync reports it on stderr and exits 0 (Decision 12). Errors go to stderr; `--json` output
//! goes to stdout.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;

use genie_forge::SyncOptions;
use genie_tasks::meter::{
    BranchUsageSummary, MAX_QUERY_BRANCHES, MeterRowState, MeterTaskRow, query_repo_by_branches, query_repo_by_task,
};
use genie_tasks::store::{Listed, Store, open_store_read};
use genie_tasks::{Lane, StartOptions, StoredEvent, VerbError, genie_home, rebuild};
use serde_json::{Value, json};

pub const USAGE: &str = "usage: genie-rs <verb> [options]

  forge-sync [--project <path>] [--full] [--json] record the project's opened/merged/closed PRs/MRs, one pass;
                                                  a first pass looks back 30 days. --full (hand-run only)
                                                  lists the whole history once: one count call per merged PR/MR
                                                  in it, thousands on a large repository, against the shared
                                                  gh/glab quota
  export --rebuild --project <path>... [--json]   rewrite those projects' rows in GENIE_HOME/tasks.jsonl
  status <id> [--project <path>] [--json]         one v7 task: its state, lane and events
  list [--project <path>] [--json]                the project's v7 tasks with their lanes
  start (<gh-N|gl-N> | --title <t>) --lead <bot id> [--type fix|feat|docs|...] [--title <t>] [--project <path>]
                                                  cut a task worktree from the freshly fetched base;
                                                  prints {task, branch, worktree, lead, base_sha}
  link <gh-N|gl-N|gn-N> (--pr <url> | --branch <b>) [--project <path>] [--json]
  unlink <id> (--pr <url> | --branch <b>) [--project <path>] [--json]
  push [<task branch>] [--project <worktree>]     push HEAD to the task worktree's recorded branch

exit: 0 ok, 1 failed, 2 refused (nothing changed)";

struct Failure {
    code: i32,
    message: String,
}

impl Failure {
    fn usage(why: impl Into<String>) -> Failure {
        Failure { code: 2, message: format!("{}\n{USAGE}", why.into()) }
    }
}

impl From<genie_tasks::Error> for Failure {
    fn from(e: genie_tasks::Error) -> Self {
        Failure { code: e.exit_code(), message: e.to_string() }
    }
}

impl From<genie_forge::Error> for Failure {
    fn from(e: genie_forge::Error) -> Self {
        Failure { code: e.exit_code(), message: e.to_string() }
    }
}

impl From<VerbError> for Failure {
    fn from(e: VerbError) -> Self {
        Failure { code: e.exit_code(), message: e.to_string() }
    }
}

impl From<std::io::Error> for Failure {
    fn from(e: std::io::Error) -> Self {
        Failure { code: 1, message: e.to_string() }
    }
}

#[derive(Default)]
struct Flags {
    json: bool,
    rebuild: bool,
    full: bool,
    projects: Vec<PathBuf>,
    positional: Vec<String>,
    target: Option<genie_tasks::link::Target>,
}

impl Flags {
    /// The one `--project`, defaulting to the current folder.
    fn project(&self) -> Result<PathBuf, Failure> {
        match self.projects.as_slice() {
            [] => Ok(std::env::current_dir()?),
            [one] => Ok(one.clone()),
            _ => Err(Failure::usage("--project is given more than once")),
        }
    }
}

/// Which verb-specific option `parse` accepts beside `--json` and `--project`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Extra {
    None,
    Rebuild,
    Full,
    Link,
}

/// `--json`, `--project <path>` (or `--project=<path>`), `--rebuild` or `--full` where `extra` names
/// it, positionals.
fn parse(args: &[String], extra: Extra) -> Result<Flags, Failure> {
    let mut flags = Flags::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--pr" | "--branch" if extra == Extra::Link => {
                let value = it
                    .next()
                    .filter(|v| !v.starts_with("--"))
                    .ok_or_else(|| Failure::usage(format!("{arg} needs a value")))?;
                if flags.target.is_some() {
                    return Err(Failure::usage("give exactly one --pr or --branch"));
                }
                flags.target = Some(if arg == "--pr" {
                    genie_tasks::link::Target::Pr(value.clone())
                } else {
                    genie_tasks::link::Target::Branch(value.clone())
                });
            }
            "--json" => flags.json = true,
            "--rebuild" if extra == Extra::Rebuild => flags.rebuild = true,
            "--full" if extra == Extra::Full => flags.full = true,
            "--project" => match it.next() {
                Some(p) => flags.projects.push(PathBuf::from(p)),
                None => return Err(Failure::usage("--project needs a path")),
            },
            a if a.starts_with("--project=") => flags.projects.push(PathBuf::from(&a["--project=".len()..])),
            a if a.starts_with('-') => return Err(Failure::usage(format!("unknown option '{a}'"))),
            a => flags.positional.push(a.to_string()),
        }
    }
    Ok(flags)
}

fn no_positionals(flags: &Flags) -> Result<(), Failure> {
    match flags.positional.first() {
        Some(extra) => Err(Failure::usage(format!("unexpected argument '{extra}'"))),
        None => Ok(()),
    }
}

fn lane(lane: Lane) -> &'static str {
    match lane {
        Lane::Working => "Working",
        Lane::Review => "Review",
        Lane::Merged => "Merged",
        Lane::Closed => "Closed",
    }
}

/// A task's base JSON: every `v7_tasks` key, then its lifecycle and the realpath `project`.
fn task_json(listed: &Listed) -> Value {
    let (t, life) = (&listed.row, &listed.lifecycle);
    json!({
        "task": if t.task.is_empty() { Value::Null } else { json!(t.task) },
        "task_key": t.task_key,
        "state": t.state.as_str(),
        "lane": lane(t.state.lane()),
        "title": t.title,
        "lead": t.lead,
        "forge": t.forge,
        "url": t.url,
        "branch": t.branch,
        "updated_at": t.updated_at,
        "created_at": life.created_at,
        "opened_at": life.opened_at,
        "merged_at": life.merged_at,
        "closed_at": life.closed_at,
        "worktree": life.worktree,
        "project": t.project,
        "age_min": listed.age_min,
        "task_open_min": listed.task_open_min,
        "task_lead_min": listed.task_lead_min,
        "pr_open_min": listed.pr_open_min,
        "pr_lead_min": listed.pr_lead_min,
    })
}

fn attach_missing_meter(val: &mut Value, reason: &str, branch_usage: Value) {
    val["meter_state"] = json!("missing");
    val["meter_reason"] = json!(reason);
    val["tokens"] = Value::Null;
    val["cost"] = Value::Null;
    val["activity_hours"] = Value::Null;
    val["actors"] = json!([]);
    val["work_min"] = Value::Null;
    val["branch_usage"] = branch_usage;
}

fn attach_task_meter(val: &mut Value, tr: &MeterTaskRow) {
    val["meter_state"] = json!(tr.state);
    val["meter_reason"] = json!(tr.reason);
    val["tokens"] = json!(tr.tokens);
    val["cost"] = json!(tr.cost);
    val["activity_hours"] = json!(tr.activity.as_ref().map(|a| a.hours));
    val["actors"] = Value::Array(
        tr.actors
            .iter()
            .map(|a| json!({"bot": a.bot, "kind": a.kind, "role": a.role, "squad": a.squad, "unrecorded": a.unrecorded, "harness": a.harness, "usd": Value::Null, "work_min": Value::Null}))
            .collect(),
    );
    val["work_min"] = Value::Null;
    val["branch_usage"] = Value::Null;
}

/// Enriches `tasks` with Contract 1 meter fields (`--by task` for card cost, batched `--branch` for drawer usage).
fn tasks_json(store: &Store, tasks: &[Listed]) -> Vec<Value> {
    let mut out: Vec<Value> = tasks.iter().map(task_json).collect();
    if tasks.is_empty() {
        return out;
    }
    let fill_err = |out: &mut [Value], reason: &str| {
        for val in out.iter_mut() {
            attach_missing_meter(val, reason, Value::Null);
        }
    };
    let Some(slug) = store.repo_slug() else {
        fill_err(&mut out, "no_repo_slug");
        return out;
    };
    let task_rows = match query_repo_by_task(&slug) {
        Ok(rows) => rows,
        Err(err) => {
            fill_err(&mut out, &err.reason);
            return out;
        }
    };
    let task_map: BTreeMap<&str, &MeterTaskRow> = task_rows.iter().map(|r| (r.task.as_str(), r)).collect();
    let in_window: Vec<bool> = tasks.iter().map(|l| !store.outside_d30_window(&l.row.updated_at)).collect();
    // Decision order: by-task row present -> attach as is; absent and inside the window -> branch call; absent and outside the window -> outside_d30_window.
    let mut candidate_branches: Vec<String> = Vec::new();
    for (l, &inside) in tasks.iter().zip(&in_window) {
        let has_task_row = !l.row.task.is_empty() && task_map.contains_key(l.row.task.as_str());
        if !has_task_row
            && inside
            && !l.row.branch.is_empty()
            && candidate_branches.len() < MAX_QUERY_BRANCHES
            && !candidate_branches.contains(&l.row.branch)
        {
            candidate_branches.push(l.row.branch.clone());
        }
    }
    let branch_map = (!candidate_branches.is_empty()).then(|| {
        query_repo_by_branches(&slug, &candidate_branches)
            .map(|rows| rows.into_iter().map(|r| (r.branch.clone(), r)).collect::<BTreeMap<_, _>>())
            .map_err(|e| e.reason)
    });

    for ((val, l), &inside) in out.iter_mut().zip(tasks).zip(&in_window) {
        if let Some(&tr) = (!l.row.task.is_empty()).then(|| task_map.get(l.row.task.as_str())).flatten() {
            attach_task_meter(val, tr);
            continue;
        }
        if !inside {
            attach_missing_meter(val, "outside_d30_window", Value::Null);
            continue;
        }
        let branch_usage = match (l.row.branch.is_empty(), &branch_map) {
            (false, Some(Ok(map))) => map.get(&l.row.branch).map(|b| json!(b)).unwrap_or(Value::Null),
            (false, Some(Err(err_reason))) => json!(BranchUsageSummary {
                branch: l.row.branch.clone(),
                state: MeterRowState::Missing,
                reason: Some(err_reason.clone()),
                tokens: None,
                cost: None,
                activity: None,
                activity_hours: None,
            }),
            _ => Value::Null,
        };
        attach_missing_meter(val, "no_task_usage", branch_usage);
    }
    out
}

fn event_json(e: &StoredEvent) -> Value {
    json!({
        "seq": e.seq,
        "event": e.event.as_str(),
        "at": e.at,
        "commit": e.commit,
        "url": e.url,
        "type": e.kind,
        "counted": e.counted,
        "exclude_reason": e.exclude_reason,
        "pushed_after_open": e.pushed_after_open,
    })
}

fn forge_sync(args: &[String], out: &mut dyn Write, err: &mut dyn Write) -> Result<(), Failure> {
    let flags = parse(args, Extra::Full)?;
    no_positionals(&flags)?;
    let opts =
        SyncOptions { project: flags.project()?, genie_home: genie_home(), path: None, now: None, full: flags.full };
    let report = genie_forge::sync(&opts)?;
    for skip in &report.skipped {
        writeln!(err, "{skip}")?;
    }
    if flags.json {
        writeln!(out, "{}", json!(report))?;
    } else {
        writeln!(
            out,
            "forge-sync {} ({}{}): {} appended, {} already recorded, {} skipped",
            report.project,
            report.forge,
            if report.cached { ", cached" } else { "" },
            report.appended,
            report.duplicates,
            report.skipped.len()
        )?;
    }
    Ok(())
}

fn export(args: &[String], out: &mut dyn Write) -> Result<(), Failure> {
    let flags = parse(args, Extra::Rebuild)?;
    no_positionals(&flags)?;
    if !flags.rebuild || flags.projects.is_empty() {
        return Err(Failure::usage("export needs --rebuild and at least one --project <path>"));
    }
    let report = rebuild(&genie_home(), &flags.projects)?;
    if flags.json {
        let projects: Vec<Value> = report.projects.iter().map(|(p, n)| json!({"project": p, "rows": n})).collect();
        writeln!(out, "{}", json!({"projects": projects, "kept": report.kept}))?;
    } else {
        for (project, rows) in &report.projects {
            writeln!(out, "rebuilt {project}: {rows} rows")?;
        }
        writeln!(out, "kept {} rows of other projects", report.kept)?;
    }
    Ok(())
}

fn status(args: &[String], out: &mut dyn Write) -> Result<(), Failure> {
    let flags = parse(args, Extra::None)?;
    let [id] = flags.positional.as_slice() else {
        return Err(Failure::usage("status takes exactly one task id"));
    };
    let store = open_store_read(&flags.project()?)?;
    let Some(listed) = store.listed()?.into_iter().find(|l| &l.row.task == id || &l.row.task_key == id) else {
        return Err(Failure { code: 2, message: format!("no v7 task {id} in {}", store.project()) });
    };
    let task = &listed.row;
    let events: Vec<StoredEvent> = store.events()?.into_iter().filter(|e| e.task_key == task.task_key).collect();
    if flags.json {
        let mut body = tasks_json(&store, std::slice::from_ref(&listed)).pop().unwrap();
        body["events"] = events.iter().map(event_json).collect();
        writeln!(out, "{body}")?;
    } else {
        let id = if task.task.is_empty() { &task.task_key } else { &task.task };
        writeln!(out, "{}  {}  {}  {}", id, task.state.as_str(), lane(task.state.lane()), task.title)?;
        for e in &events {
            writeln!(out, "  {}  {}  {}", e.at, e.event.as_str(), e.commit)?;
        }
    }
    Ok(())
}

fn list(args: &[String], out: &mut dyn Write) -> Result<(), Failure> {
    let flags = parse(args, Extra::None)?;
    no_positionals(&flags)?;
    let store = open_store_read(&flags.project()?)?;
    let tasks = store.listed()?;
    if flags.json {
        writeln!(out, "{}", Value::Array(tasks_json(&store, &tasks)))?;
    } else {
        for t in tasks.iter().map(|l| &l.row) {
            let id = if t.task.is_empty() { &t.task_key } else { &t.task };
            writeln!(out, "{}  {}  {}  {}", id, t.state.as_str(), lane(t.state.lane()), t.title)?;
        }
    }
    Ok(())
}

/// `start`'s own options: the id, `--title`, `--lead`, `--type`, `--project`, and `--json`, which is
/// accepted for symmetry (the output is always one JSON object).
fn start(args: &[String], out: &mut dyn Write, err: &mut dyn Write) -> Result<(), Failure> {
    let mut opts = StartOptions::default();
    let mut project = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        if !matches!(name, "--title" | "--lead" | "--type" | "--project") {
            match name {
                "--json" if inline.is_none() => {}
                a if a.starts_with('-') => return Err(Failure::usage(format!("unknown option '{a}'"))),
                _ if opts.id.is_none() => opts.id = Some(arg.clone()),
                _ => return Err(Failure::usage(format!("unexpected argument '{arg}'"))),
            }
            continue;
        }
        let Some(value) = inline.or_else(|| it.next().cloned()) else {
            return Err(Failure::usage(format!("{name} needs a value")));
        };
        match name {
            "--title" => opts.title = Some(value),
            "--lead" => opts.lead = value,
            "--type" => opts.kind = value,
            _ => project = Some(PathBuf::from(value)),
        }
    }
    let project = match project {
        Some(p) => p,
        None => std::env::current_dir()?,
    };
    let s = genie_tasks::start(&project, &genie_home(), &opts, err)?;
    let body =
        json!({"task": s.task, "branch": s.branch, "worktree": s.worktree, "lead": s.lead, "base_sha": s.base_sha});
    writeln!(out, "{body}")?;
    Ok(())
}

fn push(args: &[String], out: &mut dyn Write) -> Result<(), Failure> {
    let flags = parse(args, Extra::None)?;
    let branch = match flags.positional.as_slice() {
        [] => None,
        [one] => Some(one.as_str()),
        [_, extra, ..] => return Err(Failure::usage(format!("unexpected argument '{extra}'"))),
    };
    let p = genie_tasks::push(&flags.project()?, &genie_home(), branch)?;
    if flags.json {
        writeln!(out, "{}", json!({"task": p.task, "branch": p.branch, "commit": p.commit}))?;
    } else {
        writeln!(out, "pushed {} to {} ({})", p.commit, p.branch, p.task)?;
    }
    Ok(())
}

fn link(args: &[String], out: &mut dyn Write, unlink: bool) -> Result<(), Failure> {
    let flags = parse(args, Extra::Link)?;
    let [id] = flags.positional.as_slice() else {
        return Err(Failure::usage("link/unlink takes exactly one task id"));
    };
    let target = flags.target.as_ref().ok_or_else(|| Failure::usage("give exactly one --pr or --branch"))?;
    if !genie_tasks::link::valid_id(id) {
        return Err(Failure::usage("malformed task id; expected gh-N, gl-N or gn-N"));
    }
    target.validate()?;
    let project = flags.project()?;
    let changed = genie_tasks::link::change_at(&project, &genie_home(), id, target, unlink)?;
    if flags.json {
        writeln!(out, "{}", json!(changed))?;
    } else {
        writeln!(
            out,
            "{} {} {}{}",
            changed.event,
            id,
            if changed.url.is_empty() { &changed.branch } else { &changed.url },
            if changed.changed { "" } else { " (already recorded)" }
        )?;
    }
    Ok(())
}

/// Run one `genie-rs` invocation (the arguments after the program name) and return its exit code.
pub fn run(args: &[String], out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    let result = match args.split_first() {
        None => Err(Failure::usage("no verb given")),
        Some((verb, rest)) => match verb.as_str() {
            "forge-sync" => forge_sync(rest, out, err),
            "export" => export(rest, out),
            "status" => status(rest, out),
            "list" => list(rest, out),
            "start" => start(rest, out, err),
            "push" => push(rest, out),
            "link" | "unlink" => link(rest, out, verb == "unlink"),
            "help" | "--help" | "-h" => writeln!(out, "{USAGE}").map_err(Failure::from),
            "--version" | "-V" => writeln!(out, "genie-rs {}", env!("CARGO_PKG_VERSION")).map_err(Failure::from),
            other => Err(Failure::usage(format!("unknown verb '{other}'"))),
        },
    };
    match result {
        Ok(()) => 0,
        Err(failure) => {
            let _ = writeln!(err, "genie-rs: {}", failure.message);
            failure.code
        }
    }
}
