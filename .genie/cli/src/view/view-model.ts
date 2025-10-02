export type Tone = 'default' | 'muted' | 'success' | 'warning' | 'danger' | 'info';

export type HeadingAccent = 'primary' | 'secondary' | 'muted';

export type DividerVariant = 'solid' | 'dashed' | 'double';

export interface LayoutNode {
  type: 'layout';
  direction?: 'row' | 'column';
  gap?: number;
  padding?: [number, number, number, number];
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch';
  justifyContent?: 'flex-start' | 'center' | 'space-between';
  children: ViewNode[];
}

export interface HeadingNode {
  type: 'heading';
  level: 1 | 2 | 3;
  text: string;
  accent?: HeadingAccent;
  align?: 'left' | 'center';
}

export interface TextNode {
  type: 'text';
  text: string;
  tone?: Tone;
  wrap?: boolean;
  align?: 'left' | 'center';
  dim?: boolean;
  italic?: boolean;
}

export interface KeyValueNode {
  type: 'keyValue';
  columns?: 1 | 2;
  items: Array<{ label: string; value: string; tone?: Tone; dim?: boolean }>; 
}

export interface TableColumn {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: number;
  noTruncate?: boolean;
}

export interface TableNode {
  type: 'table';
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
  emptyText?: string;
  rowGap?: number;
  border?: 'round' | 'none';
  divider?: boolean;
}

export interface DividerNode {
  type: 'divider';
  variant?: DividerVariant;
  accent?: HeadingAccent;
}

export interface CalloutNode {
  type: 'callout';
  tone: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  body: string[];
  icon?: string;
}

export interface ListNode {
  type: 'list';
  items: string[];
  ordered?: boolean;
  tone?: Tone;
}

export interface BadgeNode {
  type: 'badge';
  text: string;
  tone: 'info' | 'success' | 'warning' | 'danger' | 'muted';
}

export interface LogLine {
  text: string;
  tone?: Tone;
  emphasis?: boolean;
}

export interface LogNode {
  type: 'log';
  lines: LogLine[];
  wrap?: boolean;
  maxLines?: number;
}

export interface TimelineItem {
  title: string;
  subtitle?: string;
  meta?: string;
  status?: 'done' | 'pending' | 'failed';
}

export interface TimelineNode {
  type: 'timeline';
  items: TimelineItem[];
}

export interface SpaceNode {
  type: 'space';
  size: number;
}

export type ViewNode =
  | LayoutNode
  | HeadingNode
  | TextNode
  | KeyValueNode
  | TableNode
  | DividerNode
  | CalloutNode
  | ListNode
  | BadgeNode
  | LogNode
  | TimelineNode
  | SpaceNode;

export type ViewStyle = 'genie';

export interface ViewEnvelope {
  style: ViewStyle;
  title?: string;
  ariaLabel?: string;
  body: ViewNode;
  meta?: Record<string, unknown>;
}

export interface RenderOptions {
  json?: boolean;
  stream?: NodeJS.WriteStream;
  style?: ViewStyle;
}

export interface RenderResult {
  text?: string;
}
