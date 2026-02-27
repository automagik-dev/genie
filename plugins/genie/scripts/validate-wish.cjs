#!/usr/bin/env node
"use strict";var n=require("fs"),p=require("util"),i={};try{i=(0,p.parseArgs)({args:process.argv.slice(2),options:{file:{type:"string",short:"f"},help:{type:"boolean",short:"h"}},strict:!1}).values}catch{let e=process.argv.slice(2);for(let s=0;s<e.length;s++)(e[s]==="--file"||e[s]==="-f")&&e[s+1]?i.file=e[++s]:(e[s]==="--help"||e[s]==="-h")&&(i.help=!0)}i.help&&(console.log(`
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
`),process.exit(0));function h(){if(i.file)return i.file;try{let e=(0,n.readFileSync)(0,"utf-8").trim();if(e){let s=JSON.parse(e),r=s?.tool_input?.file_path||s?.file_path;if(r)return r}}catch{}return null}var o=h();o||process.exit(0);(!o.includes(".genie/wishes/")||!o.endsWith(".md"))&&process.exit(0);(0,n.existsSync)(o)||(console.error("File not found, skipping validation (new file)"),process.exit(0));var d=(0,n.readFileSync)(o,"utf-8");function f(e){let s=[],r=[{pattern:/^##\s+Summary/m,name:"## Summary"},{pattern:/^##\s+Scope/m,name:"## Scope"},{pattern:/^###\s+IN/m,name:"### IN (under Scope)"},{pattern:/^###\s+OUT/m,name:"### OUT (under Scope)"},{pattern:/^##\s+Success Criteria/m,name:"## Success Criteria"},{pattern:/^##\s+Execution Groups/m,name:"## Execution Groups"}];for(let{pattern:t,name:a}of r)t.test(e)||s.push(`Missing required section: ${a}`);if(/^###\s+Group\s+[A-Z]:/m.test(e)||s.push("Missing execution group (need at least one ### Group X: section)"),(e.match(/^###\s+Group\s+[A-Z]:.*/gm)||[]).length>0){let t=e.indexOf("## Execution Groups"),a=e.slice(t);a.includes("**Acceptance Criteria:**")||s.push("Execution groups should have **Acceptance Criteria:** sections"),a.includes("**Validation:**")||s.push("Execution groups should have **Validation:** command sections")}let c=e.match(/^###\s+OUT\s*\n([\s\S]*?)(?=^##|^###|\n---)/m);if(c){let t=c[1].trim();(!t||t==="-"||/^-\s*$/.test(t))&&s.push("OUT scope should not be empty - add explicit exclusions")}let u=e.match(/^##\s+Success Criteria\s*\n([\s\S]*?)(?=^##|\n---)/m);return u&&(u[1].match(/^-\s+\[\s*\]/gm)||[]).length===0&&s.push("Success Criteria should have checkbox items (- [ ])"),{passed:s.length===0,issues:s}}var l=f(d);if(l.passed)console.error("\u2713 Wish document validation passed"),process.exit(0);else{console.error("\u26A0 Wish document validation issues:");for(let e of l.issues)console.error(`  - ${e}`);process.exit(1)}
