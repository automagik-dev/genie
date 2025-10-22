**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`

    45	        const liveEntry = entry.sessionId ? liveStore.sessions?.[entry.sessionId] : undefined;
    46	        if (liveEntry?.sessionId) {
    47	            const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
    48	            entry.sessionId = liveEntry.sessionId;
    49	            process.stdout.write(`▸ Session ID: ${liveEntry.sessionId} (${elapsed}s)\n\n`);
    50	            process.stdout.write(`  View output:\n`);
    51	            process.stdout.write(`    npx automagik-genie view ${liveEntry.sessionId}\n\n`);
    52	            process.stdout.write(`  Continue conversation:\n`);
    53	            if (allowResume) {
    54	                process.stdout.write(`    npx automagik-genie resume ${liveEntry.sessionId} "..."\n\n`);
    55	            }
    56	            else {
    57	                process.stdout.write(`    npx automagik-genie continue ${agentName} "..."\n\n`);
    58	            }
    59	            process.stdout.write(`  Stop the agent:\n`);
    60	            process.stdout.write(`    npx automagik-genie stop ${liveEntry.sessionId}\n\n`);
    61	            return true;
    62	        }
