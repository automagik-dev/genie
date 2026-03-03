import { testConnection } from '../lib/api-client.js';
import { configExists, loadConfig } from '../lib/config.js';

export async function modelsCommand(): Promise<void> {
  if (!configExists()) {
    console.error('❌ No config found. Run `claudio setup` first.');
    process.exit(1);
  }

  const config = await loadConfig();

  process.stdout.write('Fetching models... ');
  const result = await testConnection(config.apiUrl, config.apiKey);

  if (!result.success) {
    console.log('❌');
    console.error(`\n❌ ${result.message}`);
    process.exit(1);
  }

  console.log('✓\n');
  console.log(`Available models (${result.modelCount}):\n`);

  for (const model of result.models) {
    console.log(`  ${model.id}`);
  }
}

export async function configCommand(): Promise<void> {
  if (!configExists()) {
    console.error('❌ No config found. Run `claudio setup` first.');
    process.exit(1);
  }

  const config = await loadConfig();
  const profileCount = Object.keys(config.profiles).length;

  console.log('\nClaudio Config\n');
  console.log(`  API URL:         ${config.apiUrl}`);
  console.log(`  API Key:         ${config.apiKey.slice(0, 8)}...${config.apiKey.slice(-4)}`);
  console.log(`  Default Profile: ${config.defaultProfile || '(none)'}`);
  console.log(`  Profiles:        ${profileCount}`);
}
