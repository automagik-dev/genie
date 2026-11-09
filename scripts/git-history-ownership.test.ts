import { expect, test } from 'bun:test';
import { catalogGenieCommits, foreignOnlyMikroCommits } from './git-history-ownership.js';

test.each([false, true])('missing HEAD ancestry carries bounded evidence (SHA in parent row: %s)', (inParent) => {
  const root = '1'.repeat(40);
  const head = '2'.repeat(40);
  const child = '3'.repeat(40);
  const complete = `${root}\n${head} ${root}\n${child} ${head}\n`;
  // The negative control from #3239: remove HEAD's row, retaining its child only in one case.
  const raw = complete
    .split('\n')
    .filter((row) => row && !row.startsWith(head) && (inParent || !row.startsWith(child)))
    .join('\n')
    .concat(inParent ? `\n${root}\n\n` : '\n\n');
  const calls: string[][] = [];
  const git = (...args: string[]): string => {
    calls.push(args);
    if (args[0] === 'log') return '';
    if (args[0] === 'rev-list' && args[1] === '--parents') return raw;
    if (args[0] === 'rev-list' && args[1] === '--no-walk') return `${head}\n${child}\n`;
    if (args[0] === 'rev-parse' && args[1] === 'HEAD^{commit}') return `${head}\n`;
    throw new Error(`unexpected Git read: ${args.join(' ')}`);
  };

  let message = '';
  try {
    catalogGenieCommits(git, ['--all'], ['HEAD']);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message.startsWith(`incomplete Git ancestry at ${head}`)).toBe(true);
  expect(message).toContain(`revListRows=${inParent ? 3 : 1}`);
  expect(message).toContain(`graphCommits=${inParent ? 2 : 1}`);
  expect(message).toContain(`revListBytes=${Buffer.byteLength(raw)}`);
  expect(message).toContain(`head(HEAD^{commit})=${head}`);
  expect(message).toContain('walkRootCount=1');
  expect(message).toContain(`walkRoots=[${head}]`);
  expect(message).toContain(`missingInRaw=${inParent}`);
  expect(message).not.toContain(raw.trim());
  expect(message.length).toBeLessThan(400);
  expect(calls).toEqual([
    ['log', '--all', '--format=%H', '--grep=^git-subtree-dir:'],
    ['rev-list', '--parents', '--all'],
    ['rev-list', '--no-walk', '--all'],
    ['rev-parse', 'HEAD^{commit}'],
  ]);
});

test('a failed diagnostic HEAD read never replaces the ancestry refusal', () => {
  const root = '1'.repeat(40);
  const missing = '2'.repeat(40);
  const git = (...args: string[]): string => {
    if (args[0] === 'log') return '';
    if (args[0] === 'rev-list') return `${root}\n`;
    throw new Error('HEAD diagnostic unavailable');
  };
  expect(() => foreignOnlyMikroCommits(git, missing)).toThrow(
    `incomplete Git ancestry at ${missing}; revListRows=1; graphCommits=1; revListBytes=41; ` +
      `head(HEAD^{commit})=unavailable; walkRootCount=1; walkRoots=[${missing}]; missingInRaw=false`,
  );
});
