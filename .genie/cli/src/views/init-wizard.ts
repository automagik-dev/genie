import prompts from 'prompts';
import gradient from 'gradient-string';

// Views compile in isolation (rootDir = .), so duplicate the canonical executor map here.
const EXECUTOR_LABELS: Record<string, string> = {
  GEMINI: 'Google Gemini',
  CODEX: 'ChatGPT',
  CLAUDE_CODE: 'Claude',
  CURSOR: 'Cursor',
  COPILOT: 'GitHub Copilot',
  OPENCODE: 'OpenCode',
  QWEN_CODE: 'Qwen Code',
  AMP: 'Amp'
};

const FRIENDLY_NAME_MAP: Record<string, string> = {
  claude: 'CLAUDE_CODE',
  chatgpt: 'CODEX'
};

function normalizeExecutorKey(input?: string | null): string | undefined {
  if (input == null) return undefined;
  const trimmed = input.trim();
  if (!trimmed.length) return undefined;

  const upper = trimmed.toUpperCase();
  if (upper in EXECUTOR_LABELS) {
    return upper;
  }

  const sanitized = trimmed.toLowerCase().replace(/\s+/g, '').replace(/-/g, '_');
  const sanitizedUpper = sanitized.toUpperCase();
  if (sanitizedUpper in EXECUTOR_LABELS) {
    return sanitizedUpper;
  }

  if (sanitized in FRIENDLY_NAME_MAP) {
    return FRIENDLY_NAME_MAP[sanitized];
  }

  const lower = trimmed.toLowerCase();
  if (lower in FRIENDLY_NAME_MAP) {
    return FRIENDLY_NAME_MAP[lower];
  }

  return upper;
}

function getExecutorLabel(executorKey: string): string {
  return EXECUTOR_LABELS[executorKey] ?? executorKey;
}

interface WizardConfig {
  templates: string[]; // Changed from single template to array
  executor: string;
  model?: string;
  initGit: boolean;
  installHooks: boolean;
  configureAuth: boolean; // Should we configure executor auth after wizard?
}

interface WizardOptions {
  templates: Array<{ value: string; label: string; description: string }>;
  executors: Array<{ value: string; label: string }>;
  hasGit: boolean;
}

export async function runInitWizard(options: WizardOptions): Promise<WizardConfig> {
  console.log('\n' + gradient.cristal('🧞 ✨ GENIE INIT ✨ 🧞') + '\n');

  // Check if subscription executor was set by start.sh (via ENV var)
  const subscriptionExecutor = normalizeExecutorKey(process.env.GENIE_SUBSCRIPTION_EXECUTOR);

  const questions: prompts.PromptObject[] = [];

  // Git initialization
  if (!options.hasGit) {
    questions.push({
      type: 'select',
      name: 'initGit',
      message: '⚠️  No git repository detected. Forge requires git for work tracking.',
      choices: [
        { title: 'Initialize git now (recommended)', value: true },
        { title: 'Skip (may cause issues)', value: false }
      ],
      initial: 0
    });
  }

  // Template selection (multi-select with spacebar)
  questions.push({
    type: 'multiselect',
    name: 'templates',
    message: 'Choose collectives (Space to select, Enter when done):',
    choices: options.templates.map(t => ({
      title: t.label,
      description: t.description,
      value: t.value,
      selected: false // Nothing pre-selected, user must choose
    })),
    hint: '💡 Don\'t worry - you can add more collectives later by asking me!',
    min: 1, // At least one collective required
    instructions: false // Hide default instructions
  });

  // Executor selection
  // If subscription was already chosen in start.sh, pre-select it
  const defaultExecutorIndex = subscriptionExecutor
    ? options.executors.findIndex(e => e.value === subscriptionExecutor)
    : 0;

  questions.push({
    type: 'select',
    name: 'executor',
    message: subscriptionExecutor
      ? `Select default executor (${subscriptionExecutor} was installed during setup):`
      : 'Select default executor (can be changed later in config):',
    choices: options.executors.map(e => ({
      title: e.label,
      value: e.value
    })),
    initial: defaultExecutorIndex >= 0 ? defaultExecutorIndex : 0
  });

  // Model input
  questions.push({
    type: 'text',
    name: 'model',
    message: (prev, values) => {
      const executorKey = normalizeExecutorKey(values.executor) ?? values.executor;
      const defaultModel = executorKey === 'CLAUDE_CODE' ? 'sonnet' : 'gpt-5-codex';
      const label = getExecutorLabel(executorKey);
      return `Default model for ${label} (press Enter for: ${defaultModel}):`;
    },
    initial: ''
  });

  // Git hooks installation (only offer if Code collective selected)
  questions.push({
    type: (prev, values) => {
      // Only show hooks prompt if 'code' collective was selected
      return values.templates?.includes('code') ? 'confirm' : null;
    },
    name: 'installHooks',
    message: '🔧 Install git hooks? (Advanced - auto-validates commits, runs tests, prevents broken pushes)',
    initial: false
  });

  const response = await prompts(questions, {
    onCancel: () => {
      console.log('\n❌ Cancelled');
      process.exit(0);
    }
  });

  const normalizedExecutor = normalizeExecutorKey(response.executor) ?? response.executor;
  const defaultModel = normalizedExecutor === 'CLAUDE_CODE' ? 'sonnet' : 'gpt-5-codex';

  return {
    templates: response.templates || [], // Array of selected templates
    executor: normalizedExecutor,
    model: response.model || defaultModel,
    initGit: response.initGit ?? options.hasGit,
    installHooks: response.installHooks ?? false,
    configureAuth: true // Signal to init.ts to configure auth
  };
}
