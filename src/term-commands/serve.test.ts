import { describe, expect, test } from 'bun:test';
import { getTuiKeybindings, getTuiQuitBindingArgs } from './serve.js';

describe('getTuiKeybindings', () => {
  test('includes explicit left and right pane focus bindings', () => {
    const bindings = getTuiKeybindings();

    expect(bindings).toContain('bind-key -T root C-1 select-pane -t genie-tui:0.0');
    expect(bindings).toContain('bind-key -T root C-2 select-pane -t genie-tui:0.1');
  });

  test('keeps existing tab toggle and quit passthrough bindings', () => {
    const bindings = getTuiKeybindings();

    expect(bindings.some((binding) => binding.includes('bind-key -T root Tab if-shell'))).toBe(true);
    expect(bindings).toContain('bind-key -T root C-q select-pane -t genie-tui:0.0 \\; send-keys -t genie-tui:0.0 C-q');
  });

  test('builds quit passthrough binding args without shell escaping', () => {
    expect(getTuiQuitBindingArgs()).toEqual([
      'bind-key',
      '-T',
      'root',
      'C-q',
      'select-pane',
      '-t',
      'genie-tui:0.0',
      '\\;',
      'send-keys',
      '-t',
      'genie-tui:0.0',
      'C-q',
    ]);
  });
});
