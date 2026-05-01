import type { CliRenderer, KeyEvent, Renderable } from '@opentui/core';
import type { Keymap } from '@opentui/keymap';
import { registerEscapeClearsPendingSequence, registerLeader } from '@opentui/keymap/addons';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';

export type TuiKeymap = Keymap<Renderable, KeyEvent>;

export function createTuiKeymap(renderer: CliRenderer): TuiKeymap {
  // `createDefaultOpenTuiKeymap` already runs `registerMetadataFields(keymap)`
  // internally (see @opentui/keymap/opentui.js — it composes
  // `registerDefaultKeys` + `registerEnabledFields` + `registerMetadataFields`).
  // We previously called `registerMetadataFields(keymap)` again here, which
  // tripped the library's duplicate-registration guard and emitted
  //   [duplicate-binding-field] Keymap binding field "desc"  is already registered
  //   [duplicate-binding-field] Keymap binding field "group" is already registered
  //   [duplicate-command-field] Keymap command field "desc"     is already registered
  //   [duplicate-command-field] Keymap command field "title"    is already registered
  //   [duplicate-command-field] Keymap command field "category" is already registered
  // on every TUI launch. The fields ARE registered (first call wins) so the
  // keymap was functionally correct, but every operator saw five red error
  // lines in the TUI console at startup. Drop the redundant call.
  const keymap = createDefaultOpenTuiKeymap(renderer);

  registerLeader(keymap, { trigger: { name: 'space' } });

  registerEscapeClearsPendingSequence(keymap);

  return keymap;
}
