#!/usr/bin/env bun

import { Command } from 'commander';
import { VERSION } from './lib/version.js';
import { installCommand } from './genie-commands/install.js';
import { setupCommand, type SetupOptions } from './genie-commands/setup.js';
import { updateCommand } from './genie-commands/update.js';
import { uninstallCommand } from './genie-commands/uninstall.js';
import { doctorCommand } from './genie-commands/doctor.js';
import { tuiCommand, type TuiOptions } from './genie-commands/tui.js';
import {
  shortcutsShowCommand,
  shortcutsInstallCommand,
  shortcutsUninstallCommand,
} from './genie-commands/shortcuts.js';
import {
  profilesListCommand,
  profilesAddCommand,
  profilesRmCommand,
  profilesShowCommand,
  profilesDefaultCommand,
} from './genie-commands/profiles.js';
import {
  pdfRenderCommand,
  pdfTemplateCommand,
  pdfThemesCommand,
  pdfTemplatesCommand,
} from './genie-commands/pdf.js';
import { brainstormCrystallizeCommand } from './genie-commands/brainstorm/crystallize.js';
import { ledgerValidateCommand } from './genie-commands/ledger/validate.js';

const program = new Command();

program
  .name('genie')
  .description('Genie CLI - Setup and utilities for AI-assisted development')
  .version(VERSION);

// Install command - check/install prerequisites
program
  .command('install')
  .description('Verify and install prerequisites')
  .option('--check', 'Only check prerequisites, do not install')
  .option('--yes', 'Auto-approve all installations')
  .action(installCommand);

// Setup command - configure genie settings
program
  .command('setup')
  .description('Configure genie settings')
  .option('--quick', 'Accept all defaults')
  .option('--shortcuts', 'Only configure keyboard shortcuts')
  .option('--claudio', 'Only configure Claudio integration')
  .option('--terminal', 'Only configure terminal defaults')
  .option('--session', 'Only configure session settings')
  .option('--reset', 'Reset configuration to defaults')
  .option('--show', 'Show current configuration')
  .action(async (options: SetupOptions) => {
    await setupCommand(options);
  });

// Doctor command - diagnostic checks
program
  .command('doctor')
  .description('Run diagnostic checks on genie installation')
  .action(doctorCommand);

// Update command - pull latest and rebuild
program
  .command('update')
  .description('Update Genie CLI to the latest version')
  .action(updateCommand);

// Uninstall command - remove genie CLI
program
  .command('uninstall')
  .description('Remove Genie CLI and clean up hooks')
  .action(uninstallCommand);

// TUI command - attach to master genie session
program
  .command('tui')
  .description('Attach to master genie session in ~/workspace')
  .option('-r, --reset', 'Kill existing session and start fresh')
  .action(async (options: TuiOptions) => {
    await tuiCommand(options);
  });

// Shortcuts command group - manage tmux keyboard shortcuts
const shortcuts = program
  .command('shortcuts')
  .description('Manage tmux keyboard shortcuts');

// Make 'show' the default action for bare `genie shortcuts`
shortcuts.action(shortcutsShowCommand);

shortcuts
  .command('show')
  .description('Show available shortcuts and installation status')
  .action(shortcutsShowCommand);

shortcuts
  .command('install')
  .description('Install shortcuts to config files (~/.tmux.conf, shell rc)')
  .action(shortcutsInstallCommand);

shortcuts
  .command('uninstall')
  .description('Remove shortcuts from config files')
  .action(shortcutsUninstallCommand);

// Profiles command group - manage worker profiles
const profiles = program
  .command('profiles')
  .description('Manage worker profiles for Claude Code spawning');

// Make 'list' the default action for bare `genie profiles`
profiles.action(profilesListCommand);

profiles
  .command('list')
  .description('List all configured worker profiles')
  .action(profilesListCommand);

profiles
  .command('add <name>')
  .description('Create a new worker profile interactively')
  .action(profilesAddCommand);

profiles
  .command('rm <name>')
  .description('Delete a worker profile')
  .action(profilesRmCommand);

profiles
  .command('show <name>')
  .description('Show details of a worker profile')
  .action(profilesShowCommand);

profiles
  .command('default [name]')
  .description('Get or set the default worker profile')
  .action(profilesDefaultCommand);

// PDF command group - generate PDFs from markdown
const pdf = program
  .command('pdf')
  .description('Generate PDFs from markdown files');

pdf
  .command('render <input>')
  .description('Render a markdown file to PDF')
  .option('-o, --output <file>', 'Output PDF file', 'output.pdf')
  .option('-t, --theme <name>', 'Theme to use (default, minimal, corporate, dark)')
  .option('--no-page-numbers', 'Disable page numbers')
  .option('-w, --watch', 'Watch for changes and re-render')
  .action(pdfRenderCommand);

pdf
  .command('template <name>')
  .description('Generate PDF from a template with JSON data')
  .option('-d, --data <file>', 'JSON data file')
  .option('-o, --output <file>', 'Output PDF file', 'output.pdf')
  .option('-t, --theme <name>', 'Theme to use')
  .action(pdfTemplateCommand);

pdf
  .command('themes')
  .description('List available themes')
  .action(pdfThemesCommand);

pdf
  .command('templates')
  .description('List available templates')
  .action(pdfTemplatesCommand);

// Brainstorm command group
const brainstorm = program
  .command('brainstorm')
  .description('Brainstorm utilities (file-based helpers)');

brainstorm
  .command('crystallize')
  .description('Crystallize a brainstorm draft into design.md and upsert .beads/issues.jsonl')
  .requiredOption('--slug <slug>', 'Brainstorm slug (kebab-case)')
  .option('--file <path>', 'Input draft markdown path (default: .genie/brainstorms/<slug>/draft.md)')
  .option('-r, --repo <path>', 'Repo path (default: cwd)')
  .option('--title <title>', 'Issue title (default: slug)')
  .option('--depends-on <ids>', 'Comma-separated dependency IDs (default: hq-roadmap)')
  .option('--status <status>', 'Issue status (open|closed)', 'open')
  .action(brainstormCrystallizeCommand);

// Ledger command group
const ledger = program
  .command('ledger')
  .description('Ledger utilities (beads JSONL validation)');

ledger
  .command('validate')
  .description('Validate local .beads/issues.jsonl JSONL structure (scriptable)')
  .option('-r, --repo <path>', 'Repo path (default: cwd)')
  .option('--json', 'Output JSON')
  .action(ledgerValidateCommand);

program.parse();
