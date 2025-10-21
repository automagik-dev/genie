"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOnboardingWizard = runOnboardingWizard;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const ink_1 = require("ink");
const ink_spinner_1 = __importDefault(require("ink-spinner"));
const ink_select_input_1 = __importDefault(require("ink-select-input"));
const ink_text_input_1 = __importDefault(require("ink-text-input"));
const ink_gradient_1 = __importDefault(require("ink-gradient"));
const ink_big_text_1 = __importDefault(require("ink-big-text"));
const Onboarding = ({ templates, executors, hasGit, onComplete }) => {
    const [step, setStep] = (0, react_1.useState)('welcome');
    const [template, setTemplate] = (0, react_1.useState)('');
    const [executor, setExecutor] = (0, react_1.useState)('');
    const [model, setModel] = (0, react_1.useState)('');
    const [initGit, setInitGit] = (0, react_1.useState)(false);
    const [progress, setProgress] = (0, react_1.useState)(0);
    const { exit } = (0, ink_1.useApp)();
    // Auto-advance from welcome after 1.5s
    (0, react_1.useEffect)(() => {
        if (step === 'welcome') {
            const timer = setTimeout(() => {
                setStep(hasGit ? 'template-select' : 'git-check');
            }, 1500);
            return () => clearTimeout(timer);
        }
    }, [step, hasGit]);
    // Handle keyboard shortcuts
    (0, ink_1.useInput)((input, key) => {
        if (input === 'q' && step === 'welcome') {
            exit();
        }
        if (key.escape && (step === 'template-select' || step === 'executor-select')) {
            exit();
        }
    });
    const handleTemplateSelect = (item) => {
        setTemplate(item.value);
        setStep('executor-select');
    };
    const handleExecutorSelect = (item) => {
        setExecutor(item.value);
        setStep('model-input');
    };
    const handleModelSubmit = (value) => {
        setModel(value || getDefaultModel(executor));
        setStep('copying-files');
        // Simulate file copying progress
        let p = 0;
        const interval = setInterval(() => {
            p += 5;
            setProgress(p);
            if (p >= 100) {
                clearInterval(interval);
                setStep('installing');
                setTimeout(() => {
                    setStep('complete');
                    setTimeout(() => {
                        onComplete({ template, executor, model: value, initGit });
                        exit();
                    }, 3000);
                }, 2000);
            }
        }, 100);
    };
    const handleGitInit = (init) => {
        setInitGit(init);
        setStep('template-select');
    };
    const getDefaultModel = (exec) => {
        return exec === 'claude' ? 'sonnet' : 'gpt-5-codex';
    };
    return ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", padding: 1, children: [step === 'welcome' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", alignItems: "center", children: [(0, jsx_runtime_1.jsx)(ink_gradient_1.default, { name: "rainbow", children: (0, jsx_runtime_1.jsx)(ink_big_text_1.default, { text: "GENIE", font: "chrome" }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginTop: 1, children: (0, jsx_runtime_1.jsxs)(ink_1.Text, { children: [(0, jsx_runtime_1.jsx)(ink_spinner_1.default, { type: "dots" }), " ", (0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, children: "Initializing workspace magic..." })] }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginTop: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "Press 'q' to quit" }) })] })), step === 'git-check' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", children: [(0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { children: (0, jsx_runtime_1.jsx)(ink_1.Text, { color: "yellow", children: "\u26A0\uFE0F  No .git directory found" }) }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { children: "\uD83E\uDDDE Forge requires git to track work" }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 2, children: (0, jsx_runtime_1.jsx)(ink_select_input_1.default, { items: [
                                { label: 'Initialize git repository (recommended)', value: 'yes' },
                                { label: 'Skip (Forge may not work correctly)', value: 'no' }
                            ], onSelect: (item) => handleGitInit(item.value === 'yes') }) }), (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "Use arrow keys \u2191\u2193 and Enter to select" })] })), step === 'template-select' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", children: [(0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsx)(ink_gradient_1.default, { name: "pastel", children: (0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, children: "\uD83D\uDCCB Choose Your Template" }) }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { flexDirection: "column", marginBottom: 1, children: templates.map((t, idx) => ((0, jsx_runtime_1.jsxs)(ink_1.Box, { marginBottom: idx < templates.length - 1 ? 1 : 0, children: [(0, jsx_runtime_1.jsxs)(ink_1.Text, { children: [(0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, children: t.label }), " - ", t.description] }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginLeft: 2, children: (0, jsx_runtime_1.jsxs)(ink_1.Text, { dimColor: true, children: ["Agents: ", t.agents.join(', ')] }) })] }, t.value))) }), (0, jsx_runtime_1.jsx)(ink_select_input_1.default, { items: templates.map(t => ({ label: t.label, value: t.value })), onSelect: handleTemplateSelect }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginTop: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "Use arrow keys \u2191\u2193 and Enter to select | ESC to quit" }) })] })), step === 'executor-select' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", children: [(0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { children: (0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, color: "cyan", children: "\uD83D\uDD0C Select Default Executor" }) }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "This can be changed later in .genie/config.yaml" }) }), (0, jsx_runtime_1.jsx)(ink_select_input_1.default, { items: executors, onSelect: handleExecutorSelect }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginTop: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "Use arrow keys \u2191\u2193 and Enter to select | ESC to quit" }) })] })), step === 'model-input' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", children: [(0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { children: (0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, color: "magenta", children: "\uD83E\uDD16 Default Model" }) }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsxs)(ink_1.Text, { children: ["Enter default model for ", executor, " (or press Enter for default):"] }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsxs)(ink_1.Text, { children: [(0, jsx_runtime_1.jsx)(ink_1.Text, { color: "gray", children: "\u203A " }), (0, jsx_runtime_1.jsx)(ink_text_input_1.default, { value: model, onChange: setModel, onSubmit: handleModelSubmit, placeholder: getDefaultModel(executor) })] }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginTop: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "Press Enter to continue" }) })] })), step === 'copying-files' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", children: [(0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsxs)(ink_1.Text, { children: [(0, jsx_runtime_1.jsx)(ink_spinner_1.default, { type: "dots" }), " ", (0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, children: "Copying template files..." })] }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsxs)(ink_1.Text, { children: [(0, jsx_runtime_1.jsx)(ink_1.Text, { color: "cyan", children: '█'.repeat(Math.floor(progress / 2)) }), (0, jsx_runtime_1.jsx)(ink_1.Text, { color: "gray", children: '░'.repeat(50 - Math.floor(progress / 2)) }), (0, jsx_runtime_1.jsxs)(ink_1.Text, { children: [" ", progress, "%"] })] }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { children: (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "Setting up workspace structure..." }) })] })), step === 'installing' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", children: [(0, jsx_runtime_1.jsx)(ink_1.Box, { marginBottom: 1, children: (0, jsx_runtime_1.jsxs)(ink_1.Text, { children: [(0, jsx_runtime_1.jsx)(ink_spinner_1.default, { type: "dots12" }), " ", (0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, color: "green", children: "Running install agent..." })] }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { children: (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "This will set up your Genie workspace" }) })] })), step === 'complete' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", alignItems: "center", children: [(0, jsx_runtime_1.jsx)(ink_gradient_1.default, { name: "rainbow", children: (0, jsx_runtime_1.jsx)(ink_big_text_1.default, { text: "SUCCESS!", font: "chrome" }) }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginTop: 1, marginBottom: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { children: (0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, color: "green", children: "\u2705 Genie workspace initialized!" }) }) }), (0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", borderStyle: "round", borderColor: "green", padding: 1, children: [(0, jsx_runtime_1.jsx)(ink_1.Text, { children: (0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, children: "Next steps:" }) }), (0, jsx_runtime_1.jsxs)(ink_1.Text, { children: ["  \u2022 Run: ", (0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, color: "cyan", children: "genie" })] }), (0, jsx_runtime_1.jsx)(ink_1.Text, { children: "  \u2022 Or configure Claude Code MCP:" }), (0, jsx_runtime_1.jsxs)(ink_1.Text, { children: ["    ", (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "npx automagik-genie mcp -t stdio" })] })] }), (0, jsx_runtime_1.jsx)(ink_1.Box, { marginTop: 1, children: (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "Closing in 3 seconds..." }) })] }))] }));
};
async function runOnboardingWizard(options) {
    return new Promise((resolve) => {
        const { waitUntilExit } = (0, ink_1.render)((0, jsx_runtime_1.jsx)(Onboarding, { ...options, onComplete: (config) => {
                resolve(config);
            } }));
        waitUntilExit().catch(() => {
            process.exit(0);
        });
    });
}
