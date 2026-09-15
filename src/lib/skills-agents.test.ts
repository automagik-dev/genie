import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SKILLS_CLI_AGENTS,
  agentHomeIsIndependentlyDetected,
  agentProductInstalled,
  agentSkillsHome,
  selectSkillsCliAgents,
} from './skills-agents.js';

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-skills-agents-'));
  home = join(root, 'home');
  mkdirSync(home, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function spec(agent: string) {
  const found = SKILLS_CLI_AGENTS.find((entry) => entry.agent === agent);
  if (found === undefined) throw new Error(`no spec for ${agent}`);
  return found;
}

describe('the mirrored skills.sh 1.5.23 agent registry', () => {
  test('every entry has a product root and a global skills home, and names are unique', () => {
    expect(SKILLS_CLI_AGENTS.length).toBeGreaterThan(50);
    const names = SKILLS_CLI_AGENTS.map((entry) => entry.agent);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of SKILLS_CLI_AGENTS) {
      expect(entry.roots.length).toBeGreaterThan(0);
      expect(entry.skills.length).toBeGreaterThan(0);
      for (const segments of [...entry.roots, entry.skills]) {
        expect(segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')).toBe(true);
      }
    }
  });

  test('a universal agent resolves to the shared ~/.agents/skills home, not its own', () => {
    // `getAgentBaseDir` short-circuits on `isUniversalAgent` BEFORE it reads
    // `globalSkillsDir`, which is why Codex writes `~/.agents/skills` and
    // skills.sh creates no `~/.codex/skills`.
    expect(agentSkillsHome(home, spec('codex'))).toBe(join(home, '.agents', 'skills'));
    expect(agentSkillsHome(home, spec('cline'))).toBe(join(home, '.agents', 'skills'));
    expect(agentSkillsHome(home, spec('claude-code'))).toBe(join(home, '.claude', 'skills'));
    expect(agentSkillsHome(home, spec('qwen-code'))).toBe(join(home, '.qwen', 'skills'));
    expect(agentSkillsHome(home, spec('goose'))).toBe(join(home, '.config', 'goose', 'skills'));
  });

  test('detection is product-root existence, nothing else', () => {
    expect(agentProductInstalled(home, spec('openclaw'))).toBe(false);
    mkdirSync(join(home, '.moltbot'), { recursive: true });
    // Any of the three historical roots counts, exactly as the CLI does it.
    expect(agentProductInstalled(home, spec('openclaw'))).toBe(true);
  });
});

describe('selectSkillsCliAgents', () => {
  test('a bare home selects nothing — genie creates no product home', () => {
    expect(selectSkillsCliAgents({ home })).toEqual({ agents: [], homes: [], recordedOnly: [] });
  });

  test('only agents whose product root exists are named', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });

    const selection = selectSkillsCliAgents({ home });

    expect(selection.agents).toEqual(['claude-code', 'codex']);
    expect(selection.homes).toEqual([join(home, '.claude', 'skills'), join(home, '.agents', 'skills')]);
    expect(selection.agents).not.toContain('openclaw');
    expect(selection.recordedOnly).toEqual([]);
  });

  test('a home the previous record already names stays selected, and says so', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });

    const selection = selectSkillsCliAgents({ home, recordedDirs: [join(home, '.qwen', 'skills')] });

    expect(selection.agents).toEqual(['claude-code', 'qwen-code']);
    expect(selection.recordedOnly).toEqual(['qwen-code']);
  });
});

describe('agentHomeIsIndependentlyDetected', () => {
  test('a product root genie created never vouches for itself', () => {
    mkdirSync(join(home, '.openclaw', 'skills'), { recursive: true });
    expect(agentHomeIsIndependentlyDetected(home, join(home, '.openclaw', 'skills'), join(home, '.openclaw'))).toBe(
      false,
    );
  });

  test('evidence outside the product root protects the shared ~/.agents home', () => {
    const agentsHome = join(home, '.agents', 'skills');
    mkdirSync(agentsHome, { recursive: true });
    expect(agentHomeIsIndependentlyDetected(home, agentsHome, join(home, '.agents'))).toBe(false);
    mkdirSync(join(home, '.codex'), { recursive: true });
    expect(agentHomeIsIndependentlyDetected(home, agentsHome, join(home, '.agents'))).toBe(true);
  });
});
