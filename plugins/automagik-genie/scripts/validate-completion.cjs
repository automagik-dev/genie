#!/usr/bin/env bun
"use strict";var g=require("util"),t=require("fs"),c=require("path"),{values:d}=(0,g.parseArgs)({args:Bun.argv.slice(2),options:{session:{type:"string",short:"s"},help:{type:"boolean",short:"h"}},strict:!0});d.help&&(console.log(`
validate-completion.ts - Check forge completion status

Usage:
  bun validate-completion.ts --session <session-id>
  bun validate-completion.ts --help

Options:
  -s, --session   Session ID (currently unused, for future integration)
  -h, --help      Show this help message

This script checks for incomplete work and logs warnings.
It always exits 0 (advisory only).
`),process.exit(0));function w(s){let i=(0,c.join)(s,".genie","wishes"),n=[];if(!(0,t.existsSync)(i))return n;try{let r=(0,t.readdirSync)(i,{withFileTypes:!0}).filter(e=>e.isDirectory()).map(e=>e.name);for(let e of r){let a=(0,c.join)(i,e,"wish.md");if(!(0,t.existsSync)(a))continue;let o=(0,t.readFileSync)(a,"utf-8"),l=o.match(/^\*\*Status:\*\*\s*(\w+)/m),h=l?l[1]:"UNKNOWN";if(h==="DONE")continue;let f=(o.match(/^###\s+Group\s+[A-Z]:/gm)||[]).length,u=(o.match(/^-\s+\[\s+\]/gm)||[]).length,v=(o.match(/^-\s+\[x\]/gim)||[]).length,k=(o.match(/BLOCKED/gi)||[]).length;n.push({slug:e,status:h,incompleteTasks:u>0?Math.ceil(u/3):0,blockedTasks:k>0?1:0,totalTasks:f})}}catch{}return n}var b=process.cwd(),T=w(b),p=T.filter(s=>s.status==="IN_PROGRESS");p.length===0&&process.exit(0);var m=!1;for(let s of p)(s.incompleteTasks>0||s.blockedTasks>0)&&(m=!0,console.log(`
\u26A0 Active wish "${s.slug}" has incomplete work:`),s.incompleteTasks>0&&console.log(`  - ~${s.incompleteTasks} tasks with unchecked criteria`),s.blockedTasks>0&&console.log(`  - ${s.blockedTasks} BLOCKED task(s) need attention`),console.log("  Run /forge to continue or /review to validate."));m&&console.log("");process.exit(0);
