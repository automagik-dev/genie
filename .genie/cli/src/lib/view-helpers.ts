import { renderEnvelope, ViewEnvelope, ViewStyle } from '../view';
import type { CLIOptions } from './types';

export async function emitView(
  envelope: ViewEnvelope,
  options: CLIOptions,
  opts: { stream?: NodeJS.WriteStream; forceJson?: boolean } = {}
): Promise<void> {
  const style: ViewStyle = 'genie';
  const styledEnvelope: ViewEnvelope = { ...envelope, style };
  await renderEnvelope(styledEnvelope, {
    json: opts.forceJson ?? false,
    stream: opts.stream,
    style
  });
}

export type EmitView = typeof emitView;
