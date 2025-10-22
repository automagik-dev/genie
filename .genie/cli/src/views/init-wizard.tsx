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

interface WizardProps {
  templates: Array<{ value: string; label: string; description: string }>;
  executors: Array<{ value: string; label: string }>;
  hasGit: boolean;
  onComplete: (config: {
    template: string;
    executor: string;
    model?: string;
    initGit: boolean;
  }) => void;
}

type Step = 'git' | 'template' | 'executor' | 'model' | 'starting';

export const InitWizard: React.FC<WizardProps> = ({
  templates,
  executors,
  hasGit,
  onComplete
}) => {
  const [step, setStep] = useState<Step>(hasGit ? 'template' : 'git');
  const [initGit, setInitGit] = useState(false);
  const [template, setTemplate] = useState('');
  const [executor, setExecutor] = useState('');
  const [model, setModel] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      process.exit(0);
    }
  });

  const handleGitSelect = (item: { value: string }) => {
    setInitGit(item.value === 'yes');
    setStep('template');
  };

  const handleTemplateSelect = (item: { value: string }) => {
    setTemplate(item.value);
    setStep('executor');
  };

  const handleExecutorSelect = (item: { value: string }) => {
    setExecutor(item.value);
    setStep('model');
  };

  const handleModelSubmit = (value: string) => {
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

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Gradient name="rainbow">
          <Text bold>🧞 GENIE INIT</Text>
        </Gradient>
      </Box>

      {/* Git Check */}
      {step === 'git' && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="yellow">⚠️  No git repository detected</Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>Forge requires git for work tracking</Text>
          </Box>
          <SelectInput
            items={[
              { label: 'Initialize git now (recommended)', value: 'yes' },
              { label: 'Skip (may cause issues)', value: 'no' }
            ]}
            onSelect={handleGitSelect}
          />
        </Box>
      )}

      {/* Template Selection */}
      {step === 'template' && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>Choose template:</Text>
          </Box>
          {templates.map((t, idx) => (
            <Box key={t.value} marginBottom={idx < templates.length - 1 ? 1 : 0}>
              <Text dimColor>  {t.label} - {t.description}</Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <SelectInput
              items={templates.map(t => ({ label: t.label, value: t.value }))}
              onSelect={handleTemplateSelect}
            />
          </Box>
        </Box>
      )}

      {/* Executor Selection */}
      {step === 'executor' && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>Select executor:</Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>(Can be changed later in config)</Text>
          </Box>
          <SelectInput
            items={executors}
            onSelect={handleExecutorSelect}
          />
        </Box>
      )}

      {/* Model Input */}
      {step === 'model' && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>Default model for {executor}:</Text>
          </Box>
          <Box marginBottom={1}>
            <Text dimColor>Press Enter for default: {getDefaultModel()}</Text>
          </Box>
          <Box>
            <Text color="cyan">› </Text>
            <TextInput
              value={model}
              onChange={setModel}
              onSubmit={handleModelSubmit}
              placeholder={getDefaultModel()}
            />
          </Box>
        </Box>
      )}

      {/* Starting */}
      {step === 'starting' && (
        <Box>
          <Text color="green">
            <Spinner type="dots" /> Starting install agent...
          </Text>
        </Box>
      )}

      {/* Footer */}
      {step !== 'starting' && (
        <Box marginTop={1}>
          <Text dimColor>ESC to cancel</Text>
        </Box>
      )}
    </Box>
  );
};

export async function runInitWizard(options: {
  templates: Array<{ value: string; label: string; description: string }>;
  executors: Array<{ value: string; label: string }>;
  hasGit: boolean;
}): Promise<{ template: string; executor: string; model?: string; initGit: boolean }> {
  // @ts-ignore - Dynamic import for ESM module
  const { render } = await import('ink');

  return new Promise((resolve) => {
    const { waitUntilExit } = render(
      <InitWizard
        {...options}
        onComplete={(config) => {
          resolve(config);
        }}
      />
    );

    waitUntilExit().catch(() => {
      process.exit(0);
    });
  });
}
