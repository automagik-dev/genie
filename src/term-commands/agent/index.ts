/**
 * Agent Namespace — `genie agent` subcommand group.
 *
 * Subcommands:
 *   spawn, stop, resume, kill, list, show, answer,
 *   register, directory, inbox, brief, log (stub), send (stub)
 */

import type { Command } from 'commander';
import { registerAgentAnswer } from './answer.js';
import { registerAgentBrief } from './brief.js';
import { registerAgentDirectory } from './directory.js';
import { registerAgentInbox } from './inbox.js';
import { registerAgentKill } from './kill.js';
import { registerAgentList } from './list.js';
import { registerAgentLog } from './log.js';
import { registerAgentRecover } from './recover.js';
import { registerAgentRegister } from './register.js';
import { registerAgentResume } from './resume.js';
import { registerAgentSend } from './send.js';
import { registerAgentShow } from './show.js';
import { registerAgentSpawn } from './spawn.js';
import { registerAgentStop } from './stop.js';

export function registerAgentCommands(program: Command): void {
  const agent = program.command('agent').description('Agent lifecycle management');

  registerAgentSpawn(agent);
  registerAgentStop(agent);
  registerAgentResume(agent);
  registerAgentRecover(agent);
  registerAgentKill(agent);
  registerAgentList(agent);
  registerAgentShow(agent);
  registerAgentAnswer(agent);
  registerAgentRegister(agent);
  registerAgentDirectory(agent);
  registerAgentInbox(agent);
  registerAgentBrief(agent);
  registerAgentLog(agent);
  registerAgentSend(agent);

  agent.on('command:*', (operands: string[]) => {
    const cmd = operands[0];
    const available = agent.commands.map((c) => c.name()).join(', ');
    agent.error(`Unknown agent command '${cmd}'. Available: ${available}`);
  });
}
