import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Resolve genie-pdf path lazily to avoid crashing at module load time.
 * In CJS bundles (esbuild), import.meta is replaced with {} so import.meta.url
 * is undefined. This function handles both ESM (dev) and CJS (bundled) contexts.
 */
function getGeniePdfPath(): string {
  // In CJS bundles, __filename is available natively
  const base = typeof __filename !== 'undefined'
    ? dirname(__filename)
    : dirname(fileURLToPath(import.meta.url));
  return resolve(base, '../../packages/genie-pdf/src/index.ts');
}

/**
 * Execute genie-pdf CLI with given arguments
 */
function runGeniePdf(args: string[]): Promise<number> {
  let pdfPath: string;
  try {
    pdfPath = getGeniePdfPath();
  } catch {
    console.error('❌ genie-pdf is not available in this context (bundled plugin mode).');
    console.error('   Install genie-cli from source to use PDF commands.');
    return Promise.resolve(1);
  }

  return new Promise((resolve) => {
    const child = spawn('bun', ['run', pdfPath, ...args], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    child.on('close', (code) => {
      resolve(code ?? 0);
    });

    child.on('error', (err) => {
      console.error(`❌ Failed to execute genie-pdf: ${err.message}`);
      resolve(1);
    });
  });
}

/**
 * genie pdf render <input.md> -o output.pdf [--theme <theme>]
 */
export async function pdfRenderCommand(
  input: string,
  options: { output?: string; theme?: string; pageNumbers?: boolean; watch?: boolean }
): Promise<void> {
  const args = ['render', input];

  if (options.output) {
    args.push('-o', options.output);
  }
  if (options.theme) {
    args.push('-t', options.theme);
  }
  if (options.pageNumbers === false) {
    args.push('--no-page-numbers');
  }
  if (options.watch) {
    args.push('-w');
  }

  const code = await runGeniePdf(args);
  if (code !== 0) {
    process.exit(code);
  }
}

/**
 * genie pdf template <name> --data <file.json> -o output.pdf
 */
export async function pdfTemplateCommand(
  name: string,
  options: { data?: string; output?: string; theme?: string }
): Promise<void> {
  const args = ['template', name];

  if (options.data) {
    args.push('-d', options.data);
  }
  if (options.output) {
    args.push('-o', options.output);
  }
  if (options.theme) {
    args.push('-t', options.theme);
  }

  const code = await runGeniePdf(args);
  if (code !== 0) {
    process.exit(code);
  }
}

/**
 * genie pdf themes - list available themes
 */
export async function pdfThemesCommand(): Promise<void> {
  const code = await runGeniePdf(['themes']);
  if (code !== 0) {
    process.exit(code);
  }
}

/**
 * genie pdf templates - list available templates
 */
export async function pdfTemplatesCommand(): Promise<void> {
  const code = await runGeniePdf(['templates']);
  if (code !== 0) {
    process.exit(code);
  }
}
