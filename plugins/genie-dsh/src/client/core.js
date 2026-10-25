// What this plugin takes from the Bot team's client (@automagik/bots-dsh/client). The
// plugin's dsh.client.external names it, so DSH loads the team's bundle first and hands
// this one the same module instance: one roster, one set of the registries it adds to.
import { omni } from '@automagik/bots-dsh/client';

export const { botChildren } = omni;
