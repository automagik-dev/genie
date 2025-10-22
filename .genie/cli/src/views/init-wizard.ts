import prompts from 'prompts';
import gradient from 'gradient-string';

interface WizardConfig {
  template: string;
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

  // Template selection
  questions.push({
    type: 'select',
    name: 'template',
    message: 'Choose template:',
    choices: options.templates.map(t => ({
      title: t.label,
      description: t.description,
      value: t.value
    })),
    initial: 0
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
    template: response.template,
    executor: response.executor,
    model: response.model || defaultModel,
    initGit: response.initGit ?? options.hasGit
  };
}
