import { Button, IconPlusOutline16, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import { useCallback, useEffect, useState } from 'react';
import { type Aggregate, type Board, type Card, api, remembered } from './api';
import { IconBoard16 } from './icons';
import { Empty, PanelShell, type Status, useWorkspaces, when } from './shell';

const STATUS_LABEL: Record<Card['status'], string> = {
  ready: 'Ready',
  in_progress: 'In progress',
  done: 'Done',
  blocked: 'Blocked',
};

function liveness(card: Card): 'ongoing' | 'idle' | 'warning' | 'done' | 'error' {
  if (card.enforcedBlock) return 'error';
  if (card.status === 'done') return 'done';
  if (card.liveness === 'running') return 'ongoing';
  if (card.liveness === 'stale') return 'warning';
  return 'idle';
}

function CardButton({ card, selected, onSelect }: { card: Card; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className="gb-card" data-status={card.status} aria-pressed={selected} onClick={onSelect}>
      <span className="gb-card-title">{card.title}</span>
      <span className="gb-card-meta">
        <StateDot state={liveness(card)} size={8} />
        {card.claimedBy ?? 'Unclaimed'}
        {card.wish && <Tag tone="quiet">{card.wish}</Tag>}
        {card.enforcedBlock && <Tag tone="danger">{card.enforcedBlock.kind === 'hold' ? 'Hold' : 'Blocked'}</Tag>}
        {card.dependencies.length > 0 && <Tag tone="quiet">{card.dependencies.length} dep</Tag>}
        {card.commentCount > 0 && <Tag tone="quiet">{card.commentCount} 💬</Tag>}
      </span>
    </button>
  );
}

/** "3m", "2h", "5d", or "just now"; used for both stamps and held-for durations. */
function span(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function who(event: { author: string | null; authorKind: string | null }): string {
  if (event.author && event.authorKind) return `${event.author} · ${event.authorKind}`;
  return event.author ?? event.authorKind ?? 'unknown';
}

/** Chat-style conversation: comments and worker reports in order, oldest first. */
function Conversation({
  card,
  busy,
  onSend,
}: { card: Card; busy: boolean; onSend: (kind: 'comment' | 'block' | 'hold', text: string) => void }) {
  const [text, setText] = useState('');
  const messages = card.timeline.filter((event) => event.kind === 'comment' || event.kind === 'report');
  const send = (kind: 'comment' | 'block' | 'hold') => {
    if (!text.trim()) return;
    onSend(kind, text);
    setText('');
  };
  return (
    <section className="gb-chat" aria-label="Conversation">
      <div className="gb-chat-log">
        {messages.length === 0 && (
          <p className="gb-chat-empty">
            No comments or reports yet. Agents post here as they claim, work and hand off this card.
          </p>
        )}
        {messages.map((event) => (
          <article key={event.id} className="gb-msg" data-kind={event.kind}>
            <header>
              <strong>{event.author ?? 'unknown'}</strong>
              {event.authorKind && <span className="gb-msg-kind">{event.authorKind}</span>}
              {event.kind === 'report' && <Tag tone="info">report</Tag>}
              <time title={new Date(event.createdAt).toLocaleString()}>{when(event.createdAt)}</time>
            </header>
            <p>{event.note}</p>
          </article>
        ))}
      </div>
      <form
        className="gb-composer"
        onSubmit={(e) => {
          e.preventDefault();
          send('comment');
        }}
      >
        <textarea
          className="gb-textarea"
          aria-label="Write a comment"
          placeholder="Comment on this card… (⌘↵ to send)"
          value={text}
          rows={2}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send('comment');
            }
          }}
        />
        <div className="gb-row">
          <Button size="sm" variant="primary" type="submit" disabled={busy || !text.trim()}>
            Comment
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !text.trim()}
            onClick={() => send('block')}
            title="Block with this text as the reason"
          >
            Block
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !text.trim()}
            onClick={() => send('hold')}
            title="Put on hold with this text as the reason"
          >
            Hold
          </Button>
        </div>
      </form>
    </section>
  );
}

/** Audit rail: every event since creation, with how long the card sat in the previous state. */
function Audit({ card, now }: { card: Card; now: number }) {
  const rows: { key: string; at: number; label: string; by?: string; held: number }[] = [];
  let previous = card.createdAt;
  rows.push({ key: 'created', at: card.createdAt, label: 'Created', held: 0 });
  for (const event of card.timeline) {
    const label =
      event.kind === 'move' && event.note
        ? `Moved ${event.note}`
        : event.kind === 'claim'
          ? `Claimed${event.note ? ` (${event.note.replace(/^claimed by /, '')})` : ''}`
          : event.kind === 'release'
            ? `Released${event.note ? ` · ${event.note}` : ''}`
            : event.kind === 'wish'
              ? `Wish ${event.note ?? ''}`
              : event.kind === 'comment'
                ? 'Commented'
                : event.kind === 'report'
                  ? 'Reported'
                  : event.kind === 'block'
                    ? `Blocked${event.note ? `: ${event.note}` : ''}`
                    : event.kind === 'unblock'
                      ? 'Unblocked'
                      : event.kind === 'done'
                        ? 'Completed'
                        : event.note
                          ? `${event.kind}: ${event.note}`
                          : event.kind;
    rows.push({ key: String(event.id), at: event.createdAt, label, by: who(event), held: event.createdAt - previous });
    previous = event.createdAt;
  }
  const sinceLast = now - previous;
  return (
    <aside className="gb-audit" aria-label="History">
      <h3>
        History
        {card.eventsTruncated ? (
          <span className="gb-sub">
            {' '}
            · last {card.timeline.length} of {card.eventCount}
          </span>
        ) : null}
      </h3>
      <ol className="gb-audit-list">
        {rows.map((row, index) => (
          <li key={row.key}>
            <time title={new Date(row.at).toLocaleString()}>{when(row.at)}</time>
            <div>
              <span className="gb-audit-label">{row.label}</span>
              {row.by && <span className="gb-audit-by">{row.by}</span>}
              {index > 0 && row.held > 60_000 && <span className="gb-audit-held">after {span(row.held)}</span>}
            </div>
          </li>
        ))}
        <li className="gb-audit-now">
          <time>now</time>
          <div>
            <span className="gb-audit-label">
              {STATUS_LABEL[card.status]}
              {card.lane ? ` in ${card.lane}` : ''}
            </span>
            <span className="gb-audit-held">for {span(sinceLast)}</span>
          </div>
        </li>
      </ol>
      <dl className="gb-kv">
        <dt>Age</dt>
        <dd>{span(now - card.createdAt)}</dd>
        {card.claimedAt && (
          <>
            <dt>Claimed</dt>
            <dd>{span(now - card.claimedAt)} ago</dd>
          </>
        )}
        <dt>Events</dt>
        <dd>{card.eventCount}</dd>
      </dl>
    </aside>
  );
}

function Detail({
  card,
  lanes,
  busy,
  onAction,
}: {
  card: Card;
  lanes: Aggregate['lanes'];
  busy: boolean;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
}) {
  const [lane, setLane] = useState(card.lane ?? lanes[0]?.name ?? '');
  useEffect(() => {
    setLane(card.lane ?? lanes[0]?.name ?? '');
  }, [card.lane, lanes]);
  const claimed = Boolean(card.claimedBy);
  const now = Date.now();
  return (
    <div className="gb-detail" aria-label="Task detail">
      <header className="gb-detail-head">
        <div className="gb-detail-title">
          <h2>{card.title}</h2>
          <span className="gb-mono">{card.id}</span>
        </div>
        <div className="gb-row">
          <Tag tone={card.status === 'done' ? 'success' : card.status === 'blocked' ? 'danger' : 'info'}>
            {STATUS_LABEL[card.status]}
          </Tag>
          {card.claimedBy ? (
            <Tag tone="neutral">
              {card.claimedBy}
              {card.agentKind ? ` · ${card.agentKind}` : ''}
            </Tag>
          ) : (
            <Tag tone="quiet">Unclaimed</Tag>
          )}
          {card.liveness && (
            <Tag tone={card.liveness === 'running' ? 'success' : card.liveness === 'stale' ? 'warning' : 'quiet'}>
              {card.liveness}
            </Tag>
          )}
          {card.wish && (
            <Tag tone="quiet">
              {card.wish}
              {card.group ? ` · ${card.group}` : ''}
            </Tag>
          )}
          {card.assignedAgent && <Tag tone="quiet">→ {card.assignedAgent}</Tag>}
          {card.enforcedBlock && (
            <Tag tone="danger">
              {card.enforcedBlock.kind === 'hold' ? 'On hold' : 'Blocked'}: {card.enforcedBlock.reason}
            </Tag>
          )}
        </div>
        <div className="gb-row gb-toolbar">
          <select
            className="gb-select"
            aria-label="Destination lane"
            value={lane}
            onChange={(e) => setLane(e.currentTarget.value)}
          >
            {lanes.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.label ?? entry.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || lane === card.lane}
            onClick={() => onAction('move', { lane })}
          >
            Move
          </Button>
          {claimed ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('release')}>
              Release
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={busy || card.status === 'done'}
              onClick={() => onAction('checkout')}
            >
              Claim
            </Button>
          )}
          {card.enforcedBlock && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction('unblock')}>
              Unblock
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || card.status === 'done'}
            onClick={() => onAction('done')}
          >
            Complete
          </Button>
        </div>
        {card.dependencies.length > 0 && (
          <div className="gb-row">
            <span className="gb-sub">Depends on</span>
            {card.dependencies.map((dependency) => (
              <Tag key={dependency.id} tone={dependency.status === 'done' ? 'success' : 'outline'}>
                {dependency.title}
              </Tag>
            ))}
          </div>
        )}
      </header>
      <div className="gb-detail-body">
        <Conversation
          card={card}
          busy={busy}
          onSend={(kind, text) =>
            onAction(kind === 'comment' ? 'comment' : 'block', kind === 'hold' ? { text, hold: true } : { text })
          }
        />
        <Audit card={card} now={now} />
      </div>
    </div>
  );
}

export function BoardPanel() {
  const ws = useWorkspaces();
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardRef, setBoardRef] = useState(remembered.get('board') ?? '');
  const [snapshot, setSnapshot] = useState<Aggregate>();
  const [selected, setSelected] = useState<string>();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<string>();
  const { setStatus } = ws;

  const run = useCallback(
    async (
      label: string,
      operation: () => Promise<void>,
      done: Status = { tone: 'ok', text: 'Board confirmed by Genie' },
    ) => {
      setBusy(true);
      setStatus({ tone: 'busy', text: label });
      try {
        await operation();
        setStatus(done);
      } catch (error) {
        setStatus({ tone: 'error', text: error instanceof Error ? error.message : 'Request failed' });
      } finally {
        setBusy(false);
      }
    },
    [setStatus],
  );

  const load = useCallback(
    (workspaceId: string, ref: string) =>
      run('Loading board…', async () => {
        const aggregate = await api.load(workspaceId, ref);
        setSnapshot(aggregate);
        setSelected((current) =>
          aggregate.lanes.some((lane) => lane.cards.some((card) => card.id === current)) ? current : undefined,
        );
      }),
    [run],
  );

  const list = useCallback(
    (workspaceId: string) =>
      run('Listing boards…', async () => {
        const entries = await api.boards(workspaceId);
        setBoards(entries);
        const previous = remembered.get('board');
        const ref = entries.find((entry) => entry.id === previous)?.id ?? entries[0]?.id ?? '';
        setBoardRef(ref);
        if (ref) {
          remembered.set('board', ref);
          const aggregate = await api.load(workspaceId, ref);
          setSnapshot(aggregate);
        } else {
          setSnapshot(undefined);
        }
      }),
    [run],
  );

  useEffect(() => {
    api
      .health()
      .then((info) => setHealth(info.compatible ? undefined : info.error || 'Genie unavailable'))
      .catch((error: unknown) => setHealth(error instanceof Error ? error.message : 'Genie unavailable'));
  }, []);

  useEffect(() => {
    if (ws.workspaceId && !health) void list(ws.workspaceId);
  }, [ws.workspaceId, health, list]);

  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === 'visible' && ws.workspaceId && boardRef && !busy)
        void load(ws.workspaceId, boardRef);
    };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [ws.workspaceId, boardRef, busy, load]);

  const mutate = (action: string, extra: Record<string, unknown> = {}) =>
    run('Applying…', async () => {
      const aggregate = await api.mutate(ws.workspaceId, boardRef, action, extra);
      setSnapshot(aggregate);
    });

  const card = snapshot?.lanes.flatMap((lane) => lane.cards).find((entry) => entry.id === selected);
  const total = snapshot?.lanes.reduce((sum, lane) => sum + lane.cards.length, 0) ?? 0;

  return (
    <PanelShell
      icon={<IconBoard16 />}
      title="Board"
      subtitle={snapshot ? `${total} tasks` : undefined}
      workspaces={ws.workspaces}
      workspaceId={ws.workspaceId}
      onWorkspace={(id) => {
        ws.setWorkspaceId(id);
        setSelected(undefined);
      }}
      onRefresh={() => (ws.workspaceId ? void list(ws.workspaceId) : void ws.reload())}
      busy={busy}
      status={ws.status}
      actions={
        <>
          <select
            className="gb-select"
            aria-label="Board"
            value={boardRef}
            disabled={busy || !boards.length}
            onChange={(event) => {
              const ref = event.currentTarget.value;
              setBoardRef(ref);
              remembered.set('board', ref);
              setSelected(undefined);
              void load(ws.workspaceId, ref);
            }}
          >
            {boards.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} · {entry.cardCount}
              </option>
            ))}
          </select>
          <form
            className="gb-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (!title.trim()) return;
              void mutate('create', { title }).then(() => setTitle(''));
            }}
          >
            <input
              className="gb-select"
              style={{ backgroundImage: 'none', paddingRight: 10, minWidth: 200 }}
              aria-label="New task title"
              placeholder="New task title"
              value={title}
              disabled={busy || !boardRef}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
            <Button
              size="sm"
              variant="primary"
              icon={<IconPlusOutline16 />}
              type="submit"
              disabled={busy || !boardRef || !title.trim()}
            >
              Add
            </Button>
          </form>
        </>
      }
    >
      {health ? (
        <Empty title="Genie is not available to DSH" hint={health} />
      ) : !snapshot ? (
        <Empty
          title="No board loaded"
          hint={boards.length ? 'Pick a board above.' : 'This workspace has no boards yet. Create a task to start one.'}
        />
      ) : (
        <>
          <div className="gb-lanes">
            {snapshot.lanes.map((lane) => (
              <section key={lane.name} className="gb-lane" aria-label={lane.label ?? lane.name}>
                <div className="gb-lane-head">
                  {lane.label ?? lane.name}
                  <span className="gb-count">{lane.cards.length}</span>
                </div>
                <div className="gb-lane-body">
                  {lane.cards.map((entry) => (
                    <CardButton
                      key={entry.id}
                      card={entry}
                      selected={entry.id === selected}
                      onSelect={() => setSelected(entry.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
          {card ? (
            <Detail
              card={card}
              lanes={snapshot.lanes}
              busy={busy}
              onAction={(action, extra) => void mutate(action, { id: card.id, ...extra })}
            />
          ) : null}
        </>
      )}
    </PanelShell>
  );
}
