import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { emitView } from '../lib/view-helpers';
import { buildInfoView } from '../views/common';

export async function runStatus(
  parsed: ParsedCommand,
  _config: GenieConfig,
  _paths: Required<ConfigPaths>
): Promise<void> {
  const messages = [
    'The legacy `status` command is deprecated.',
    'Consult the documentation for current workflows.',
    'Documentation: https://github.com/namastexlabs/automagik-genie/docs/migration-guide.md'
  ];
  await emitView(buildInfoView('Status command deprecated', messages), parsed.options);
}
