import { useNats } from '@khal-os/sdk/app';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GENIE_SUBJECTS } from '../../../lib/subjects';
import { theme } from '../../../lib/theme';
import type { AppComponentProps } from '../../../lib/types';
import { EmptyState } from '../../shared/EmptyState';
import { ErrorState } from '../../shared/ErrorState';
import { LoadingState } from '../../shared/LoadingState';

// ============================================================================
// Types
// ============================================================================

interface TableSizeRow {
  table_name: string;
  row_count: number | null;
  data_bytes: number | null;
  index_bytes: number | null;
  total_bytes: number | null;
  data_size: string | null;
  index_size: string | null;
  total_size: string | null;
}

interface ChannelRow {
  channel: string;
  source_table: string | null;
  trigger_name: string | null;
}

interface MachineSnapshot {
  id?: string;
  cpu_pct: number;
  mem_pct: number;
  mem_used_mb: number;
  mem_total_mb: number;
  load_1m: number | null;
  load_5m: number | null;
  created_at: string;
}

interface ExtensionRow {
  name: string;
  version: string;
  comment: string | null;
}

interface SystemHealth {
  pg: {
    status: 'ok' | 'degraded' | 'error';
    agent_count: number;
    port?: number;
    data_dir?: string;
    uptime_s?: number;
  };
  nats: { status: 'connected' | 'disconnected' };
  tables?: TableSizeRow[];
  channels?: ChannelRow[];
  extensions?: ExtensionRow[];
}

type SortField = 'table_name' | 'row_count' | 'data_bytes' | 'index_bytes' | 'total_bytes';
type SortDir = 'asc' | 'desc';

type LoadState = 'loading' | 'ready' | 'error';

// ============================================================================
// Constants
// ============================================================================

const ORG_ID = 'default';
const SPARKLINE_POINTS = 30;

// ============================================================================
// Helpers
// ============================================================================

function formatBytes(bytes: number | null): string {
  if (bytes == null || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function formatUptime(secs: number | undefined): string {
  if (secs == null) return '—';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

// ============================================================================
// Sparkline (SVG-based)
// ============================================================================

interface SparklineProps {
  values: number[];
  color: string;
  width?: number;
  height?: number;
  max?: number;
}

function Sparkline({ values, color, width = 120, height = 30, max = 100 }: SparklineProps) {
  if (values.length < 2) {
    return <span style={{ fontSize: '10px', color: theme.textMuted }}>not enough data</span>;
  }

  const points = values.slice(-SPARKLINE_POINTS);
  const maxVal = max > 0 ? max : Math.max(...points, 1);
  const step = width / (points.length - 1);

  const coords = points.map((v, i) => {
    const x = i * step;
    const y = height - (v / maxVal) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polyline = coords.join(' ');
  const lastPt = coords[coords.length - 1].split(',');
  const lastX = Number.parseFloat(lastPt[0]);
  const lastY = Number.parseFloat(lastPt[1]);
  const lastVal = points[points.length - 1];

  return (
    <svg width={width} height={height} style={{ display: 'block' }} role="img" aria-label="sparkline chart">
      <title>sparkline</title>
      <polyline
        points={polyline}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.8}
      />
      <circle cx={lastX} cy={lastY} r={2.5} fill={color} />
      <text x={lastX + 4} y={lastY + 4} fill={color} fontSize="9" fontFamily="monospace">
        {lastVal.toFixed(0)}%
      </text>
    </svg>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    backgroundColor: theme.bg,
    color: theme.text,
    fontFamily: theme.fontFamily,
    overflow: 'hidden',
  },
  header: {
    padding: '16px 20px',
    borderBottom: `1px solid ${theme.border}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
  },
  title: {
    fontSize: '16px',
    fontWeight: 600,
    color: theme.text,
    margin: 0,
  },
  subtitle: {
    fontSize: '11px',
    color: theme.textMuted,
    margin: '2px 0 0',
  },
  scrollArea: {
    flex: 1,
    overflow: 'auto',
    padding: '16px 20px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '20px',
  },
  card: {
    backgroundColor: theme.bgCard,
    borderRadius: theme.radiusMd,
    border: `1px solid ${theme.border}`,
    overflow: 'hidden',
  },
  cardHeader: {
    padding: '10px 14px',
    borderBottom: `1px solid ${theme.border}`,
    fontSize: '11px',
    fontWeight: 600,
    color: theme.textMuted,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  cardBody: {
    padding: '12px 14px',
  },
  statusRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '16px',
    alignItems: 'flex-start',
  },
  statItem: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    minWidth: '100px',
  },
  statLabel: {
    fontSize: '10px',
    color: theme.textMuted,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  statValue: {
    fontSize: '14px',
    fontWeight: 600,
    color: theme.text,
  },
  statusPill: (ok: boolean) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: theme.radiusSm,
    fontSize: '10px',
    fontWeight: 600,
    backgroundColor: ok ? 'rgba(52, 211, 153, 0.15)' : 'rgba(248, 113, 113, 0.15)',
    color: ok ? theme.emerald : theme.error,
  }),
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '12px',
  },
  th: {
    textAlign: 'left' as const,
    padding: '6px 10px',
    fontSize: '10px',
    fontWeight: 600,
    color: theme.textMuted,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    borderBottom: `1px solid ${theme.border}`,
    whiteSpace: 'nowrap' as const,
    cursor: 'pointer',
    userSelect: 'none' as const,
  },
  thActive: {
    color: theme.purple,
  },
  td: {
    padding: '7px 10px',
    borderBottom: '1px solid rgba(65, 72, 104, 0.3)',
    color: theme.text,
    fontSize: '12px',
  },
  tdMuted: {
    padding: '7px 10px',
    borderBottom: '1px solid rgba(65, 72, 104, 0.3)',
    color: theme.textDim,
    fontSize: '11px',
  },
  sparklineGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: '12px',
  },
  sparklineItem: {
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: theme.radiusSm,
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  sparklineLabel: {
    fontSize: '10px',
    color: theme.textMuted,
    display: 'flex',
    justifyContent: 'space-between',
  },
} as const;

// ============================================================================
// pgserve Status Card
// ============================================================================

function PgserveCard({ health }: { health: SystemHealth }) {
  const pgOk = health.pg.status === 'ok';
  const natsOk = health.nats.status === 'connected';

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <span>{'\uD83D\uDDC4\uFE0F'}</span> pgserve status
      </div>
      <div style={styles.cardBody}>
        <div style={styles.statusRow}>
          <div style={styles.statItem}>
            <span style={styles.statLabel}>Database</span>
            <span style={styles.statusPill(pgOk)}>{pgOk ? '\u25CF running' : '\u25CF stopped'}</span>
          </div>
          <div style={styles.statItem}>
            <span style={styles.statLabel}>NATS</span>
            <span style={styles.statusPill(natsOk)}>{natsOk ? '\u25CF connected' : '\u25CF disconnected'}</span>
          </div>
          {health.pg.port != null && (
            <div style={styles.statItem}>
              <span style={styles.statLabel}>Port</span>
              <span style={styles.statValue}>{health.pg.port}</span>
            </div>
          )}
          {health.pg.uptime_s != null && (
            <div style={styles.statItem}>
              <span style={styles.statLabel}>Uptime</span>
              <span style={styles.statValue}>{formatUptime(health.pg.uptime_s)}</span>
            </div>
          )}
          {health.pg.data_dir && (
            <div style={{ ...styles.statItem, minWidth: '200px' }}>
              <span style={styles.statLabel}>Data Dir</span>
              <code style={{ fontSize: '11px', color: theme.textDim }}>{health.pg.data_dir}</code>
            </div>
          )}
          <div style={styles.statItem}>
            <span style={styles.statLabel}>Agents</span>
            <span style={styles.statValue}>{health.pg.agent_count}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Table Sizes Card
// ============================================================================

function TableSizesCard({ tables }: { tables: TableSizeRow[] }) {
  const [sortField, setSortField] = useState<SortField>('total_bytes');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortField(field);
        setSortDir('desc');
      }
    },
    [sortField],
  );

  const sorted = useMemo(() => {
    return [...tables].sort((a, b) => {
      const aVal = a[sortField] ?? 0;
      const bVal = b[sortField] ?? 0;
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortDir === 'asc' ? Number(aVal) - Number(bVal) : Number(bVal) - Number(aVal);
    });
  }, [tables, sortField, sortDir]);

  const sortIndicator = (field: SortField) => (sortField === field ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '');

  if (tables.length === 0) {
    return (
      <div style={styles.card}>
        <div style={styles.cardHeader}>Table Sizes</div>
        <div style={styles.cardBody}>
          <EmptyState
            icon="\u{1F4C4}"
            title="No table data"
            description="Table sizes will appear once PG is running."
          />
        </div>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>Table Sizes ({tables.length})</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={styles.table}>
          <thead>
            <tr>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: sortable header */}
              <th style={styles.th} onClick={() => handleSort('table_name')}>
                Table{sortIndicator('table_name')}
              </th>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: sortable header */}
              <th style={{ ...styles.th, textAlign: 'right' as const }} onClick={() => handleSort('row_count')}>
                Rows{sortIndicator('row_count')}
              </th>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: sortable header */}
              <th style={{ ...styles.th, textAlign: 'right' as const }} onClick={() => handleSort('data_bytes')}>
                Data{sortIndicator('data_bytes')}
              </th>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: sortable header */}
              <th style={{ ...styles.th, textAlign: 'right' as const }} onClick={() => handleSort('index_bytes')}>
                Index{sortIndicator('index_bytes')}
              </th>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: sortable header */}
              <th style={{ ...styles.th, textAlign: 'right' as const }} onClick={() => handleSort('total_bytes')}>
                Total{sortIndicator('total_bytes')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.table_name}>
                <td style={styles.td}>{row.table_name}</td>
                <td style={{ ...styles.tdMuted, textAlign: 'right' as const }}>
                  {row.row_count != null ? row.row_count.toLocaleString() : '—'}
                </td>
                <td style={{ ...styles.tdMuted, textAlign: 'right' as const }}>
                  {row.data_size ?? formatBytes(row.data_bytes)}
                </td>
                <td style={{ ...styles.tdMuted, textAlign: 'right' as const }}>
                  {row.index_size ?? formatBytes(row.index_bytes)}
                </td>
                <td style={{ ...styles.td, textAlign: 'right' as const, fontWeight: 500 }}>
                  {row.total_size ?? formatBytes(row.total_bytes)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================================
// PG NOTIFY Channels Card
// ============================================================================

function ChannelsCard({ channels }: { channels: ChannelRow[] }) {
  if (channels.length === 0) {
    return (
      <div style={styles.card}>
        <div style={styles.cardHeader}>PG NOTIFY Channels</div>
        <div style={styles.cardBody}>
          <EmptyState icon="\u{1F4AC}" title="No channels" description="PG NOTIFY channels will appear here." />
        </div>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>PG NOTIFY Channels ({channels.length})</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Channel</th>
              <th style={styles.th}>Source Table</th>
              <th style={styles.th}>Trigger</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((ch, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable list from DB
              <tr key={i}>
                <td style={styles.td}>
                  <code style={{ fontSize: '11px', color: theme.cyan }}>{ch.channel}</code>
                </td>
                <td style={styles.tdMuted}>{ch.source_table ?? '—'}</td>
                <td style={styles.tdMuted}>{ch.trigger_name ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================================
// Snapshots Sparkline Card
// ============================================================================

function SnapshotsCard({ snapshots }: { snapshots: MachineSnapshot[] }) {
  const cpuValues = snapshots.map((s) => s.cpu_pct).reverse();
  const memValues = snapshots.map((s) => s.mem_pct).reverse();
  const latest = snapshots[0];

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>Machine Snapshots ({snapshots.length})</div>
      <div style={styles.cardBody}>
        {snapshots.length === 0 ? (
          <EmptyState icon="\u{1F4CA}" title="No snapshot data" description="Machine snapshots will appear here." />
        ) : (
          <>
            {latest && (
              <div style={{ ...styles.statusRow, marginBottom: '16px' }}>
                <div style={styles.statItem}>
                  <span style={styles.statLabel}>CPU</span>
                  <span
                    style={{
                      ...styles.statValue,
                      color: latest.cpu_pct > 80 ? theme.error : latest.cpu_pct > 50 ? theme.warning : theme.emerald,
                    }}
                  >
                    {latest.cpu_pct.toFixed(1)}%
                  </span>
                </div>
                <div style={styles.statItem}>
                  <span style={styles.statLabel}>Memory</span>
                  <span
                    style={{
                      ...styles.statValue,
                      color: latest.mem_pct > 85 ? theme.error : latest.mem_pct > 65 ? theme.warning : theme.emerald,
                    }}
                  >
                    {latest.mem_pct.toFixed(1)}%
                  </span>
                </div>
                {latest.mem_used_mb > 0 && (
                  <div style={styles.statItem}>
                    <span style={styles.statLabel}>Memory Used</span>
                    <span style={styles.statValue}>{(latest.mem_used_mb / 1024).toFixed(1)} GB</span>
                  </div>
                )}
                {latest.load_1m != null && (
                  <div style={styles.statItem}>
                    <span style={styles.statLabel}>Load (1m)</span>
                    <span style={styles.statValue}>{latest.load_1m.toFixed(2)}</span>
                  </div>
                )}
                <div style={styles.statItem}>
                  <span style={styles.statLabel}>Sampled</span>
                  <span style={{ ...styles.statValue, fontSize: '11px', color: theme.textDim }}>
                    {formatRelativeTime(latest.created_at)}
                  </span>
                </div>
              </div>
            )}

            <div style={styles.sparklineGrid}>
              <div style={styles.sparklineItem}>
                <div style={styles.sparklineLabel}>
                  <span>CPU %</span>
                  <span style={{ color: theme.cyan }}>{cpuValues.length} pts</span>
                </div>
                <Sparkline values={cpuValues} color={theme.cyan} width={140} height={36} />
              </div>
              <div style={styles.sparklineItem}>
                <div style={styles.sparklineLabel}>
                  <span>Memory %</span>
                  <span style={{ color: theme.purple }}>{memValues.length} pts</span>
                </div>
                <Sparkline values={memValues} color={theme.purple} width={140} height={36} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Extensions Card
// ============================================================================

function ExtensionsCard({ extensions }: { extensions: ExtensionRow[] }) {
  if (extensions.length === 0) {
    return null;
  }

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>Extensions ({extensions.length})</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Version</th>
              <th style={styles.th}>Comment</th>
            </tr>
          </thead>
          <tbody>
            {extensions.map((ext) => (
              <tr key={ext.name}>
                <td style={styles.td}>
                  <code style={{ fontSize: '11px', color: theme.emerald }}>{ext.name}</code>
                </td>
                <td style={styles.tdMuted}>{ext.version}</td>
                <td style={styles.tdMuted}>{ext.comment ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================================
// SystemView (Main Export)
// ============================================================================

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: main view orchestrates 5 data fetches + rendering
export function SystemView({ windowId, meta: _meta }: AppComponentProps) {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [snapshots, setSnapshots] = useState<MachineSnapshot[]>([]);
  const [tables, setTables] = useState<TableSizeRow[]>([]);
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [extensions, setExtensions] = useState<ExtensionRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);

  const nats = useNats();

  const fetchData = useCallback(async () => {
    try {
      const [healthData, snapshotData, tableData, channelData] = await Promise.all([
        nats.request<SystemHealth>(GENIE_SUBJECTS.system.health(ORG_ID)).catch(() => null),
        nats.request<MachineSnapshot[]>(GENIE_SUBJECTS.system.snapshots(ORG_ID), { limit: 60 }).catch(() => []),
        nats.request<TableSizeRow[]>(GENIE_SUBJECTS.system.tables(ORG_ID)).catch(() => []),
        nats.request<ChannelRow[]>(GENIE_SUBJECTS.system.channels(ORG_ID)).catch(() => []),
      ]);

      if (healthData) {
        setHealth(healthData);
        // Extract tables/channels/extensions from health if available
        if (healthData.tables && Array.isArray(healthData.tables)) {
          // Only use embedded tables if tableData is empty
          if (!Array.isArray(tableData) || (tableData as TableSizeRow[]).length === 0) {
            setTables(healthData.tables as TableSizeRow[]);
          }
        }
        if (healthData.channels && Array.isArray(healthData.channels)) {
          if (!Array.isArray(channelData) || (channelData as ChannelRow[]).length === 0) {
            setChannels(healthData.channels as ChannelRow[]);
          }
        }
        if (healthData.extensions && Array.isArray(healthData.extensions)) {
          setExtensions(healthData.extensions as ExtensionRow[]);
        }
      }

      if (Array.isArray(snapshotData)) setSnapshots(snapshotData as MachineSnapshot[]);
      if (Array.isArray(tableData) && (tableData as TableSizeRow[]).length > 0) {
        setTables(tableData as TableSizeRow[]);
      }
      if (Array.isArray(channelData) && (channelData as ChannelRow[]).length > 0) {
        setChannels(channelData as ChannelRow[]);
      }

      setLoadState('ready');
      setError(null);
    } catch (err) {
      setLoadState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [nats]);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 15_000);
    return () => clearInterval(timer);
  }, [fetchData]);

  if (loadState === 'loading') {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <LoadingState message="Loading system status..." />
      </div>
    );
  }

  if (loadState === 'error' && !health) {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <ErrorState message={error ?? 'Failed to load system data'} service="system.health" onRetry={fetchData} />
      </div>
    );
  }

  return (
    <div data-window-id={windowId} style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>System</h1>
          <p style={styles.subtitle}>
            pgserve &middot; database &middot; machine health
            {error && <span style={{ color: theme.warning }}> (partial data)</span>}
          </p>
        </div>
      </div>

      {/* Scrollable body */}
      <div style={styles.scrollArea}>
        {/* pgserve / NATS status */}
        {health && <PgserveCard health={health} />}

        {/* Snapshots sparkline */}
        <SnapshotsCard snapshots={snapshots} />

        {/* Table sizes */}
        <TableSizesCard tables={tables} />

        {/* PG NOTIFY channels */}
        <ChannelsCard channels={channels} />

        {/* Extensions */}
        <ExtensionsCard extensions={extensions} />
      </div>
    </div>
  );
}
