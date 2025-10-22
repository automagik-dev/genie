import React from 'react';
import { IntelligentEntry } from './components/IntelligentEntry.js';
export async function runIntelligentEntry(options) {
    const { render } = await import('ink');
    return new Promise((resolve) => {
        const { waitUntilExit } = render(React.createElement(IntelligentEntry, { ...options, onStart: () => {
                options.onStart();
                resolve();
            } }));
        waitUntilExit().catch(() => {
            process.exit(0);
        });
    });
}
