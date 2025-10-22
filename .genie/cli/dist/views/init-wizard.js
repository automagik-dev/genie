import React, { useState } from 'react';
// @ts-ignore - ESM module
import { Box, Text, useInput } from 'ink';
// @ts-ignore - ESM module
import SelectInput from 'ink-select-input';
// @ts-ignore - ESM module
import TextInput from 'ink-text-input';
// @ts-ignore - ESM module
import Gradient from 'ink-gradient';
// @ts-ignore - ESM module
import Spinner from 'ink-spinner';
export const InitWizard = ({ templates, executors, hasGit, onComplete }) => {
    const [step, setStep] = useState(hasGit ? 'template' : 'git');
    const [initGit, setInitGit] = useState(false);
    const [template, setTemplate] = useState('');
    const [executor, setExecutor] = useState('');
    const [model, setModel] = useState('');
    useInput((input, key) => {
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
    return (React.createElement(Box, { flexDirection: "column", padding: 1 },
        React.createElement(Box, { marginBottom: 1 },
            React.createElement(Gradient, { name: "cristal" },
                React.createElement(Text, { bold: true }, "\uD83E\uDDDE \u2728 GENIE INIT \u2728 \uD83E\uDDDE"))),
        step === 'git' && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Box, { marginBottom: 1 },
                React.createElement(Text, { color: "yellow" }, "\u26A0\uFE0F  No git repository detected")),
            React.createElement(Box, { marginBottom: 1 },
                React.createElement(Text, { dimColor: true }, "Forge requires git for work tracking")),
            React.createElement(SelectInput, { items: [
                    { label: 'Initialize git now (recommended)', value: 'yes' },
                    { label: 'Skip (may cause issues)', value: 'no' }
                ], onSelect: handleGitSelect }))),
        step === 'template' && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Box, { marginBottom: 1 },
                React.createElement(Text, { bold: true }, "Choose template:")),
            templates.map((t, idx) => (React.createElement(Box, { key: t.value, marginBottom: idx < templates.length - 1 ? 1 : 0 },
                React.createElement(Text, { dimColor: true },
                    "  ",
                    t.label,
                    " - ",
                    t.description)))),
            React.createElement(Box, { marginTop: 1 },
                React.createElement(SelectInput, { items: templates.map(t => ({ label: t.label, value: t.value })), onSelect: handleTemplateSelect })))),
        step === 'executor' && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Box, { marginBottom: 1 },
                React.createElement(Text, { bold: true }, "Select executor:")),
            React.createElement(Box, { marginBottom: 1 },
                React.createElement(Text, { dimColor: true }, "(Can be changed later in config)")),
            React.createElement(SelectInput, { items: executors, onSelect: handleExecutorSelect }))),
        step === 'model' && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Box, { marginBottom: 1 },
                React.createElement(Text, { bold: true },
                    "Default model for ",
                    executor,
                    ":")),
            React.createElement(Box, { marginBottom: 1 },
                React.createElement(Text, { dimColor: true },
                    "Press Enter for default: ",
                    getDefaultModel())),
            React.createElement(Box, null,
                React.createElement(Text, { color: "cyan" }, "\u203A "),
                React.createElement(TextInput, { value: model, onChange: setModel, onSubmit: handleModelSubmit, placeholder: getDefaultModel() })))),
        step === 'starting' && (React.createElement(Box, null,
            React.createElement(Text, { color: "green" },
                React.createElement(Spinner, { type: "dots" }),
                " Starting install agent..."))),
        step !== 'starting' && (React.createElement(Box, { marginTop: 1 },
            React.createElement(Text, { dimColor: true }, "ESC to cancel")))));
};
export async function runInitWizard(options) {
    // @ts-ignore - Dynamic import for ESM module
    const { render } = await import('ink');
    return new Promise((resolve) => {
        const { waitUntilExit } = render(React.createElement(InitWizard, { ...options, onComplete: (config) => {
                resolve(config);
            } }));
        waitUntilExit().catch(() => {
            process.exit(0);
        });
    });
}
