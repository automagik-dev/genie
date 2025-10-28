#!/usr/bin/env node
/**
 * Debug script to test Forge stats collection
 */

// @ts-ignore - compiled client shipped at project root
import { ForgeClient } from '../../../src/lib/forge-client.js';

async function debug() {
  const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
  const client = new ForgeClient(baseUrl, process.env.FORGE_TOKEN);

  console.log('🔍 Debugging Forge Stats Collection');
  console.log('===================================\n');

  try {
    // Test 1: List projects
    console.log('📦 Fetching projects...');
    const projects = await client.listProjects();
    console.log(`Found ${projects.length} projects:`);
    projects.forEach((p: any) => {
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
          tasks.slice(0, 3).forEach((t: any) => {
            console.log(`    - ${t.title} (status: ${t.status})`);
          });
          if (tasks.length > 3) {
            console.log(`    ... and ${tasks.length - 3} more`);
          }
        }
        console.log('');
      } catch (err: any) {
        console.error(`  ❌ Error fetching tasks: ${err.message}`);
        console.log('');
      }
    }

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

debug();
