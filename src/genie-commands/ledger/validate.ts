import { beadsValidateCommand, type BeadsValidateOptions } from '../../term-commands/beads-validate.js';

export async function ledgerValidateCommand(options: BeadsValidateOptions): Promise<void> {
  await beadsValidateCommand(options);
}
