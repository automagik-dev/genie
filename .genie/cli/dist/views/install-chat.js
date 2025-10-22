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
exports.InstallChat = void 0;
exports.runInstallChat = runInstallChat;
const react_1 = __importStar(require("react"));
// @ts-ignore - ESM module
const ink_1 = require("ink");
// @ts-ignore - ESM module
const ink_text_input_1 = __importDefault(require("ink-text-input"));
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
    return (react_1.default.createElement(ink_1.Box, { flexDirection: "column", height: "100%" },
        react_1.default.createElement(ink_1.Box, { borderStyle: "single", borderColor: "cyan", paddingX: 1 },
            react_1.default.createElement(ink_1.Text, { bold: true, color: "cyan" },
                "\uD83E\uDDDE Install Agent (",
                template,
                ")"),
            react_1.default.createElement(ink_1.Box, { flexGrow: 1 }),
            react_1.default.createElement(ink_1.Text, { dimColor: true }, "Ctrl+N: Skip | Ctrl+Shift+N: Restart | ESC: Exit")),
        react_1.default.createElement(ink_1.Box, { flexDirection: "column", flexGrow: 1, paddingX: 1, paddingY: 1 },
            visibleMessages.map((msg, idx) => (react_1.default.createElement(ink_1.Box, { key: idx, marginBottom: 1, flexDirection: "column" },
                msg.role === 'agent' && (react_1.default.createElement(ink_1.Box, null,
                    react_1.default.createElement(ink_1.Text, { bold: true, color: "green" }, "\uD83E\uDD16 Agent: "),
                    react_1.default.createElement(ink_1.Text, null, msg.content))),
                msg.role === 'user' && (react_1.default.createElement(ink_1.Box, null,
                    react_1.default.createElement(ink_1.Text, { bold: true, color: "blue" }, "\uD83D\uDC64 You: "),
                    react_1.default.createElement(ink_1.Text, null, msg.content))),
                msg.role === 'system' && (react_1.default.createElement(ink_1.Box, null,
                    react_1.default.createElement(ink_1.Text, { dimColor: true },
                        "\u2022 ",
                        msg.content)))))),
            isAgentThinking && (react_1.default.createElement(ink_1.Box, null,
                react_1.default.createElement(ink_1.Text, { color: "yellow" }, "\u23F3 Agent is thinking...")))),
        react_1.default.createElement(ink_1.Box, { borderStyle: "single", borderColor: "gray", paddingX: 1 },
            react_1.default.createElement(ink_1.Text, { color: "cyan" }, "\u203A "),
            react_1.default.createElement(ink_text_input_1.default, { value: userInput, onChange: setUserInput, onSubmit: handleSubmit, placeholder: "Type your response..." }))));
};
exports.InstallChat = InstallChat;
async function runInstallChat(options) {
    // @ts-ignore - Dynamic import for ESM module
    const { render } = await import('ink');
    return new Promise((resolve, reject) => {
        let shouldRestart = false;
        const { waitUntilExit } = render(react_1.default.createElement(exports.InstallChat, { ...options, onComplete: () => {
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
