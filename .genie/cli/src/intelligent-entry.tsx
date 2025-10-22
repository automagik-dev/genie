import React from 'react';
import { IntelligentEntry } from './components/IntelligentEntry.js';

interface EntryOptions {
  currentVersion: string;
  latestVersion: string;
  isWorkspaceInitialized: boolean;
  hasOldVersion: boolean;
  onUpdate: () => void;
  onInit: () => void;
  onUpgrade: () => void;
  onStart: () => void;
}

export async function runIntelligentEntry(options: EntryOptions): Promise<void> {
  const { render } = await import('ink');

  return new Promise((resolve) => {
    const { waitUntilExit } = render(
      <IntelligentEntry
        {...options}
        onStart={() => {
          options.onStart();
          resolve();
        }}
      />
    );

    waitUntilExit().catch(() => {
      process.exit(0);
    });
  });
}
