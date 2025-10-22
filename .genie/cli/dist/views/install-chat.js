import React, { useState, useEffect, useRef } from 'react';
// @ts-ignore - ESM module
import { Box, Text, useInput, useApp } from 'ink';
// @ts-ignore - ESM module
import TextInput from 'ink-text-input';
// @ts-ignore - ESM module
import Spinner from 'ink-spinner';
export const InstallChat = ({ mcpClient, agent, template, onComplete, onRestart }) => {
    const { exit } = useApp();
    const [messages, setMessages] = useState([]);
    const [userInput, setUserInput] = useState('');
    const [isAgentThinking, setIsAgentThinking] = useState(false);
    const [sessionId, setSessionId] = useState(null);
    const scrollRef = useRef(0);
    // Initialize session with install agent
    useEffect(() => {
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
    useInput((input, key) => {
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
    return (React.createElement(Box, { flexDirection: "column", height: "100%" },
        React.createElement(Box, { borderStyle: "single", borderColor: "cyan", paddingX: 1 },
            React.createElement(Text, { bold: true, color: "cyan" },
                "\uD83E\uDDDE Install Agent (",
                template,
                ")"),
            React.createElement(Box, { flexGrow: 1 }),
            React.createElement(Text, { dimColor: true }, "Ctrl+N: Skip | Ctrl+Shift+N: Restart | ESC: Exit")),
        React.createElement(Box, { flexDirection: "column", flexGrow: 1, paddingX: 1, paddingY: 1 },
            visibleMessages.map((msg, idx) => (React.createElement(Box, { key: idx, marginBottom: 1, flexDirection: "column" },
                msg.role === 'agent' && (React.createElement(Box, null,
                    React.createElement(Text, { bold: true, color: "green" }, "\uD83E\uDD16 Agent: "),
                    React.createElement(Text, null, msg.content))),
                msg.role === 'user' && (React.createElement(Box, null,
                    React.createElement(Text, { bold: true, color: "blue" }, "\uD83D\uDC64 You: "),
                    React.createElement(Text, null, msg.content))),
                msg.role === 'system' && (React.createElement(Box, null,
                    React.createElement(Text, { dimColor: true },
                        "\u2022 ",
                        msg.content)))))),
            isAgentThinking && (React.createElement(Box, null,
                React.createElement(Text, { color: "yellow" },
                    React.createElement(Spinner, { type: "dots" }),
                    " Agent is thinking...")))),
        React.createElement(Box, { borderStyle: "single", borderColor: "gray", paddingX: 1 },
            React.createElement(Text, { color: "cyan" }, "\u203A "),
            React.createElement(TextInput, { value: userInput, onChange: setUserInput, onSubmit: handleSubmit, placeholder: "Type your response..." }))));
};
export async function runInstallChat(options) {
    // @ts-ignore - Dynamic import for ESM module
    const { render } = await import('ink');
    return new Promise((resolve, reject) => {
        let shouldRestart = false;
        const { waitUntilExit } = render(React.createElement(InstallChat, { ...options, onComplete: () => {
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
