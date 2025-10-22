import prompts from 'prompts';
import gradient from 'gradient-string';

interface InstallChatOptions {
  mcpClient: any;
  agent: string;
  template: string;
}

export async function runInstallChat(options: InstallChatOptions): Promise<void> {
  console.log('\n' + gradient.cristal(`🧞 Install Agent (${options.template})`) + '\n');
  console.log('Starting install agent...\n');

  try {
    // Start MCP session with install agent
    const result = await options.mcpClient.run({
      agent: options.agent,
      prompt: `Initialize ${options.template} template. Guide the user through setup.`,
      name: `install-${options.template}-${Date.now()}`
    });

    const sessionId = result.sessionId;
    console.log(`🤖 Agent: ${result.response || 'Hello! I\'m the install agent. Let me help you set up Genie.'}\n`);

    // Interactive chat loop
    let isDone = false;
    while (!isDone) {
      const { userInput } = await prompts({
        type: 'text',
        name: 'userInput',
        message: '👤 You:',
      }, {
        onCancel: () => {
          console.log('\n❌ Cancelled');
          process.exit(0);
        }
      });

      if (!userInput || !userInput.trim()) continue;

      console.log('\n⏳ Agent is thinking...\n');

      try {
        const result = await options.mcpClient.resume({
          sessionId,
          prompt: userInput
        });

        console.log(`🤖 Agent: ${result.response || ''}\n`);

        // Check if agent signals completion
        if (result.status === 'completed' || result.response?.includes('[INSTALL_COMPLETE]')) {
          console.log('✅ Installation complete!\n');
          isDone = true;
        }
      } catch (error) {
        console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } catch (error) {
    console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  }
}
