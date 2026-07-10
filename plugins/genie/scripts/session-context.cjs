#!/usr/bin/env node
"use strict";var i=require("fs"),l=require("path"),g=require("util"),d="SessionStart";if(!process.stdin.isTTY)try{JSON.parse((0,i.readFileSync)(0,"utf8")).hook_event_name==="UserPromptSubmit"&&(d="UserPromptSubmit")}catch{}var h={};try{h=(0,g.parseArgs)({args:process.argv.slice(2),options:{help:{type:"boolean",short:"h"}},strict:!1}).values}catch{let t=process.argv.slice(2);for(let s of t)(s==="--help"||s==="-h")&&(h.help=!0)}h.help&&(console.log(`
session-context - Load active wish context on session start

Usage:
  node session-context.cjs
  node session-context.cjs --help

Options:
  -h, --help   Show this help message

Scans .genie/wishes/ for active (IN_PROGRESS) wishes and outputs
a summary to stderr so Claude Code can resume work context.
`),process.exit(0));function y(t){let s=t.match(/^#\s+(?:Wish:\s*)?(.+)/m);return s?s[1].trim():"Untitled"}function O(t){let s=t.split(`
`),n=!1,e=null,r=!1;for(let c of s){let u=c.match(/^###\s+(Group\s+[A-Z]:\s*.+)/);if(u){if(n&&r&&e)return e;e=u[1],n=!0,r=!1;continue}if(n&&(/^-\s+\[\s+\]/.test(c)&&(r=!0),/^##\s+[^#]/.test(c)||/^---/.test(c))){if(r&&e)return e;n=!1}}return n&&r&&e?e:null}function v(t){let s=(0,l.join)(t,".genie","wishes"),n=[];if(!(0,i.existsSync)(s))return n;try{let e=(0,i.readdirSync)(s,{withFileTypes:!0}).filter(r=>r.isDirectory()).map(r=>r.name);for(let r of e){let c=(0,l.join)(s,r,"WISH.md"),u=(0,i.existsSync)(c)?c:(0,l.join)(s,r,"wish.md");if(!(0,i.existsSync)(u))continue;let a=(0,i.readFileSync)(u,"utf-8"),f=a.match(/^\*\*Status:\*\*\s*(\w+)/m),p=f?f[1]:"UNKNOWN";if(p!=="IN_PROGRESS"&&p!=="DRAFT")continue;let w=(a.match(/^###\s+Group\s+[A-Z]:/gm)||[]).length,x=(a.match(/^-\s+\[[\sx]\]/gim)||[]).length,C=(a.match(/^-\s+\[x\]/gim)||[]).length,G=/BLOCKED/i.test(a);n.push({slug:r,title:y(a),status:p,totalGroups:w,completedCriteria:C,totalCriteria:x,currentGroup:O(a),hasBlocked:G})}}catch(e){console.error(`[session-context] Error scanning wishes: ${e instanceof Error?e.message:String(e)}`)}return n}var k=process.cwd(),S=v(k);S.length===0&&(process.env.PLUGIN_ROOT&&process.stdout.write("{}"),process.exit(0));var o=["","\u2728 Genie Session Context","=".repeat(40)];for(let t of S){let s=t.totalCriteria>0?`${t.completedCriteria}/${t.totalCriteria} criteria met`:"no criteria tracked";o.push(""),o.push(`\u{1F4DC} Wish: ${t.title}`),o.push(`   Status: ${t.status} | ${s}`),o.push(`   Groups: ${t.totalGroups}`),t.currentGroup&&o.push(`   Current: ${t.currentGroup}`),t.hasBlocked&&o.push("   \u26A0 Has BLOCKED items"),o.push(`   File: .genie/wishes/${t.slug}/WISH.md`)}o.push("");o.push("=".repeat(40));var m=o.join(`
`);process.env.PLUGIN_ROOT?process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:d,additionalContext:m}})):console.error(m);process.exit(0);
