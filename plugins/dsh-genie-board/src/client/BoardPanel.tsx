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
  const [note, setNote] = useState('');
  useEffect(() => {
    setLane(card.lane ?? lanes[0]?.name ?? '');
    setNote('');
  }, [card.lane, lanes]);
  const claimed = Boolean(card.claimedBy);
  return (
    <aside className="gb-detail" aria-label="Task detail">
      <div>
        <h2>{card.title}</h2>
        <span className="gb-mono">{card.id}</span>
      </div>
      <div className="gb-row">
        <Tag tone={card.status === 'done' ? 'success' : card.status === 'blocked' ? 'danger' : 'info'}>
          {STATUS_LABEL[card.status]}
        </Tag>
        {card.liveness && <Tag tone="neutral">{card.liveness}</Tag>}
        {card.enforcedBlock && (
          <Tag tone="danger">
            {card.enforcedBlock.kind === 'hold' ? 'On hold' : 'Blocked'}: {card.enforcedBlock.reason}
          </Tag>
        )}
      </div>
      <dl className="gb-kv">
        <dt>Owner</dt>
        <dd>{card.claimedBy ? `${card.claimedBy}${card.agentKind ? ` (${card.agentKind})` : ''}` : 'Unclaimed'}</dd>
        {card.assignedAgent && (
          <>
            <dt>Assigned</dt>
            <dd>
              {card.assignedAgent}
              {card.assignedReason ? ` — ${card.assignedReason}` : ''}
            </dd>
          </>
        )}
        {card.wish && (
          <>
            <dt>Wish</dt>
            <dd>
              {card.wish}
              {card.group ? ` · ${card.group}` : ''}
            </dd>
          </>
        )}
        <dt>Updated</dt>
        <dd>{when(card.updatedAt)}</dd>
      </dl>
      <h3>Move</h3>
      <div className="gb-row">
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
      </div>
      <h3>Actions</h3>
      <div className="gb-row">
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
        <Button size="sm" variant="outline" disabled={busy || card.status === 'done'} onClick={() => onAction('done')}>
          Complete
        </Button>
      </div>
      <h3>Note</h3>
      <textarea
        className="gb-textarea"
        aria-label="Comment or block reason"
        placeholder="Comment, or a reason to block or hold"
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
      />
      <div className="gb-row">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !note.trim()}
          onClick={() => onAction('comment', { text: note })}
        >
          Comment
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !note.trim()}
          onClick={() => onAction('block', { text: note })}
        >
          Block
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !note.trim()}
          onClick={() => onAction('block', { text: note, hold: true })}
        >
          Hold
        </Button>
      </div>
      {card.dependencies.length > 0 && (
        <>
          <h3>Dependencies</h3>
          <ul className="gb-timeline">
            {card.dependencies.map((dependency) => (
              <li key={dependency.id}>
                <Tag tone={dependency.status === 'done' ? 'success' : 'outline'}>{STATUS_LABEL[dependency.status]}</Tag>
                <span>{dependency.title}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {card.comments.length > 0 && (
        <>
          <h3>Comments</h3>
          <ul className="gb-timeline">
            {card.comments.map((comment) => (
              <li key={comment.id}>
                <time>{when(comment.createdAt)}</time>
                <span>
                  <strong>{comment.author ?? 'Unknown'}</strong> {comment.note}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>History{card.eventsTruncated ? ` (last ${card.timeline.length} of ${card.eventCount})` : ''}</h3>
      <ul className="gb-timeline">
        {card.timeline.map((event) => (
          <li key={event.id}>
            <time>{when(event.createdAt)}</time>
            <span>
              {event.kind}
              {event.author ? ` · ${event.author}` : ''}
              {event.note ? ` — ${event.note}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </aside>
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
