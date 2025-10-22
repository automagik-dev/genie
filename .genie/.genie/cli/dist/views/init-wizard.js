"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runInitWizard = runInitWizard;
const prompts_1 = __importDefault(require("prompts"));
const gradient_string_1 = __importDefault(require("gradient-string"));
async function runInitWizard(options) {
    console.log('\n' + gradient_string_1.default.cristal('🧞 ✨ GENIE INIT ✨ 🧞') + '\n');
    const questions = [];
    // Git initialization
    if (!options.hasGit) {
        questions.push({
            type: 'select',
            name: 'initGit',
            message: '⚠️  No git repository detected. Forge requires git for work tracking.',
            choices: [
                { title: 'Initialize git now (recommended)', value: true },
                { title: 'Skip (may cause issues)', value: false }
            ],
            initial: 0
        });
    }
    // Template selection
    questions.push({
        type: 'select',
        name: 'template',
        message: 'Choose template:',
        choices: options.templates.map(t => ({
            title: t.label,
            description: t.description,
            value: t.value
        })),
        initial: 0
    });
    // Executor selection
    questions.push({
        type: 'select',
        name: 'executor',
        message: 'Select executor (can be changed later in config):',
        choices: options.executors.map(e => ({
            title: e.label,
            value: e.value
        })),
        initial: 0
    });
    // Model input
    questions.push({
        type: 'text',
        name: 'model',
        message: (prev, values) => {
            const defaultModel = values.executor === 'claude' ? 'sonnet' : 'gpt-5-codex';
            return `Default model for ${values.executor} (press Enter for: ${defaultModel}):`;
        },
        initial: ''
    });
    const response = await (0, prompts_1.default)(questions, {
        onCancel: () => {
            console.log('\n❌ Cancelled');
            process.exit(0);
        }
    });
    const defaultModel = response.executor === 'claude' ? 'sonnet' : 'gpt-5-codex';
    return {
        template: response.template,
        executor: response.executor,
        model: response.model || defaultModel,
        initGit: response.initGit ?? options.hasGit
    };
}
