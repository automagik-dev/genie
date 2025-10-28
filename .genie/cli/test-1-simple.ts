#!/usr/bin/env tsx
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ForgeClient } = require('../../forge.js');

async function test() {
  console.log('🧪 Test 1: List existing projects\n');
  
  const forge = new ForgeClient('http://localhost:8887');
  const projects = await forge.listProjects();
  
  console.log('Projects found:', projects.length);
  projects.forEach((p: any) => {
    console.log(`  - ${p.name} (${p.id})`);
  });
  
  // Use the automagik-genie project that already exists
  const genieProject = projects.find((p: any) => p.name === 'automagik-genie');
  if (genieProject) {
    console.log(`\n✅ Using existing project: ${genieProject.id}`);
    console.log(`\nexport GENIE_PROJECT_ID=${genieProject.id}`);
  }
}

test().catch(console.error);
