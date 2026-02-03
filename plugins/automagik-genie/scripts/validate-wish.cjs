#!/usr/bin/env bun
"use strict";var u=require("util"),o=require("fs"),{values:n}=(0,u.parseArgs)({args:Bun.argv.slice(2),options:{file:{type:"string",short:"f"},help:{type:"boolean",short:"h"}},strict:!0});n.help&&(console.log(`
validate-wish.ts - Validate wish document structure

Usage:
  bun validate-wish.ts --file <path-to-wish.md>
  bun validate-wish.ts --help

Options:
  -f, --file   Path to wish document to validate
  -h, --help   Show this help message

Exit codes:
  0  Validation passed
  1  Validation failed (missing required sections)
  2  Invalid arguments or file not found
`),process.exit(0));n.file||(console.error("Error: --file is required"),process.exit(2));(0,o.existsSync)(n.file)||(console.log("File not found, skipping validation (new file)"),process.exit(0));var p=(0,o.readFileSync)(n.file,"utf-8");function d(s){let e=[],l=[{pattern:/^##\s+Summary/m,name:"## Summary"},{pattern:/^##\s+Scope/m,name:"## Scope"},{pattern:/^###\s+IN/m,name:"### IN (under Scope)"},{pattern:/^###\s+OUT/m,name:"### OUT (under Scope)"},{pattern:/^##\s+Success Criteria/m,name:"## Success Criteria"},{pattern:/^##\s+Execution Groups/m,name:"## Execution Groups"}];for(let{pattern:i,name:t}of l)i.test(s)||e.push(`Missing required section: ${t}`);if(/^###\s+Group\s+[A-Z]:/m.test(s)||e.push("Missing execution group (need at least one ### Group X: section)"),(s.match(/^###\s+Group\s+[A-Z]:.*/gm)||[]).length>0){let i=s.indexOf("## Execution Groups"),t=s.slice(i);t.includes("**Acceptance Criteria:**")||e.push("Execution groups should have **Acceptance Criteria:** sections"),t.includes("**Validation:**")||e.push("Execution groups should have **Validation:** command sections")}let a=s.match(/^###\s+OUT\s*\n([\s\S]*?)(?=^##|^###|\n---|\Z)/m);if(a){let i=a[1].trim();(!i||i==="-"||i.match(/^-\s*$/))&&e.push("OUT scope should not be empty - add explicit exclusions")}let r=s.match(/^##\s+Success Criteria\s*\n([\s\S]*?)(?=^##|\n---|\Z)/m);return r&&(r[1].match(/^-\s+\[\s*\]/gm)||[]).length===0&&e.push("Success Criteria should have checkbox items (- [ ])"),{passed:e.length===0,issues:e}}var c=d(p);if(c.passed)console.log("\u2713 Wish document validation passed"),process.exit(0);else{console.log("\u26A0 Wish document validation issues:");for(let s of c.issues)console.log(`  - ${s}`);process.exit(1)}
