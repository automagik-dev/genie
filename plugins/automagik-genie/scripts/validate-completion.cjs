#!/usr/bin/env node
"use strict";var e=require("fs"),c=require("path"),g=require("util"),a={};try{a=(0,g.parseArgs)({args:process.argv.slice(2),options:{help:{type:"boolean",short:"h"}},strict:!1}).values}catch{let s=process.argv.slice(2);for(let t of s)(t==="--help"||t==="-h")&&(a.help=!0)}a.help&&(console.log(`
validate-completion - Check forge completion status

Usage:
  node validate-completion.cjs
  node validate-completion.cjs --help

Options:
  -h, --help   Show this help message

This script checks for incomplete work and logs warnings to stderr.
It always exits 0 (advisory only).
`),process.exit(0));function w(s){let t=(0,c.join)(s,".genie","wishes"),i=[];if(!(0,e.existsSync)(t))return i;try{let r=(0,e.readdirSync)(t,{withFileTypes:!0}).filter(o=>o.isDirectory()).map(o=>o.name);for(let o of r){let l=(0,c.join)(t,o,"wish.md");if(!(0,e.existsSync)(l))continue;let n=(0,e.readFileSync)(l,"utf-8"),h=n.match(/^\*\*Status:\*\*\s*(\w+)/m),u=h?h[1]:"UNKNOWN";if(u==="DONE")continue;let d=(n.match(/^###\s+Group\s+[A-Z]:/gm)||[]).length,p=(n.match(/^-\s+\[\s+\]/gm)||[]).length,k=(n.match(/BLOCKED/gi)||[]).length;i.push({slug:o,status:u,incompleteTasks:p>0?Math.ceil(p/3):0,blockedTasks:k>0?1:0,totalGroups:d})}}catch(r){console.error(`[validate-completion] Error finding wishes: ${r instanceof Error?r.message:String(r)}`)}return i}var v=process.cwd(),T=w(v),m=T.filter(s=>s.status==="IN_PROGRESS");m.length===0&&process.exit(0);var f=!1;for(let s of m)(s.incompleteTasks>0||s.blockedTasks>0)&&(f=!0,console.error(`
\u26A0 Active wish "${s.slug}" has incomplete work:`),s.incompleteTasks>0&&console.error(`  - ~${s.incompleteTasks} tasks with unchecked criteria`),s.blockedTasks>0&&console.error(`  - ${s.blockedTasks} BLOCKED task(s) need attention`),console.error("  Run /forge to continue or /review to validate."));f&&console.error("");process.exit(0);
