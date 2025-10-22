import React, { useState, useEffect, useRef } from 'react';
// @ts-ignore - ESM module
import { Box, Text, useInput, useApp } from 'ink';
// @ts-ignore - ESM module
import TextInput from 'ink-text-input';

interface Message {
  role: 'agent' | 'user' | 'system';
  content: string;
  timestamp: Date;
}

interface InstallChatProps {
  mcpClient: any; // MCP client instance
  agent: string; // Agent ID (e.g., 'code/install')
  template: string;
  onComplete: () => void;
  onRestart: () => void;
}

export const InstallChat: React.FC<InstallChatProps> = ({
  mcpClient,
  agent,
  template,
  onComplete,
  onRestart
}) => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [userInput, setUserInput] = useState('');
  const [isAgentThinking, setIsAgentThinking] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const scrollRef = useRef<number>(0);

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
    } catch (error) {
      addSystemMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
      setIsAgentThinking(false);
    }
  };

  const handleSubmit = async (input: string) => {
    if (!input.trim() || !sessionId) return;

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
    } catch (error) {
      addSystemMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsAgentThinking(false);
    }
  };

  const addMessage = (role: Message['role'], content: string) => {
    setMessages(prev => [...prev, { role, content, timestamp: new Date() }]);
    scrollRef.current = Math.min(scrollRef.current + 1, messages.length);
  };

  const addAgentMessage = (content: string) => addMessage('agent', content);
  const addUserMessage = (content: string) => addMessage('user', content);
  const addSystemMessage = (content: string) => addMessage('system', content);

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

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">🧞 Install Agent ({template})</Text>
        <Box flexGrow={1} />
        <Text dimColor>Ctrl+N: Skip | Ctrl+Shift+N: Restart | ESC: Exit</Text>
      </Box>

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        {visibleMessages.map((msg, idx) => (
          <Box key={idx} marginBottom={1} flexDirection="column">
            {msg.role === 'agent' && (
              <Box>
                <Text bold color="green">🤖 Agent: </Text>
                <Text>{msg.content}</Text>
              </Box>
            )}
            {msg.role === 'user' && (
              <Box>
                <Text bold color="blue">👤 You: </Text>
                <Text>{msg.content}</Text>
              </Box>
            )}
            {msg.role === 'system' && (
              <Box>
                <Text dimColor>• {msg.content}</Text>
              </Box>
            )}
          </Box>
        ))}

        {isAgentThinking && (
          <Box>
            <Text color="yellow">⏳ Agent is thinking...</Text>
          </Box>
        )}
      </Box>

      {/* Input */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="cyan">› </Text>
        <TextInput
          value={userInput}
          onChange={setUserInput}
          onSubmit={handleSubmit}
          placeholder="Type your response..."
        />
      </Box>
    </Box>
  );
};

export async function runInstallChat(options: {
  mcpClient: any;
  agent: string;
  template: string;
}): Promise<void> {
  // @ts-ignore - Dynamic import for ESM module
  const { render } = await import('ink');

  return new Promise((resolve, reject) => {
    let shouldRestart = false;

    const { waitUntilExit } = render(
      <InstallChat
        {...options}
        onComplete={() => {
          resolve();
        }}
        onRestart={() => {
          shouldRestart = true;
          reject(new Error('RESTART'));
        }}
      />
    );

    waitUntilExit().then(() => {
      if (!shouldRestart) resolve();
    }).catch(() => {
      if (!shouldRestart) reject(new Error('USER_CANCELLED'));
    });
  });
}
