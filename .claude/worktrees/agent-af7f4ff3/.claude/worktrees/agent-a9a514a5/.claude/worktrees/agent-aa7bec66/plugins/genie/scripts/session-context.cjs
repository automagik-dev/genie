#!/usr/bin/env node
"use strict";var c=require("fs"),a=require("path"),p=require("util"),u={};try{u=(0,p.parseArgs)({args:process.argv.slice(2),options:{help:{type:"boolean",short:"h"}},strict:!1}).values}catch{let e=process.argv.slice(2);for(let t of e)(t==="--help"||t==="-h")&&(u.help=!0)}u.help&&(console.log(`
session-context - Load active wish context on session start

Usage:
  node session-context.cjs
  node session-context.cjs --help

Options:
  -h, --help   Show this help message

Scans .genie/wishes/ for active (IN_PROGRESS) wishes and outputs
a summary to stderr so Claude Code can resume work context.
`),process.exit(0));function C(e){let t=e.match(/^#\s+(?:Wish:\s*)?(.+)/m);return t?t[1].trim():"Untitled"}function x(e){let t=e.split(`
`),n=!1,s=null,r=!1;for(let i of t){let o=i.match(/^###\s+(Group\s+[A-Z]:\s*.+)/);if(o){if(n&&r&&s)return s;s=o[1],n=!0,r=!1;continue}if(n&&(/^-\s+\[\s+\]/.test(i)&&(r=!0),/^##\s+[^#]/.test(i)||/^---/.test(i))){if(r&&s)return s;n=!1}}return n&&r&&s?s:null}function G(e){let t=(0,a.join)(e,".genie","wishes"),n=[];if(!(0,c.existsSync)(t))return n;try{let s=(0,c.readdirSync)(t,{withFileTypes:!0}).filter(r=>r.isDirectory()).map(r=>r.name);for(let r of s){let i=(0,a.join)(t,r,"wish.md");if(!(0,c.existsSync)(i))continue;let o=(0,c.readFileSync)(i,"utf-8"),h=o.match(/^\*\*Status:\*\*\s*(\w+)/m),l=h?h[1]:"UNKNOWN";if(l!=="IN_PROGRESS"&&l!=="DRAFT")continue;let f=(o.match(/^###\s+Group\s+[A-Z]:/gm)||[]).length,m=(o.match(/^-\s+\[[\sx]\]/gim)||[]).length,d=(o.match(/^-\s+\[x\]/gim)||[]).length,w=/BLOCKED/i.test(o);n.push({slug:r,title:C(o),status:l,totalGroups:f,completedCriteria:d,totalCriteria:m,currentGroup:x(o),hasBlocked:w})}}catch(s){console.error(`[session-context] Error scanning wishes: ${s instanceof Error?s.message:String(s)}`)}return n}var S=process.cwd(),g=G(S);g.length===0&&process.exit(0);console.error("");console.error("\u2728 Genie Session Context");console.error("=".repeat(40));for(let e of g){let t=e.totalCriteria>0?`${e.completedCriteria}/${e.totalCriteria} criteria met`:"no criteria tracked";console.error(""),console.error(`\u{1F4DC} Wish: ${e.title}`),console.error(`   Status: ${e.status} | ${t}`),console.error(`   Groups: ${e.totalGroups}`),e.currentGroup&&console.error(`   Current: ${e.currentGroup}`),e.hasBlocked&&console.error("   \u26A0 Has BLOCKED items"),console.error(`   File: .genie/wishes/${e.slug}/wish.md`)}console.error("");console.error("=".repeat(40));process.exit(0);
