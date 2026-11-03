//! The pure core: a task's state, the four events, and `apply`. No I/O; time comes from the
//! injected clock, and only a refusal reads it.

use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

/// A recorded event. The task's state after it is the state of the same name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskEvent {
    /// The task's worktree was created (`start`, group 2).
    Created,
    /// Its PR/MR was opened.
    Opened,
    /// Its PR/MR was merged.
    Merged,
    /// Its PR/MR was closed without merging.
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskState {
    Created,
    Opened,
    Merged,
    Closed,
}

/// The board lane a state shows in. Derived, never stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Working,
    Review,
    Merged,
    Closed,
}

impl TaskEvent {
    pub const ALL: [TaskEvent; 4] = [TaskEvent::Created, TaskEvent::Opened, TaskEvent::Merged, TaskEvent::Closed];

    pub fn as_str(self) -> &'static str {
        match self {
            TaskEvent::Created => "created",
            TaskEvent::Opened => "opened",
            TaskEvent::Merged => "merged",
            TaskEvent::Closed => "closed",
        }
    }

    pub fn parse(s: &str) -> Option<TaskEvent> {
        TaskEvent::ALL.into_iter().find(|e| e.as_str() == s)
    }

    /// The state a task is in after this event.
    pub fn target(self) -> TaskState {
        match self {
            TaskEvent::Created => TaskState::Created,
            TaskEvent::Opened => TaskState::Opened,
            TaskEvent::Merged => TaskState::Merged,
            TaskEvent::Closed => TaskState::Closed,
        }
    }
}

impl TaskState {
    pub const ALL: [TaskState; 4] = [TaskState::Created, TaskState::Opened, TaskState::Merged, TaskState::Closed];

    pub fn as_str(self) -> &'static str {
        match self {
            TaskState::Created => "created",
            TaskState::Opened => "opened",
            TaskState::Merged => "merged",
            TaskState::Closed => "closed",
        }
    }

    pub fn parse(s: &str) -> Option<TaskState> {
        TaskState::ALL.into_iter().find(|t| t.as_str() == s)
    }

    pub fn lane(self) -> Lane {
        match self {
            TaskState::Created => Lane::Working,
            TaskState::Opened => Lane::Review,
            TaskState::Merged => Lane::Merged,
            TaskState::Closed => Lane::Closed,
        }
    }
}

/// The time source `apply` and the store read. Tests inject a fixed one.
pub trait Clock {
    /// Now, as RFC 3339 UTC with second precision (`2026-11-03T04:20:05Z`).
    fn now(&self) -> String;
}

/// The wall clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> String {
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
        rfc3339(secs)
    }
}

/// A clock that always answers the same instant.
pub struct FixedClock(pub String);

impl Clock for FixedClock {
    fn now(&self) -> String {
        self.0.clone()
    }
}

/// Unix seconds as RFC 3339 UTC (Howard Hinnant's civil-from-days).
pub fn rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (h, m, s) = (rem / 3_600, rem % 3_600 / 60, rem % 60);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z")
}

/// `apply` refused a transition. Nothing was written for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// The task's state before the event; `None` for a task with no event yet.
    pub from: Option<TaskState>,
    pub event: TaskEvent,
    /// When the refusal was decided, from the injected clock.
    pub at: String,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let from = self.from.map_or("none", TaskState::as_str);
        write!(f, "refused {from} -> {}: {}", self.event.as_str(), self.reason())
    }
}

impl Refusal {
    pub fn reason(&self) -> &'static str {
        match (self.from, self.event) {
            (Some(TaskState::Created), TaskEvent::Created) => "the task is already started",
            (Some(TaskState::Opened), TaskEvent::Created) => "the task's PR is open",
            (Some(TaskState::Merged), _) => "a merged task is final",
            (Some(TaskState::Closed), _) => "a closed task only starts again",
            (Some(TaskState::Opened), TaskEvent::Opened) => "the task's PR is already open",
            _ => "not a task transition",
        }
    }
}

/// The whole transition table. A task first seen by forge-sync may start at any forge event;
/// `merged` is final; `closed` is final for forge events and accepts only a new `created`, so a
/// PR closed without merging can be started again.
pub fn apply(state: Option<TaskState>, event: &TaskEvent, now: &dyn Clock) -> Result<TaskState, Refusal> {
    use TaskEvent as E;
    use TaskState as S;
    let accepted = match (state, *event) {
        (None, _) => true,
        (Some(S::Created), E::Created) => false,
        (Some(S::Created), E::Opened | E::Merged | E::Closed) => true,
        (Some(S::Opened), E::Merged | E::Closed) => true,
        (Some(S::Opened), E::Created | E::Opened) => false,
        (Some(S::Merged), _) => false,
        (Some(S::Closed), E::Created) => true,
        (Some(S::Closed), E::Opened | E::Merged | E::Closed) => false,
    };
    if accepted { Ok(event.target()) } else { Err(Refusal { from: state, event: *event, at: now.now() }) }
}
