/**
 * Tests for getOrCreateSession - auto-create tmux session when not inside tmux
 *
 * Tests the behavior of the getOrCreateSession function which:
 * 1. Returns --session option if provided
 * 2. Returns current tmux session if inside one
 * 3. Auto-creates a session if not inside tmux
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as tmux from '../lib/tmux.js';
import * as genieConfig from '../lib/genie-config.js';

// We test getOrCreateSession which is exported from work.ts
import { getOrCreateSession } from './work.js';

describe('getOrCreateSession', () => {
  let executeTmuxMock: ReturnType<typeof spyOn>;
  let findSessionByNameMock: ReturnType<typeof spyOn>;
  let createSessionMock: ReturnType<typeof spyOn>;
  let getSessionNameMock: ReturnType<typeof spyOn>;

  // Capture console output
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    executeTmuxMock = spyOn(tmux, 'executeTmux');
    findSessionByNameMock = spyOn(tmux, 'findSessionByName');
    createSessionMock = spyOn(tmux, 'createSession');
    getSessionNameMock = spyOn(genieConfig, 'getSessionName');
    consoleLogSpy = spyOn(console, 'log');
    consoleErrorSpy = spyOn(console, 'error');
  });

  afterEach(() => {
    executeTmuxMock.mockRestore();
    findSessionByNameMock.mockRestore();
    createSessionMock.mockRestore();
    getSessionNameMock.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should return --session option when provided', async () => {
    const result = await getOrCreateSession('my-session');
    expect(result).toBe('my-session');
    // Should not call any tmux functions
    expect(executeTmuxMock).not.toHaveBeenCalled();
    expect(findSessionByNameMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it('should return current session when inside tmux', async () => {
    // Simulate being inside a tmux session
    executeTmuxMock.mockResolvedValue('existing-session\n');

    const result = await getOrCreateSession();
    expect(result).toBe('existing-session');
    // Should not try to create a session
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it('should auto-create session when not inside tmux', async () => {
    // Simulate NOT being inside tmux
    executeTmuxMock.mockRejectedValue(new Error('no current session'));
    // Config returns default session name
    getSessionNameMock.mockReturnValue('genie');
    // No existing session
    findSessionByNameMock.mockResolvedValue(null);
    // Creation succeeds
    createSessionMock.mockResolvedValue({
      id: '$1',
      name: 'genie',
      attached: false,
      windows: 1,
    });

    const result = await getOrCreateSession();
    expect(result).toBe('genie');
    expect(createSessionMock).toHaveBeenCalledWith('genie');
    // Should print creation message
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Created tmux session 'genie'")
    );
  });

  it('should use existing session if one with the config name already exists', async () => {
    // Simulate NOT being inside tmux
    executeTmuxMock.mockRejectedValue(new Error('no current session'));
    // Config returns session name
    getSessionNameMock.mockReturnValue('genie');
    // Existing session found
    findSessionByNameMock.mockResolvedValue({
      id: '$0',
      name: 'genie',
      attached: true,
      windows: 3,
    });

    const result = await getOrCreateSession();
    expect(result).toBe('genie');
    // Should NOT create a new session
    expect(createSessionMock).not.toHaveBeenCalled();
    // Should print found message
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Found existing tmux session 'genie'")
    );
  });

  it('should use custom session name from config', async () => {
    // Simulate NOT being inside tmux
    executeTmuxMock.mockRejectedValue(new Error('no current session'));
    // Config returns custom session name
    getSessionNameMock.mockReturnValue('my-custom-session');
    // No existing session
    findSessionByNameMock.mockResolvedValue(null);
    // Creation succeeds
    createSessionMock.mockResolvedValue({
      id: '$2',
      name: 'my-custom-session',
      attached: false,
      windows: 1,
    });

    const result = await getOrCreateSession();
    expect(result).toBe('my-custom-session');
    expect(createSessionMock).toHaveBeenCalledWith('my-custom-session');
  });

  it('should fall back to genie-workers when config returns empty string', async () => {
    // Simulate NOT being inside tmux
    executeTmuxMock.mockRejectedValue(new Error('no current session'));
    // Config returns empty string
    getSessionNameMock.mockReturnValue('');
    // No existing session
    findSessionByNameMock.mockResolvedValue(null);
    // Creation succeeds
    createSessionMock.mockResolvedValue({
      id: '$3',
      name: 'genie-workers',
      attached: false,
      windows: 1,
    });

    const result = await getOrCreateSession();
    expect(result).toBe('genie-workers');
    expect(createSessionMock).toHaveBeenCalledWith('genie-workers');
  });

  it('should include attach command in creation message', async () => {
    // Simulate NOT being inside tmux
    executeTmuxMock.mockRejectedValue(new Error('no current session'));
    getSessionNameMock.mockReturnValue('genie');
    findSessionByNameMock.mockResolvedValue(null);
    createSessionMock.mockResolvedValue({
      id: '$1',
      name: 'genie',
      attached: false,
      windows: 1,
    });

    await getOrCreateSession();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('tmux attach -t genie')
    );
  });
});
