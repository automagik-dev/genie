import React from 'react';
import { IntelligentEntry } from './components/IntelligentEntry';

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
  // @ts-ignore - Dynamic import for ESM module (Ink 5.x)
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
