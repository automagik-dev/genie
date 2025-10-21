"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InitWizard = void 0;
exports.runInitWizard = runInitWizard;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const ink_1 = require("ink");
const ink_select_input_1 = __importDefault(require("ink-select-input"));
const ink_text_input_1 = __importDefault(require("ink-text-input"));
const ink_gradient_1 = __importDefault(require("ink-gradient"));
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
    return ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", padding: 1, children: [(0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsx)(ink_gradient_1.default, { name: "rainbow", children: (0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, children: "\uD83E\uDDDE GENIE INIT" }) }) }), step === 'git' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", children: [(0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { color: "yellow", children: "\u26A0\uFE0F  No git repository detected" }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "Forge requires git for work tracking" }) }), (0, jsx_runtime_1.jsx)(ink_select_input_1.default, { items: [
                            { label: 'Initialize git now (recommended)', value: 'yes' },
                            { label: 'Skip (may cause issues)', value: 'no' }
                        ], onSelect: handleGitSelect })] })), step === 'template' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", children: [(0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, children: "Choose template:" }) }), templates.map((t, idx) => ((0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: idx < templates.length - 1 ? 1 : 0, children: (0, jsx_runtime_1.jsxs)(ink_1.Text, { dimColor: true, children: ["  ", t.label, " - ", t.description] }) }, t.value))), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginTop: 1, children: (0, jsx_runtime_1.jsx)(ink_select_input_1.default, { items: templates.map(t => ({ label: t.label, value: t.value })), onSelect: handleTemplateSelect }) })] })), step === 'executor' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", children: [(0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, children: "Select executor:" }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "(Can be changed later in config)" }) }), (0, jsx_runtime_1.jsx)(ink_select_input_1.default, { items: executors, onSelect: handleExecutorSelect })] })), step === 'model' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", children: [(0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsxs)(ink_1.Text, { bold: true, children: ["Default model for ", executor, ":"] }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsxs)(ink_1.Text, { dimColor: true, children: ["Press Enter for default: ", getDefaultModel()] }) }), (0, jsx_runtime_1.jsxs)(ink_1.Box, { children: [(0, jsx_runtime_1.jsx)(ink_1.Text, { color: "cyan", children: "\u203A " }), (0, jsx_runtime_1.jsx)(ink_text_input_1.default, { value: model, onChange: setModel, onSubmit: handleModelSubmit, placeholder: getDefaultModel() })] })] })), step === 'starting' && ((0, jsx_runtime_1.jsx)(ink_1.Box, { children: (0, jsx_runtime_1.jsxs)(ink_1.Text, { color: "green", children: [(0, jsx_runtime_1.jsx)(ink_spinner_1.default, { type: "dots" }), " Starting install agent..."] }) })), step !== 'starting' && ((0, jsx_runtime_1.jsx)(ink_1.Box, { marginTop: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "ESC to cancel" }) }))] }));
};
exports.InitWizard = InitWizard;
async function runInitWizard(options) {
    const { render } = await import('ink');
    return new Promise((resolve) => {
        const { waitUntilExit } = render((0, jsx_runtime_1.jsx)(exports.InitWizard, { ...options, onComplete: (config) => {
                resolve(config);
            } }));
        waitUntilExit().catch(() => {
            process.exit(0);
        });
    });
}
