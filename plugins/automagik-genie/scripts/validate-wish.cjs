#!/usr/bin/env node
"use strict";var o=require("fs"),p=require("util"),{values:a}=(0,p.parseArgs)({args:process.argv.slice(2),options:{file:{type:"string",short:"f"},help:{type:"boolean",short:"h"}},strict:!1});a.help&&(console.log(`
validate-wish - Validate wish document structure

Usage:
  node validate-wish.cjs --file <path-to-wish.md>
  node validate-wish.cjs --help

As a PreToolUse hook, receives JSON on stdin with tool_input.file_path.

Options:
  -f, --file   Path to wish document to validate
  -h, --help   Show this help message

Exit codes:
  0  Validation passed (or not a wish file)
  1  Validation failed (missing required sections)
  2  Invalid arguments or file not found
`),process.exit(0));function h(){if(a.file)return a.file;try{let e=(0,o.readFileSync)(0,"utf-8").trim();if(e){let s=JSON.parse(e),n=s?.tool_input?.file_path||s?.file_path;if(n)return n}}catch{}return null}var i=h();i||process.exit(0);(!i.includes(".genie/wishes/")||!i.endsWith(".md"))&&process.exit(0);(0,o.existsSync)(i)||(console.error("File not found, skipping validation (new file)"),process.exit(0));var d=(0,o.readFileSync)(i,"utf-8");function f(e){let s=[],n=[{pattern:/^##\s+Summary/m,name:"## Summary"},{pattern:/^##\s+Scope/m,name:"## Scope"},{pattern:/^###\s+IN/m,name:"### IN (under Scope)"},{pattern:/^###\s+OUT/m,name:"### OUT (under Scope)"},{pattern:/^##\s+Success Criteria/m,name:"## Success Criteria"},{pattern:/^##\s+Execution Groups/m,name:"## Execution Groups"}];for(let{pattern:t,name:r}of n)t.test(e)||s.push(`Missing required section: ${r}`);if(/^###\s+Group\s+[A-Z]:/m.test(e)||s.push("Missing execution group (need at least one ### Group X: section)"),(e.match(/^###\s+Group\s+[A-Z]:.*/gm)||[]).length>0){let t=e.indexOf("## Execution Groups"),r=e.slice(t);r.includes("**Acceptance Criteria:**")||s.push("Execution groups should have **Acceptance Criteria:** sections"),r.includes("**Validation:**")||s.push("Execution groups should have **Validation:** command sections")}let c=e.match(/^###\s+OUT\s*\n([\s\S]*?)(?=^##|^###|\n---)/m);if(c){let t=c[1].trim();(!t||t==="-"||/^-\s*$/.test(t))&&s.push("OUT scope should not be empty - add explicit exclusions")}let u=e.match(/^##\s+Success Criteria\s*\n([\s\S]*?)(?=^##|\n---)/m);return u&&(u[1].match(/^-\s+\[\s*\]/gm)||[]).length===0&&s.push("Success Criteria should have checkbox items (- [ ])"),{passed:s.length===0,issues:s}}var l=f(d);if(l.passed)console.error("\u2713 Wish document validation passed"),process.exit(0);else{console.error("\u26A0 Wish document validation issues:");for(let e of l.issues)console.error(`  - ${e}`);process.exit(1)}
