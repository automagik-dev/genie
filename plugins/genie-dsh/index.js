// Genie for DeepSeek Harness, on the Bot team (@automagik/bots-dsh): one Genie Bot that
// lives in a project folder and grants wishes. A wish is a Tasks session the team already
// knows how to run, track, resume and report on; this plugin adds the Genie Bot, the git
// worktree each wish works in, and the rows of finished wishes under Genie.
//
// The team's runtime arrives as the omniTeam service. This plugin's runtime has the team's
// as its prototype, so its tool sits on this plugin's fiber and goes when the plugin does.
import * as genie from './src/host/genie.js';

export const name = 'genie';
// Without the team this plugin waits (DSH shows it pending), as Omni's own plugins do.
export const inject = ['omniTeam', 'tools'];

export function apply(ctx, config = {}) {
  createRuntime(ctx, ctx.omniTeam, config);
}

export function createRuntime(ctx, team, config = {}) {
  const rt = Object.assign(Object.create(team), { ctx, genieConfig: config });
  genie.install(rt);
  return rt;
}
