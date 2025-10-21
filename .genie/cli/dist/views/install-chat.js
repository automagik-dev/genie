"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InstallChat = void 0;
exports.runInstallChat = runInstallChat;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const ink_1 = require("ink");
const ink_text_input_1 = __importDefault(require("ink-text-input"));
const ink_spinner_1 = __importDefault(require("ink-spinner"));
const InstallChat = ({ mcpClient, agent, template, onComplete, onRestart }) => {
    const { exit } = (0, ink_1.useApp)();
    const [messages, setMessages] = (0, react_1.useState)([]);
    const [userInput, setUserInput] = (0, react_1.useState)('');
    const [isAgentThinking, setIsAgentThinking] = (0, react_1.useState)(false);
    const [sessionId, setSessionId] = (0, react_1.useState)(null);
    const scrollRef = (0, react_1.useRef)(0);
    // Initialize session with install agent
    (0, react_1.useEffect)(() => {
        initializeSession();
    }, []);
    const initializeSession = async () => {
        try {
            setIsAgentThinking(true);
            addSystemMessage('Starting install agent...');
            // Start MCP session with install agent
            const result = await mcpClient.run({
                agent,
                prompt: `Initialize ${template} template. Guide the user through setup.`,
                name: `install-${template}-${Date.now()}`
            });
            setSessionId(result.sessionId);
            // Add agent's first message
            addAgentMessage(result.response || 'Hello! I\'m the install agent. Let me help you set up Genie.');
            setIsAgentThinking(false);
        }
        catch (error) {
            addSystemMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
            setIsAgentThinking(false);
        }
    };
    const handleSubmit = async (input) => {
        if (!input.trim() || !sessionId)
            return;
        // Add user message
        addUserMessage(input);
        setUserInput('');
        setIsAgentThinking(true);
        try {
            // Send message to MCP agent
            const result = await mcpClient.resume({
                sessionId,
                prompt: input
            });
            // Add agent response
            addAgentMessage(result.response || '');
            // Check if agent signals completion
            if (result.status === 'completed' || result.response?.includes('[INSTALL_COMPLETE]')) {
                addSystemMessage('✅ Installation complete!');
                setTimeout(() => onComplete(), 2000);
            }
        }
        catch (error) {
            addSystemMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            setIsAgentThinking(false);
        }
    };
    const addMessage = (role, content) => {
        setMessages(prev => [...prev, { role, content, timestamp: new Date() }]);
        scrollRef.current = Math.min(scrollRef.current + 1, messages.length);
    };
    const addAgentMessage = (content) => addMessage('agent', content);
    const addUserMessage = (content) => addMessage('user', content);
    const addSystemMessage = (content) => addMessage('system', content);
    // Handle keyboard shortcuts
    (0, ink_1.useInput)((input, key) => {
        // Ctrl+N: Skip/continue
        if (key.ctrl && input === 'n') {
            addSystemMessage('Skipping...');
            setTimeout(() => onComplete(), 500);
        }
        // Ctrl+Shift+N: Restart
        if (key.ctrl && key.shift && input === 'N') {
            addSystemMessage('Restarting install...');
            setTimeout(() => onRestart(), 500);
        }
        // ESC: Exit
        if (key.escape) {
            exit();
        }
    });
    // Scroll behavior: show last N messages
    const visibleMessages = messages.slice(Math.max(0, messages.length - 15));
    return ((0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", height: "100%", children: [(0, jsx_runtime_1.jsxs)(ink_1.Box, { borderStyle: "single", borderColor: "cyan", paddingX: 1, children: [(0, jsx_runtime_1.jsxs)(ink_1.Text, { bold: true, color: "cyan", children: ["\uD83E\uDDDE Install Agent (", template, ")"] }), (0, jsx_runtime_1.jsx)(ink_1.Box, { flexGrow: 1 }), (0, jsx_runtime_1.jsx)(ink_1.Text, { dimColor: true, children: "Ctrl+N: Skip | Ctrl+Shift+N: Restart | ESC: Exit" })] }), (0, jsx_runtime_1.jsxs)(ink_1.Box, { flexDirection: "column", flexGrow: 1, paddingX: 1, paddingY: 1, children: [visibleMessages.map((msg, idx) => ((0, jsx_runtime_1.jsxs)(ink_1.Box, { marginBottom: 1, flexDirection: "column", children: [msg.role === 'agent' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { children: [(0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, color: "green", children: "\uD83E\uDD16 Agent: " }), (0, jsx_runtime_1.jsx)(ink_1.Text, { children: msg.content })] })), msg.role === 'user' && ((0, jsx_runtime_1.jsxs)(ink_1.Box, { children: [(0, jsx_runtime_1.jsx)(ink_1.Text, { bold: true, color: "blue", children: "\uD83D\uDC64 You: " }), (0, jsx_runtime_1.jsx)(ink_1.Text, { children: msg.content })] })), msg.role === 'system' && ((0, jsx_runtime_1.jsx)(ink_1.Box, { children: (0, jsx_runtime_1.jsxs)(ink_1.Text, { dimColor: true, children: ["\u2022 ", msg.content] }) }))] }, idx))), isAgentThinking && ((0, jsx_runtime_1.jsx)(ink_1.Box, { children: (0, jsx_runtime_1.jsxs)(ink_1.Text, { color: "yellow", children: [(0, jsx_runtime_1.jsx)(ink_spinner_1.default, { type: "dots" }), " Agent is thinking..."] }) }))] }), (0, jsx_runtime_1.jsxs)(ink_1.Box, { borderStyle: "single", borderColor: "gray", paddingX: 1, children: [(0, jsx_runtime_1.jsx)(ink_1.Text, { color: "cyan", children: "\u203A " }), (0, jsx_runtime_1.jsx)(ink_text_input_1.default, { value: userInput, onChange: setUserInput, onSubmit: handleSubmit, placeholder: "Type your response..." })] })] }));
};
exports.InstallChat = InstallChat;
async function runInstallChat(options) {
    const { render } = await import('ink');
    return new Promise((resolve, reject) => {
        let shouldRestart = false;
        const { waitUntilExit } = render((0, jsx_runtime_1.jsx)(exports.InstallChat, { ...options, onComplete: () => {
                resolve();
            }, onRestart: () => {
                shouldRestart = true;
                reject(new Error('RESTART'));
            } }));
        waitUntilExit().then(() => {
            if (!shouldRestart)
                resolve();
        }).catch(() => {
            if (!shouldRestart)
                reject(new Error('USER_CANCELLED'));
        });
    });
}
