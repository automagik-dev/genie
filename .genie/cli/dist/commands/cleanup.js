import { emitView } from '../lib/view-helpers';
import { buildInfoView } from '../views/common';
export async function runCleanup(parsed, _config, _paths) {
    const messages = [
        'The legacy `cleanup` command is deprecated.',
        'Backups can be pruned manually under `.genie/backups/`. Guidance available in the migration guide.',
        'Documentation: https://github.com/namastexlabs/automagik-genie/docs/migration-guide.md'
    ];
    await emitView(buildInfoView('Cleanup command deprecated', messages), parsed.options);
}
