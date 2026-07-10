#!/usr/bin/env node
"use strict";var e=require("fs"),i=require("path"),f=require("util"),a={};try{a=(0,f.parseArgs)({args:process.argv.slice(2),options:{help:{type:"boolean",short:"h"}},strict:!1}).values}catch{let s=process.argv.slice(2);for(let t of s)(t==="--help"||t==="-h")&&(a.help=!0)}a.help&&(console.log(`
validate-completion - Check forge completion status

Usage:
  node validate-completion.cjs
  node validate-completion.cjs --help

Options:
  -h, --help   Show this help message

This script checks for incomplete work and logs warnings to stderr.
It always exits 0 (advisory only).
`),process.exit(0));function v(s){let t=(0,i.join)(s,".genie","wishes"),c=[];if(!(0,e.existsSync)(t))return c;try{let r=(0,e.readdirSync)(t,{withFileTypes:!0}).filter(o=>o.isDirectory()).map(o=>o.name);for(let o of r){let l=(0,i.join)(t,o,"WISH.md"),h=(0,e.existsSync)(l)?l:(0,i.join)(t,o,"wish.md");if(!(0,e.existsSync)(h))continue;let n=(0,e.readFileSync)(h,"utf-8"),p=n.match(/^\*\*Status:\*\*\s*(\w+)/m),u=p?p[1]:"UNKNOWN";if(u==="DONE")continue;let k=(n.match(/^###\s+Group\s+[A-Z]:/gm)||[]).length,g=(n.match(/^-\s+\[\s+\]/gm)||[]).length,w=(n.match(/BLOCKED/gi)||[]).length;c.push({slug:o,status:u,incompleteTasks:g>0?Math.ceil(g/3):0,blockedTasks:w>0?1:0,totalGroups:k})}}catch(r){console.error(`[validate-completion] Error finding wishes: ${r instanceof Error?r.message:String(r)}`)}return c}var T=process.cwd(),S=v(T),m=S.filter(s=>s.status==="IN_PROGRESS");m.length===0&&(process.env.PLUGIN_ROOT&&process.stdout.write("{}"),process.exit(0));var d=!1;for(let s of m)(s.incompleteTasks>0||s.blockedTasks>0)&&(d=!0,console.error(`
\u26A0 Active wish "${s.slug}" has incomplete work:`),s.incompleteTasks>0&&console.error(`  - ~${s.incompleteTasks} tasks with unchecked criteria`),s.blockedTasks>0&&console.error(`  - ${s.blockedTasks} BLOCKED task(s) need attention`),console.error("  Run /forge to continue or /review to validate."));d&&console.error("");process.env.PLUGIN_ROOT&&process.stdout.write("{}");process.exit(0);
