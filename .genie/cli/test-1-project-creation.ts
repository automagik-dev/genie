#!/usr/bin/env tsx
/**
 * Test 1: Project Creation
 * Verify Forge backend is accessible and can create "Genie Sessions" project
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ForgeClient } = require('../../forge.js');

async function test() {
  console.log('🧪 Test 1: Project Creation\n');
  console.log('═══════════════════════════════════════════════════════\n');

  try {
    const forge = new ForgeClient(process.env.FORGE_BASE_URL || 'http://localhost:8887');

    console.log('1️⃣  Checking if "Genie Sessions" project already exists...');
    const projects = await forge.listProjects();
    const existingProject = projects.find((p: any) => p.name === 'Genie Sessions');

    if (existingProject) {
      console.log(`   ✅ Project already exists: ${existingProject.id}`);
      console.log(`   Name: ${existingProject.name}`);
      console.log(`   Path: ${existingProject.repo_path}\n`);
      console.log(`▸ Set environment variable:`);
      console.log(`  export GENIE_PROJECT_ID=${existingProject.id}\n`);
      console.log('✅ TEST 1 PASSED: Project exists and is accessible\n');
      return;
    }

    console.log('   📝 Project does not exist, creating...\n');

    console.log('2️⃣  Creating "Genie Sessions" project...');
    const project = await forge.createProject({
      name: 'Genie Sessions',
      repo_path: process.cwd()
    });

    console.log(`   ✅ Project created successfully!`);
    console.log(`   ID: ${project.id}`);
    console.log(`   Name: ${project.name}`);
    console.log(`   Path: ${project.repo_path}\n`);

    console.log('3️⃣  Verifying project is visible in Forge...');
    const verifyProjects = await forge.listProjects();
    const found = verifyProjects.find((p: any) => p.id === project.id);

    if (!found) {
      throw new Error('Project not found in list after creation');
    }

    console.log('   ✅ Project verified in Forge UI\n');

    console.log('═══════════════════════════════════════════════════════');
    console.log('✅ TEST 1 PASSED: Project creation successful\n');
    console.log(`▸ Set environment variable for next tests:`);
    console.log(`  export GENIE_PROJECT_ID=${project.id}\n`);
    console.log(`▸ Run next test:`);
    console.log(`  npx tsx test-2-session-creation.ts\n`);

  } catch (error) {
    console.error('═══════════════════════════════════════════════════════');
    console.error('❌ TEST 1 FAILED:', error instanceof Error ? error.message : String(error));
    console.error('\nStack trace:', error);
    process.exit(1);
  }
}

test().catch(console.error);
