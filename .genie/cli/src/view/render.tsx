import React, { Fragment } from 'react';
import gradient from 'gradient-string';
import {
  ViewEnvelope,
  ViewNode,
  ViewStyle,
  LayoutNode,
  HeadingNode,
  TextNode,
  KeyValueNode,
  TableNode,
  DividerNode,
  CalloutNode,
  ListNode,
  BadgeNode,
  LogNode,
  TimelineNode,
  SpaceNode,
  RenderOptions,
  RenderResult
} from './view-model';
import { toneToColor, accentToColor, palette } from './theme';

type InkModule = any;
let inkModule: InkModule | null = null;

async function ensureInk(): Promise<InkModule> {
  if (!inkModule) {
    inkModule = await import('ink');
  }
  return inkModule;
}

function useInk(): InkModule {
  if (!inkModule) {
    throw new Error('Ink module not loaded');
  }
  return inkModule;
}

export async function renderEnvelope(envelope: ViewEnvelope, options: RenderOptions = {}): Promise<RenderResult> {
  const targetStream = options.stream ?? process.stdout;
  const finalStyle: ViewStyle = envelope.style ?? 'genie';

  if (options.json) {
    const payload = JSON.stringify(envelope, null, 2);
    targetStream.write(payload + '\n');
    return { text: payload };
  }

  const { render: inkRender } = await ensureInk();

  const instance = inkRender(<EnvelopeRoot envelope={envelope} style={finalStyle} />, {
    stdout: targetStream,
    stderr: options.stream === process.stderr ? process.stderr : undefined,
    exitOnCtrlC: false
  });
  await instance.waitUntilExit();
  return {};
}

function EnvelopeRoot({ envelope, style }: { envelope: ViewEnvelope; style: ViewStyle }): React.ReactElement {
  const { Box: InkBox } = useInk();
  return (
    <InkBox flexDirection="column">
      {renderNode(envelope.body, style)}
    </InkBox>
  );
}

function renderNode(node: ViewNode, style: ViewStyle, keyPrefix = 'node'): React.ReactElement | null {
  switch (node.type) {
    case 'layout':
      return renderLayoutNode(node, style, keyPrefix);
    case 'heading':
      return renderHeadingNode(node, style);
    case 'text':
      return renderTextNode(node);
    case 'keyValue':
      return renderKeyValueNode(node);
    case 'table':
      return renderTableNode(node);
    case 'divider':
      return renderDividerNode(node);
    case 'callout':
      return renderCalloutNode(node);
    case 'list':
      return renderListNode(node);
    case 'badge':
      return renderBadgeNode(node);
    case 'log':
      return renderLogNode(node);
    case 'timeline':
      return renderTimelineNode(node);
    case 'space': {
      const { Text: InkText } = useInk();
      return <InkText key={`${keyPrefix}-space`}>{'\n'.repeat(Math.max(0, node.size))}</InkText>;
    }
    default:
      return null;
  }
}

function renderLayoutNode(node: LayoutNode, style: ViewStyle, keyPrefix: string): React.ReactElement {
  const { Box: InkBox, Text: InkText } = useInk();
  const direction = node.direction ?? 'column';
  const padding = node.padding ?? [0, 0, 0, 0];
  const children: React.ReactNode[] = [];
  node.children.forEach((child, index) => {
    const key = `${keyPrefix}-${index}`;
    children.push(
      <Fragment key={key}>
        {renderNode(child, style, key)}
        {index < node.children.length - 1 && node.gap ? gapSpacer(direction, node.gap, key) : null}
      </Fragment>
    );
  });

  return (
    <InkBox
      flexDirection={direction}
      paddingTop={padding[0]}
      paddingRight={padding[1]}
      paddingBottom={padding[2]}
      paddingLeft={padding[3]}
      alignItems={node.alignItems}
      justifyContent={node.justifyContent}
    >
      {children}
    </InkBox>
  );
}

function gapSpacer(direction: 'row' | 'column', size: number, key: string): React.ReactElement {
  const { Text: InkText } = useInk();
  if (direction === 'column') {
    return <InkText key={`${key}-gap`}>{'\n'.repeat(size)}</InkText>;
  }
  return <InkText key={`${key}-gap`}>{' '.repeat(size)}</InkText>;
}

function renderHeadingNode(node: HeadingNode, style: ViewStyle): React.ReactElement {
  const { Box: InkBox, Text: InkText } = useInk();
  const color = accentToColor(node.accent);
  if (node.level === 1) {
    const text = gradient([palette.accent.primary, palette.accent.secondary])(node.text);
    return (
      <InkBox flexDirection="column" alignItems={node.align === 'center' ? 'center' : 'flex-start'}>
        <InkText>{text}</InkText>
      </InkBox>
    );
  }
  const levelStyles: Record<number, { bold?: boolean; uppercase?: boolean }> = {
    1: { bold: true },
    2: { bold: true },
    3: { bold: false }
  };
  const styleInfo = levelStyles[node.level];
  const textContent = styleInfo.uppercase ? node.text.toUpperCase() : node.text;
  return (
    <InkBox justifyContent={node.align === 'center' ? 'center' : 'flex-start'}>
      <InkText color={color} bold={styleInfo.bold}>
        {textContent}
      </InkText>
    </InkBox>
  );
}

function renderTextNode(node: TextNode): React.ReactElement {
  const { Text: InkText } = useInk();
  const color = toneToColor(node.tone ?? 'default');
  return (
    <InkText color={color} dimColor={node.dim} italic={node.italic}>
      {node.text}
    </InkText>
  );
}

function renderKeyValueNode(node: KeyValueNode): React.ReactElement {
  const { Box: InkBox, Text: InkText } = useInk();
  type KeyValueItem = KeyValueNode['items'][number];
  const columnsPerRow = node.columns ?? 1;
  const rows: KeyValueItem[][] = [];
  node.items.forEach((item, index) => {
    const rowIndex = Math.floor(index / columnsPerRow);
    if (!rows[rowIndex]) rows[rowIndex] = [];
    rows[rowIndex]!.push(item);
  });

  const labelWidth = node.items.length ? Math.max(...node.items.map((item) => item.label.length)) : 0;

  return (
    <InkBox flexDirection="column">
      {rows.map((row, idx) => (
        <InkBox key={`kv-row-${idx}`} flexDirection="row">
          {row.map((item, colIndex) => (
            <InkBox key={`kv-${idx}-${colIndex}`} flexDirection="row" marginRight={4}>
              <InkText color={palette.accent.muted}>
                {item.label.padEnd(labelWidth)}
              </InkText>
              <InkText color={toneToColor(item.tone ?? 'default')} dimColor={item.dim}>
                {'  ' + item.value}
              </InkText>
            </InkBox>
          ))}
        </InkBox>
      ))}
    </InkBox>
  );
}

function renderTableNode(node: TableNode): React.ReactElement {
  const { Box: InkBox, Text: InkText } = useInk();
  const columns = node.columns;
  const MAX_COL_WIDTH = 100;
  const MIN_COL_WIDTH = 6;
  const rowGap = node.rowGap ?? 0;
  const sanitized = (value: string) => value.replace(/\s+/g, ' ').trim();
  const truncate = (value: string, width: number) => {
    if (value.length <= width) return value;
    if (width <= 1) return value.slice(0, 1);
    return value.slice(0, width - 1) + '…';
  };
  const clampWidth = (length: number) => Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, length));
  const termWidth = typeof process !== 'undefined' && process.stdout && Number.isFinite(process.stdout.columns)
    ? Math.max(40, process.stdout.columns - 8) // Remove upper limit of 140 to allow wider tables
    : 120;
  const gapSize = 1;
  // Mark columns as unsqueezable if they have explicit width OR noTruncate flag
  const unsqueezableColumns = columns.map((col) => col.width !== undefined || col.noTruncate === true);
  const baseWidths = columns.map((col) => {
    // Use explicit width if provided, otherwise calculate from label
    if (col.width !== undefined) {
      return col.width; // Don't clamp explicit widths
    }
    // For noTruncate columns, don't clamp the width
    if (col.noTruncate) {
      return col.label.length;
    }
    return clampWidth(col.label.length);
  });
  node.rows.forEach((row) => {
    columns.forEach((col, idx) => {
      // Skip width calculation for columns with explicit width
      if (col.width !== undefined) return;

      const raw = row[col.key];
      const value = raw == null ? '' : String(raw);
      const contentLength = sanitized(value).length;

      // For noTruncate columns, use actual content length without clamping
      if (col.noTruncate) {
        baseWidths[idx] = Math.max(baseWidths[idx], contentLength);
      } else {
        baseWidths[idx] = Math.max(baseWidths[idx], clampWidth(contentLength));
      }
    });
  });
  // Calculate minimum required width to preserve all unsqueezable columns
  const unsqueezableTotal = baseWidths.reduce((sum, width, idx) =>
    unsqueezableColumns[idx] ? sum + width : sum, 0
  );
  const flexibleCount = unsqueezableColumns.filter(fixed => !fixed).length;
  const minFlexibleWidth = flexibleCount * MIN_COL_WIDTH;
  const gapTotal = gapSize * (baseWidths.length - 1);
  const minRequiredWidth = unsqueezableTotal + minFlexibleWidth + gapTotal;

  // Create an array of minimum widths per column (use natural width for unsqueezable, MIN_COL_WIDTH for flexible)
  const minWidthPerColumn = baseWidths.map((width, idx) =>
    unsqueezableColumns[idx] ? width : MIN_COL_WIDTH
  );

  // Allow wide tables to preserve content (may overflow narrow terminals)
  const allowedWidth = Math.max(termWidth, sumWithGaps(baseWidths, gapSize));
  const widths = squeezeWidthsWithMinimums(baseWidths.slice(), gapSize, allowedWidth, minWidthPerColumn, unsqueezableColumns);

  // Expand flexible columns to fill available terminal width
  const finalTotal = sumWithGaps(widths, gapSize);
  const remaining = termWidth - finalTotal;
  if (remaining > 0) {
    // Find the last flexible (non-unsqueezable) column and expand it
    for (let i = widths.length - 1; i >= 0; i--) {
      if (!unsqueezableColumns[i]) {
        widths[i] = Math.min(widths[i] + remaining, MAX_COL_WIDTH);
        break;
      }
    }
  }

  // Calculate actual table width: for noTruncate columns, use their actual content width
  const actualWidths = widths.map((w, idx) => {
    if (!columns[idx].noTruncate) return w;
    // For noTruncate columns, use the maximum content width across all rows
    const maxContentWidth = Math.max(
      columns[idx].label.length,
      ...node.rows.map(row => {
        const val = row[columns[idx].key];
        return val ? sanitized(String(val)).length : 0;
      })
    );
    return maxContentWidth;
  });
  const tableWidth = sumWithGaps(actualWidths, gapSize);

  const renderRow = (row: Record<string, string>, isHeader = false) => (
    <InkBox flexDirection="row">
      {columns.map((col, idx) => {
        const raw = isHeader ? col.label : row[col.key] ?? '';
        const prepared = col.noTruncate
          ? sanitized(String(raw))
          : truncate(sanitized(String(raw)), widths[idx]);
        const aligned = col.noTruncate
          ? prepared
          : alignCell(prepared, widths[idx], col.align ?? 'left');
        const color = isHeader ? accentToColor('secondary') : palette.foreground.default;

        // Add gap after all columns except the last one
        const needsGap = idx < columns.length - 1;

        // Always wrap in Box for consistent layout
        const boxProps: any = {
          marginRight: needsGap ? gapSize : 0
        };

        // For noTruncate columns, set minWidth to prevent squeezing and use truncate-end to prevent wrapping
        // For normal columns, set fixed width and use truncate wrap
        if (col.noTruncate) {
          boxProps.minWidth = actualWidths[idx];
        } else {
          boxProps.width = widths[idx];
        }

        return (
          <InkBox key={`${col.key}-${idx}`} {...boxProps}>
            <InkText color={color} bold={isHeader} wrap={col.noTruncate ? 'truncate-end' as any : 'truncate'}>
              {aligned}
            </InkText>
          </InkBox>
        );
      })}
    </InkBox>
  );

  const containerProps = node.border === 'none'
    ? { flexDirection: 'column' as const, width: tableWidth }
    : {
        flexDirection: 'column' as const,
        borderStyle: 'round' as const,
        borderColor: accentToColor('muted'),
        paddingX: 0,
        paddingY: 0,
        width: tableWidth
      };

  const showDivider = node.divider !== false && node.rows.length > 0;

  return (
    <InkBox {...containerProps}>
      {renderRow(Object.fromEntries(columns.map((c) => [c.key, c.label])), true)}
      {showDivider ? (
        <InkBox>
          <InkText color={accentToColor('muted')} dimColor>
            {'─'.repeat(tableWidth)}
          </InkText>
        </InkBox>
      ) : null}
      {node.rows.length === 0 && node.emptyText ? (
        <InkBox>
          <InkText color={palette.foreground.placeholder}>{node.emptyText}</InkText>
        </InkBox>
      ) : (
        <Fragment>
          {node.rows.map((row, idx) => (
            <InkBox key={`row-${idx}`} marginBottom={idx < node.rows.length - 1 ? rowGap : 0}>
              {renderRow(row)}
            </InkBox>
          ))}
        </Fragment>
      )}
    </InkBox>
  );

  function alignCell(text: string, width: number, align: 'left' | 'right' | 'center'): string {
    const padLeft = (count: number) => (count > 0 ? ' '.repeat(count) : '');
    if (align === 'right') return text.padStart(width);
    if (align === 'center') {
      const left = Math.floor((width - text.length) / 2);
      const right = width - text.length - left;
      return padLeft(left) + text + padLeft(right);
    }
    return text.padEnd(width);
  }
}

function squeezeWidthsWithMinimums(
  widths: number[],
  gapSize: number,
  targetWidth: number,
  minWidthPerColumn: number[],
  fixedWidthColumns: boolean[] = []
): number[] {
  const total = () => sumWithGaps(widths, gapSize);

  // If we're already at or below target, no squeezing needed
  if (total() <= targetWidth) return widths;

  // Check if any column can be shrunk (not at its minimum)
  const shrinkable = () => widths.some((width, idx) => width > minWidthPerColumn[idx]);

  while (total() > targetWidth && shrinkable()) {
    let largestIdx = -1;
    let largestWidth = -1;

    // Find the largest column that can still be shrunk
    for (let i = 0; i < widths.length; i += 1) {
      if (widths[i] <= minWidthPerColumn[i]) continue; // Skip columns at minimum
      if (widths[i] > largestWidth) {
        largestIdx = i;
        largestWidth = widths[i];
      }
    }

    // If no column can be shrunk further, stop (table will overflow terminal)
    if (largestIdx === -1) break;
    widths[largestIdx] -= 1;
  }

  // Return widths even if they exceed target - fixed-width columns must be preserved
  return widths;
}

function sumWithGaps(widths: number[], gapSize: number): number {
  if (!widths.length) return 0;
  return widths.reduce((sum, width, idx) => sum + width + (idx < widths.length - 1 ? gapSize : 0), 0);
}

function renderDividerNode(node: DividerNode): React.ReactElement {
  const { Text: InkText } = useInk();
  const variant = node.variant ?? 'solid';
  const accentColor = accentToColor(node.accent ?? 'muted');
  const char = variant === 'double' ? '═' : variant === 'dashed' ? '┄' : '─';
  return (
    <InkText color={accentColor}>{char.repeat(72)}</InkText>
  );
}

function renderCalloutNode(node: CalloutNode): React.ReactElement {
  const { Box: InkBox, Text: InkText } = useInk();
  const toneColor = toneToColor(node.tone);
  const icon = node.icon || deriveCalloutIcon(node.tone);
  const border = node.tone === 'danger' ? 'double' : 'round';
  return (
    <InkBox flexDirection="column" borderStyle={border as any} borderColor={toneColor} paddingX={1} paddingY={0}>
      {node.title ? (
        <InkText color={toneColor} bold>
          {icon ? `${icon} ` : ''}{node.title}
        </InkText>
      ) : null}
      {node.body.map((line, idx) => (
        <InkText key={`callout-line-${idx}`} color={palette.foreground.default}>
          {line}
        </InkText>
      ))}
    </InkBox>
  );
}

function deriveCalloutIcon(tone: CalloutNode['tone']): string {
  switch (tone) {
    case 'success':
      return '✅';
    case 'warning':
      return '⚠️';
    case 'danger':
      return '❌';
    case 'info':
    default:
      return 'ℹ️';
  }
}

function renderListNode(node: ListNode): React.ReactElement {
  const { Box: InkBox, Text: InkText } = useInk();
  return (
    <InkBox flexDirection="column">
      {node.items.map((item, idx) => (
        <InkText key={`list-${idx}`} color={toneToColor(node.tone ?? 'default')}>
          {node.ordered ? `${idx + 1}. ${item}` : `• ${item}`}
        </InkText>
      ))}
    </InkBox>
  );
}

function renderBadgeNode(node: BadgeNode): React.ReactElement {
  const { Box: InkBox, Text: InkText } = useInk();
  const color = toneToColor(node.tone === 'muted' ? 'muted' : node.tone);
  return (
    <InkBox borderStyle="round" borderColor={color} paddingX={1} paddingY={0}>
      <InkText color={color}>{node.text}</InkText>
    </InkBox>
  );
}

function renderLogNode(node: LogNode): React.ReactElement {
  const { Box: InkBox, Text: InkText } = useInk();
  const lines = node.maxLines ? node.lines.slice(-node.maxLines) : node.lines;
  return (
    <InkBox flexDirection="column">
      {lines.map((line, idx) => (
        <InkText key={`log-${idx}`} color={toneToColor(line.tone ?? 'default')} bold={line.emphasis}>
          {line.text}
        </InkText>
      ))}
    </InkBox>
  );
}

function renderTimelineNode(node: TimelineNode): React.ReactElement {
  const { Box: InkBox, Text: InkText } = useInk();
  return (
    <InkBox flexDirection="column">
      {node.items.map((item, idx) => {
        const isLast = idx === node.items.length - 1;
        const statusIcon = resolveTimelineIcon(item.status);
        return (
          <InkBox key={`timeline-${idx}`} flexDirection="row">
            <InkBox flexDirection="column" marginRight={1}>
              <InkText>{statusIcon}</InkText>
              {!isLast ? <InkText>│</InkText> : <InkText> </InkText>}
            </InkBox>
            <InkBox flexDirection="column">
              <InkText color={palette.foreground.default} bold>
                {item.title}
              </InkText>
              {item.subtitle ? (
                <InkText color={palette.foreground.muted}>{item.subtitle}</InkText>
              ) : null}
              {item.meta ? (
                <InkText color={palette.foreground.placeholder}>{item.meta}</InkText>
              ) : null}
            </InkBox>
          </InkBox>
        );
      })}
    </InkBox>
  );
}

function resolveTimelineIcon(status: TimelineNode['items'][number]['status']): string {
  switch (status) {
    case 'done':
      return '●';
    case 'failed':
      return '✖';
    case 'pending':
    default:
      return '○';
  }
}
