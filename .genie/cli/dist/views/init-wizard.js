"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InitWizard = void 0;
exports.runInitWizard = runInitWizard;
const react_1 = __importStar(require("react"));
// @ts-ignore - ESM module
const ink_1 = require("ink");
// @ts-ignore - ESM module
const ink_select_input_1 = __importDefault(require("ink-select-input"));
// @ts-ignore - ESM module
const ink_text_input_1 = __importDefault(require("ink-text-input"));
// @ts-ignore - ESM module
const ink_gradient_1 = __importDefault(require("ink-gradient"));
// @ts-ignore - ESM module
const ink_spinner_1 = __importDefault(require("ink-spinner"));
const InitWizard = ({ templates, executors, hasGit, onComplete }) => {
    const [step, setStep] = (0, react_1.useState)(hasGit ? 'template' : 'git');
    const [initGit, setInitGit] = (0, react_1.useState)(false);
    const [template, setTemplate] = (0, react_1.useState)('');
    const [executor, setExecutor] = (0, react_1.useState)('');
    const [model, setModel] = (0, react_1.useState)('');
    (0, ink_1.useInput)((input, key) => {
        if (key.escape) {
            process.exit(0);
        }
    });
    const handleGitSelect = (item) => {
        setInitGit(item.value === 'yes');
        setStep('template');
    };
    const handleTemplateSelect = (item) => {
        setTemplate(item.value);
        setStep('executor');
    };
    const handleExecutorSelect = (item) => {
        setExecutor(item.value);
        setStep('model');
    };
    const handleModelSubmit = (value) => {
        setModel(value);
        setStep('starting');
        // Give visual feedback before completing
        setTimeout(() => {
            onComplete({ template, executor, model: value || undefined, initGit });
        }, 500);
    };
    const getDefaultModel = () => {
        return executor === 'claude' ? 'sonnet' : 'gpt-5-codex';
    };
    return (react_1.default.createElement(ink_1.Box, { flexDirection: "column", padding: 1 },
        react_1.default.createElement(ink_1.Box, { marginBottom: 1 },
            react_1.default.createElement(ink_gradient_1.default, { name: "cristal" },
                react_1.default.createElement(ink_1.Text, { bold: true }, "\uD83E\uDDDE \u2728 GENIE INIT \u2728 \uD83E\uDDDE"))),
        step === 'git' && (react_1.default.createElement(ink_1.Box, { flexDirection: "column" },
            react_1.default.createElement(ink_1.Box, { marginBottom: 1 },
                react_1.default.createElement(ink_1.Text, { color: "yellow" }, "\u26A0\uFE0F  No git repository detected")),
            react_1.default.createElement(ink_1.Box, { marginBottom: 1 },
                react_1.default.createElement(ink_1.Text, { dimColor: true }, "Forge requires git for work tracking")),
            react_1.default.createElement(ink_select_input_1.default, { items: [
                    { label: 'Initialize git now (recommended)', value: 'yes' },
                    { label: 'Skip (may cause issues)', value: 'no' }
                ], onSelect: handleGitSelect }))),
        step === 'template' && (react_1.default.createElement(ink_1.Box, { flexDirection: "column" },
            react_1.default.createElement(ink_1.Box, { marginBottom: 1 },
                react_1.default.createElement(ink_1.Text, { bold: true }, "Choose template:")),
            templates.map((t, idx) => (react_1.default.createElement(ink_1.Box, { key: t.value, marginBottom: idx < templates.length - 1 ? 1 : 0 },
                react_1.default.createElement(ink_1.Text, { dimColor: true },
                    "  ",
                    t.label,
                    " - ",
                    t.description)))),
            react_1.default.createElement(ink_1.Box, { marginTop: 1 },
                react_1.default.createElement(ink_select_input_1.default, { items: templates.map(t => ({ label: t.label, value: t.value })), onSelect: handleTemplateSelect })))),
        step === 'executor' && (react_1.default.createElement(ink_1.Box, { flexDirection: "column" },
            react_1.default.createElement(ink_1.Box, { marginBottom: 1 },
                react_1.default.createElement(ink_1.Text, { bold: true }, "Select executor:")),
            react_1.default.createElement(ink_1.Box, { marginBottom: 1 },
                react_1.default.createElement(ink_1.Text, { dimColor: true }, "(Can be changed later in config)")),
            react_1.default.createElement(ink_select_input_1.default, { items: executors, onSelect: handleExecutorSelect }))),
        step === 'model' && (react_1.default.createElement(ink_1.Box, { flexDirection: "column" },
            react_1.default.createElement(ink_1.Box, { marginBottom: 1 },
                react_1.default.createElement(ink_1.Text, { bold: true },
                    "Default model for ",
                    executor,
                    ":")),
            react_1.default.createElement(ink_1.Box, { marginBottom: 1 },
                react_1.default.createElement(ink_1.Text, { dimColor: true },
                    "Press Enter for default: ",
                    getDefaultModel())),
            react_1.default.createElement(ink_1.Box, null,
                react_1.default.createElement(ink_1.Text, { color: "cyan" }, "\u203A "),
                react_1.default.createElement(ink_text_input_1.default, { value: model, onChange: setModel, onSubmit: handleModelSubmit, placeholder: getDefaultModel() })))),
        step === 'starting' && (react_1.default.createElement(ink_1.Box, null,
            react_1.default.createElement(ink_1.Text, { color: "green" },
                react_1.default.createElement(ink_spinner_1.default, { type: "dots" }),
                " Starting install agent..."))),
        step !== 'starting' && (react_1.default.createElement(ink_1.Box, { marginTop: 1 },
            react_1.default.createElement(ink_1.Text, { dimColor: true }, "ESC to cancel")))));
};
exports.InitWizard = InitWizard;
async function runInitWizard(options) {
    // @ts-ignore - Dynamic import for ESM module
    const { render } = await Promise.resolve().then(() => __importStar(require('ink')));
    return new Promise((resolve) => {
        const { waitUntilExit } = render(react_1.default.createElement(exports.InitWizard, { ...options, onComplete: (config) => {
                resolve(config);
            } }));
        waitUntilExit().catch(() => {
            process.exit(0);
        });
    });
}
