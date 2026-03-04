import { confirm, input, search } from '@inquirer/prompts';
import type { Model } from './api-client.js';

interface PickerOptions {
  message: string;
  models: Model[];
}

async function pickModel(options: PickerOptions): Promise<string> {
  const { message, models } = options;

  const modelIds = models.map((m) => m.id);

  const selected = await search({
    message,
    source: async (term) => {
      const searchTerm = (term || '').toLowerCase();
      const filtered = modelIds.filter((id) => id.toLowerCase().includes(searchTerm));
      return filtered.map((id) => ({
        name: id,
        value: id,
      }));
    },
  });

  return selected;
}

export async function pickProfileModels(models: Model[]): Promise<{ opus: string; sonnet: string; haiku: string }> {
  const opus = await pickModel({
    message: 'Select OPUS model:',
    models,
  });

  const sonnet = await pickModel({
    message: 'Select SONNET model:',
    models,
  });

  const haiku = await pickModel({
    message: 'Select HAIKU model:',
    models,
  });

  return { opus, sonnet, haiku };
}

export async function promptText(message: string, defaultValue?: string): Promise<string> {
  return input({
    message,
    default: defaultValue,
  });
}

export async function promptConfirm(message: string, defaultValue = false): Promise<boolean> {
  return confirm({
    message,
    default: defaultValue,
  });
}
