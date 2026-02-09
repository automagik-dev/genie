#!/usr/bin/env node
"use strict";var e=require("fs"),c=require("path"),u=require("util"),{values:k}=(0,u.parseArgs)({args:process.argv.slice(2),options:{help:{type:"boolean",short:"h"}},strict:!1});k.help&&(console.log(`
validate-completion - Check forge completion status

Usage:
  node validate-completion.cjs
  node validate-completion.cjs --help

Options:
  -h, --help   Show this help message

This script checks for incomplete work and logs warnings to stderr.
It always exits 0 (advisory only).
`),process.exit(0));function w(s){let i=(0,c.join)(s,".genie","wishes"),n=[];if(!(0,e.existsSync)(i))return n;try{let g=(0,e.readdirSync)(i,{withFileTypes:!0}).filter(t=>t.isDirectory()).map(t=>t.name);for(let t of g){let r=(0,c.join)(i,t,"wish.md");if(!(0,e.existsSync)(r))continue;let o=(0,e.readFileSync)(r,"utf-8"),a=o.match(/^\*\*Status:\*\*\s*(\w+)/m),l=a?a[1]:"UNKNOWN";if(l==="DONE")continue;let f=(o.match(/^###\s+Group\s+[A-Z]:/gm)||[]).length,h=(o.match(/^-\s+\[\s+\]/gm)||[]).length,d=(o.match(/BLOCKED/gi)||[]).length;n.push({slug:t,status:l,incompleteTasks:h>0?Math.ceil(h/3):0,blockedTasks:d>0?1:0,totalGroups:f})}}catch{}return n}var T=process.cwd(),b=w(T),p=b.filter(s=>s.status==="IN_PROGRESS");p.length===0&&process.exit(0);var m=!1;for(let s of p)(s.incompleteTasks>0||s.blockedTasks>0)&&(m=!0,console.error(`
\u26A0 Active wish "${s.slug}" has incomplete work:`),s.incompleteTasks>0&&console.error(`  - ~${s.incompleteTasks} tasks with unchecked criteria`),s.blockedTasks>0&&console.error(`  - ${s.blockedTasks} BLOCKED task(s) need attention`),console.error("  Run /forge to continue or /review to validate."));m&&console.error("");process.exit(0);
