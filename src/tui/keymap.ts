import type { CliRenderer, KeyEvent, Renderable } from '@opentui/core';
import type { Keymap } from '@opentui/keymap';
import { registerEscapeClearsPendingSequence, registerLeader, registerMetadataFields } from '@opentui/keymap/addons';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';

export type TuiKeymap = Keymap<Renderable, KeyEvent>;

export function createTuiKeymap(renderer: CliRenderer): TuiKeymap {
  const keymap = createDefaultOpenTuiKeymap(renderer);

  registerMetadataFields(keymap);

  registerLeader(keymap, { trigger: { name: 'space' } });

  registerEscapeClearsPendingSequence(keymap);

  return keymap;
}
