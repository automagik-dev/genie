#!/usr/bin/env node
"use strict";
/**
 * Debug script to test Forge stats collection
 */
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-ignore - compiled client shipped at project root
const forge_client_js_1 = require("../../../src/lib/forge-client.js");
async function debug() {
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
    const client = new forge_client_js_1.ForgeClient(baseUrl, process.env.FORGE_TOKEN);
    console.log('🔍 Debugging Forge Stats Collection');
    console.log('===================================\n');
    try {
        // Test 1: List projects
        console.log('📦 Fetching projects...');
        const projects = await client.listProjects();
        console.log(`Found ${projects.length} projects:`);
        projects.forEach((p) => {
            console.log(`  - ${p.name} (${p.id})`);
        });
        console.log('');
        // Test 2: List tasks for each project
        for (const project of projects) {
            console.log(`📋 Fetching tasks for: ${project.name}`);
            try {
                const tasks = await client.listTasks(project.id);
                console.log(`  Found ${tasks.length} tasks`);
                if (tasks.length > 0) {
                    // Show first 3 tasks
                    tasks.slice(0, 3).forEach((t) => {
                        console.log(`    - ${t.title} (status: ${t.status})`);
                    });
                    if (tasks.length > 3) {
                        console.log(`    ... and ${tasks.length - 3} more`);
                    }
                }
                console.log('');
            }
            catch (err) {
                console.error(`  ❌ Error fetching tasks: ${err.message}`);
                console.log('');
            }
        }
    }
    catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}
debug();
