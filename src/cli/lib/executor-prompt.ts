import * as readline from 'readline';

/**
 * Simple readline-based executor selection prompt (Group C - token-efficient output)
 * Replaces Ink-based interactive UI with minimal terminal prompt
 */
export async function promptExecutorChoice(
  availableExecutors: string[],
  defaultExecutor: string
): Promise<string> {
  // If only one executor, return it immediately
  if (availableExecutors.length === 1) {
    return availableExecutors[0];
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('\nSelect executor:');
    availableExecutors.forEach((executor, index) => {
      const isDefault = executor === defaultExecutor;
      const marker = isDefault ? '(default)' : '';
      console.log(`  ${index + 1}. ${executor} ${marker}`);
    });
    console.log('');

    const defaultIndex = availableExecutors.indexOf(defaultExecutor);
    const prompt = defaultIndex >= 0 ? `Choice [1-${availableExecutors.length}] (default: ${defaultIndex + 1}): ` : `Choice [1-${availableExecutors.length}]: `;

    rl.question(prompt, (answer) => {
      rl.close();

      // Handle empty input (use default)
      if (!answer.trim() && defaultIndex >= 0) {
        console.log(`Using default: ${defaultExecutor}\n`);
        resolve(defaultExecutor);
        return;
      }

      // Parse numeric input
      const choice = parseInt(answer.trim(), 10);
      if (isNaN(choice) || choice < 1 || choice > availableExecutors.length) {
        console.log(`Invalid choice. Using default: ${defaultExecutor}\n`);
        resolve(defaultExecutor);
        return;
      }

      const selected = availableExecutors[choice - 1];
      console.log(`Selected: ${selected}\n`);
      resolve(selected);
    });
  });
}
