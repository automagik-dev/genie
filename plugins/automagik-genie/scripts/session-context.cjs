#!/usr/bin/env node
"use strict";var c=require("fs"),p=require("path"),m=require("util"),{values:x}=(0,m.parseArgs)({args:process.argv.slice(2),options:{help:{type:"boolean",short:"h"}},strict:!1});x.help&&(console.log(`
session-context - Load active wish context on session start

Usage:
  node session-context.cjs
  node session-context.cjs --help

Options:
  -h, --help   Show this help message

Scans .genie/wishes/ for active (IN_PROGRESS) wishes and outputs
a summary to stderr so Claude Code can resume work context.
`),process.exit(0));function C(t){let s=t.match(/^#\s+(?:Wish:\s*)?(.+)/m);return s?s[1].trim():"Untitled"}function G(t){let s=/^###\s+(Group\s+[A-Z]:\s*.+)/gm,a=/^-\s+\[\s+\]/gm,g=/^-\s+\[x\]/gim,n,h=null,r=t.split(`
`),o=!1,e=null,i=!1;for(let l of r){let u=l.match(/^###\s+(Group\s+[A-Z]:\s*.+)/);if(u){if(o&&i&&e)return e;e=u[1],o=!0,i=!1;continue}if(o&&(/^-\s+\[\s+\]/.test(l)&&(i=!0),/^##\s+[^#]/.test(l)||/^---/.test(l))){if(i&&e)return e;o=!1}}return o&&i&&e?e:null}function w(t){let s=(0,p.join)(t,".genie","wishes"),a=[];if(!(0,c.existsSync)(s))return a;try{let g=(0,c.readdirSync)(s,{withFileTypes:!0}).filter(n=>n.isDirectory()).map(n=>n.name);for(let n of g){let h=(0,p.join)(s,n,"wish.md");if(!(0,c.existsSync)(h))continue;let r=(0,c.readFileSync)(h,"utf-8"),o=r.match(/^\*\*Status:\*\*\s*(\w+)/m),e=o?o[1]:"UNKNOWN";if(e!=="IN_PROGRESS"&&e!=="DRAFT")continue;let i=(r.match(/^###\s+Group\s+[A-Z]:/gm)||[]).length,l=(r.match(/^-\s+\[[\sx]\]/gim)||[]).length,u=(r.match(/^-\s+\[x\]/gim)||[]).length,d=/BLOCKED/i.test(r);a.push({slug:n,title:C(r),status:e,totalGroups:i,completedCriteria:u,totalCriteria:l,currentGroup:G(r),hasBlocked:d})}}catch{}return a}var S=process.cwd(),f=w(S);f.length===0&&process.exit(0);console.error("");console.error("\u2728 Genie Session Context");console.error("=".repeat(40));for(let t of f){let s=t.totalCriteria>0?`${t.completedCriteria}/${t.totalCriteria} criteria met`:"no criteria tracked";console.error(""),console.error(`\u{1F4DC} Wish: ${t.title}`),console.error(`   Status: ${t.status} | ${s}`),console.error(`   Groups: ${t.totalGroups}`),t.currentGroup&&console.error(`   Current: ${t.currentGroup}`),t.hasBlocked&&console.error("   \u26A0 Has BLOCKED items"),console.error(`   File: .genie/wishes/${t.slug}/wish.md`)}console.error("");console.error("=".repeat(40));process.exit(0);
