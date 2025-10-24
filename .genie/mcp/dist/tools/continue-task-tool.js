"use strict";
/**
 * Continue Task Tool - Send follow-up work to existing task or create new attempt
 *
 * Allows continuing work on an existing task attempt via follow-up prompt.
 * Used primarily by master orchestrators to receive new work.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.continueTaskToolSchema = void 0;
exports.executeContinueTaskTool = executeContinueTaskTool;
const zod_1 = require("zod");
const path_1 = __importDefault(require("path"));
// Load ForgeClient
const geniePackageRoot = path_1.default.resolve(__dirname, '../../../..');
const ForgeClient = require(path_1.default.join(geniePackageRoot, 'forge.js')).ForgeClient;
const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';
/**
 * Continue task parameters
 */
exports.continueTaskToolSchema = zod_1.z.object({
    attempt_id: zod_1.z.string().describe('Task attempt ID to send work to'),
    prompt: zod_1.z.string().describe('Follow-up prompt with new work')
});
/**
 * Continue task execution
 */
async function executeContinueTaskTool(args, context) {
    const { streamContent } = context;
    let fullOutput = `🔄 Sending follow-up to task attempt: ${args.attempt_id}\n\n`;
    await streamContent({
        type: 'text',
        text: fullOutput
    });
    const forgeClient = new ForgeClient(FORGE_URL);
    try {
        await forgeClient.followUpTaskAttempt(args.attempt_id, args.prompt);
        const successMsg = `✅ Follow-up sent successfully\n\n` +
            `📝 Prompt:\n${args.prompt}\n\n` +
            `💡 The master orchestrator will process this work in the background.\n`;
        fullOutput += successMsg;
        await streamContent({
            type: 'text',
            text: successMsg
        });
        return fullOutput;
    }
    catch (error) {
        const errorMsg = `❌ Failed to send follow-up: ${error.message}\n`;
        fullOutput += errorMsg;
        await streamContent({
            type: 'text',
            text: errorMsg
        });
        return fullOutput;
    }
}
