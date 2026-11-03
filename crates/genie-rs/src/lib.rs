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

use std::io::Write;
use std::path::PathBuf;

use genie_forge::SyncOptions;
use genie_tasks::{Lane, StartOptions, StoredEvent, TaskRow, VerbError, genie_home, open_store, rebuild};
use serde_json::{Value, json};

pub const USAGE: &str = "usage: genie-rs <verb> [options]

  forge-sync [--project <path>] [--json]          record the project's opened/merged/closed PRs/MRs, one pass
  export --rebuild --project <path>... [--json]   rewrite those projects' rows in GENIE_HOME/tasks.jsonl
  status <id> [--project <path>] [--json]         one v7 task: its state, lane and events
  list [--project <path>] [--json]                the project's v7 tasks with their lanes
  start (<gh-N|gl-N> | --title <t>) --lead <bot id> [--type fix|feat|docs|...] [--title <t>] [--project <path>]
                                                  cut a task worktree from the freshly fetched base;
                                                  prints {task, branch, worktree, lead, base_sha}
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
    projects: Vec<PathBuf>,
    positional: Vec<String>,
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

/// `--json`, `--project <path>` (or `--project=<path>`), `--rebuild` where `rebuild`, positionals.
fn parse(args: &[String], rebuild: bool) -> Result<Flags, Failure> {
    let mut flags = Flags::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => flags.json = true,
            "--rebuild" if rebuild => flags.rebuild = true,
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

fn task_json(t: &TaskRow) -> Value {
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
    })
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
    let flags = parse(args, false)?;
    no_positionals(&flags)?;
    let opts = SyncOptions { project: flags.project()?, genie_home: genie_home(), path: None, now: None };
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
    let flags = parse(args, true)?;
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
    let flags = parse(args, false)?;
    let [id] = flags.positional.as_slice() else {
        return Err(Failure::usage("status takes exactly one task id"));
    };
    let store = open_store(&flags.project()?)?;
    let Some(task) = store.tasks()?.into_iter().find(|t| &t.task == id || &t.task_key == id) else {
        return Err(Failure { code: 2, message: format!("no v7 task {id} in {}", store.project()) });
    };
    let events: Vec<StoredEvent> = store.events()?.into_iter().filter(|e| e.task_key == task.task_key).collect();
    if flags.json {
        let mut body = task_json(&task);
        body["events"] = events.iter().map(event_json).collect();
        writeln!(out, "{body}")?;
    } else {
        writeln!(out, "{}  {}  {}  {}", task.task_key, task.state.as_str(), lane(task.state.lane()), task.title)?;
        for e in &events {
            writeln!(out, "  {}  {}  {}", e.at, e.event.as_str(), e.commit)?;
        }
    }
    Ok(())
}

fn list(args: &[String], out: &mut dyn Write) -> Result<(), Failure> {
    let flags = parse(args, false)?;
    no_positionals(&flags)?;
    let store = open_store(&flags.project()?)?;
    let tasks = store.tasks()?;
    if flags.json {
        writeln!(out, "{}", Value::Array(tasks.iter().map(task_json).collect()))?;
    } else {
        for t in &tasks {
            writeln!(out, "{}  {}  {}  {}", t.task_key, t.state.as_str(), lane(t.state.lane()), t.title)?;
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
    let flags = parse(args, false)?;
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
