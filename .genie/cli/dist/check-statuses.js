#!/usr/bin/env node
"use strict";
/**
 * Check all unique status values in Forge execution processes
 */
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-ignore
const forge_client_js_1 = require("../../../src/lib/forge-client.js");
async function checkStatuses() {
    const baseUrl = 'http://localhost:8887';
    const client = new forge_client_js_1.ForgeClient(baseUrl, process.env.FORGE_TOKEN);
    try {
        const allAttempts = await client.listTaskAttempts();
        console.log(`📊 Checking ${allAttempts.length} task attempts...\n`);
        const statusCounts = {};
        const examplesByStatus = {};
        for (const attempt of allAttempts.slice(0, 20)) {
            try {
                const processes = await client.listExecutionProcesses(attempt.id, false);
                if (processes && processes.length > 0) {
                    const latestProcess = processes[processes.length - 1];
                    const status = latestProcess.status || 'unknown';
                    statusCounts[status] = (statusCounts[status] || 0) + 1;
                    if (!examplesByStatus[status]) {
                        examplesByStatus[status] = {
                            id: latestProcess.id,
                            started_at: latestProcess.started_at,
                            completed_at: latestProcess.completed_at,
                            exit_code: latestProcess.exit_code,
                            dropped: latestProcess.dropped
                        };
                    }
                }
            }
            catch (err) {
                // Skip
            }
        }
        console.log('📈 Status Distribution:');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        Object.entries(statusCounts)
            .sort((a, b) => b[1] - a[1])
            .forEach(([status, count]) => {
            console.log(`${status}: ${count} attempts`);
            const example = examplesByStatus[status];
            console.log(`  Example: ${example.id.substring(0, 8)}...`);
            console.log(`  Started: ${example.started_at || 'N/A'}`);
            console.log(`  Completed: ${example.completed_at || 'N/A'}`);
            console.log(`  Exit Code: ${example.exit_code ?? 'N/A'}`);
            console.log(`  Dropped: ${example.dropped}`);
            console.log('');
        });
    }
    catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}
checkStatuses();
