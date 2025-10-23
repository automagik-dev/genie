import prompts from 'prompts';
import gradient from 'gradient-string';

interface WizardConfig {
  templates: string[]; // Changed from single template to array
  executor: string;
  model?: string;
  initGit: boolean;
}

interface WizardOptions {
  templates: Array<{ value: string; label: string; description: string }>;
  executors: Array<{ value: string; label: string }>;
  hasGit: boolean;
}

export async function runInitWizard(options: WizardOptions): Promise<WizardConfig> {
  console.log('\n' + gradient.cristal('🧞 ✨ GENIE INIT ✨ 🧞') + '\n');

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
  questions.push({
    type: 'select',
    name: 'executor',
    message: 'Select executor (can be changed later in config):',
    choices: options.executors.map(e => ({
      title: e.label,
      value: e.value
    })),
    initial: 0
  });

  // Model input
  questions.push({
    type: 'text',
    name: 'model',
    message: (prev, values) => {
      const defaultModel = values.executor === 'claude' ? 'sonnet' : 'gpt-5-codex';
      return `Default model for ${values.executor} (press Enter for: ${defaultModel}):`;
    },
    initial: ''
  });

  const response = await prompts(questions, {
    onCancel: () => {
      console.log('\n❌ Cancelled');
      process.exit(0);
    }
  });

  const defaultModel = response.executor === 'claude' ? 'sonnet' : 'gpt-5-codex';

  return {
    templates: response.templates || [], // Array of selected templates
    executor: response.executor,
    model: response.model || defaultModel,
    initGit: response.initGit ?? options.hasGit
  };
}
