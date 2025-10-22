"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCleanup = runCleanup;
const view_helpers_1 = require("../lib/view-helpers");
const common_1 = require("../views/common");
async function runCleanup(parsed, _config, _paths) {
    const messages = [
        'The legacy `cleanup` command is deprecated.',
        'Backups can be pruned manually under `.genie/backups/`. Guidance available in the migration guide.',
        'Documentation: https://github.com/namastexlabs/automagik-genie/docs/migration-guide.md'
    ];
    await (0, view_helpers_1.emitView)((0, common_1.buildInfoView)('Cleanup command deprecated', messages), parsed.options);
}
