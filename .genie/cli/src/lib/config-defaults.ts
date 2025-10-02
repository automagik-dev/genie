import type { GenieConfig } from './types';
import { buildDefaultConfig } from './config';

export const DEFAULT_CONFIG: GenieConfig = buildDefaultConfig();

export function getDefaultConfig(): GenieConfig {
  return DEFAULT_CONFIG;
}
