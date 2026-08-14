#!/usr/bin/env node
"use strict";var O=Object.defineProperty;var F=Object.getOwnPropertyDescriptor;var G=Object.getOwnPropertyNames;var U=Object.prototype.hasOwnProperty;var z=(t,e)=>{for(var n in e)O(t,n,{get:e[n],enumerable:!0})},M=(t,e,n,i)=>{if(e&&typeof e=="object"||typeof e=="function")for(let s of G(e))!U.call(t,s)&&s!==n&&O(t,s,{get:()=>e[s],enumerable:!(i=F(e,s))||i.enumerable});return t};var B=t=>M(O({},"__esModule",{value:!0}),t);var oe={};z(oe,{TEMPLATE_CONTRACT_DATE:()=>N,WISH_FILE_SIZE_CAP:()=>g,isLegacyWish:()=>$,normaliseStatus:()=>x,parseHookInput:()=>V,parseWishTemplateContract:()=>A,proposedWishContent:()=>H,readWishDate:()=>L,readWishFile:()=>I,readWishStatus:()=>b,validateWish:()=>P});module.exports=B(oe);var h=require("node:fs"),W=require("node:util");var u=require("node:fs"),j="[a-z0-9][a-z0-9-]{0,63}",ae=new RegExp(`^${j}$`);function k(t,e){let n=null;try{let i=(0,u.lstatSync)(t);if(!i.isFile()||i.isSymbolicLink()||i.size>e)return null;n=(0,u.openSync)(t,u.constants.O_RDONLY|u.constants.O_NOFOLLOW|u.constants.O_NONBLOCK);let s=(0,u.fstatSync)(n);if(!s.isFile()||s.size>e)return null;let o=Buffer.alloc(s.size),r=0;for(;r<o.byteLength;){let l=(0,u.readSync)(n,o,r,o.byteLength-r,r);if(l===0)break;r+=l}return o.subarray(0,r).toString("utf8")}catch{return null}finally{if(n!==null)try{(0,u.closeSync)(n)}catch{}}}var q={"row-end":/^\|\s*\*\*Status\*\*\s*\|(\s*.*?\s*)\|\s*$/m,"first-pipe":/^\|\s*\*\*Status\*\*\s*\|(\s*[^|\n]*?\s*)\|/m},J=/^\*\*Status:\*\*(\s*.*)$/m;function D(t,e,n){let i=new RegExp(e,"gm");for(let s=i.exec(t);s!==null;s=i.exec(t)){if(!n||n(s[1]))return s[1].trim();i.lastIndex=s.index+1}return null}function v(t,e,n){return D(t,q[e].source,n)}function C(t,e){return D(t,J.source,e)}var E=`# Wish: <TODO: Title>

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | \`{{slug}}\` |
| **Date** | {{date}} |
| **Author** | <TODO: author> |
| **Appetite** | <TODO: small \\| medium \\| large> |
| **Branch** | \`wish/{{slug}}\` |
| **Repos touched** | <TODO: repos> |
| **Design** | _No brainstorm \u2014 direct wish_ |

## Summary

<TODO: 2\u20133 sentences. What this wish delivers and why it matters.>

## Scope

### IN

- <TODO: concrete deliverable 1>
- <TODO: concrete deliverable 2>

### OUT

- <TODO: explicit exclusion \u2014 OUT must contain at least one bullet>

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | <TODO: decision> | <TODO: why this over alternatives> |

## Simplicity Case

- **Simplest complete design:** <TODO: smallest design that satisfies current user stories>
- **Added machinery:** <TODO: none, or each mechanism and the present evidence that requires it>
- **Deferred until measured:** <TODO: future complexity and its concrete adoption trigger>
- **Complexity removed:** <TODO: states, failure modes, options, or dependencies deliberately avoided>

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] <TODO: testable criterion 1>
- [ ] <TODO: testable criterion 2>

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | <TODO: score + rationale> | <TODO: route> | <TODO: task description> |

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add:

- **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance.
- **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work.

Route the total in **Model** by portable role and reasoning effort: **0\u20131** \u2192
\`engineer-trivial\` / low; **2\u20133** \u2192 \`engineer-standard\` / medium or high;
**4\u20136** \u2192 \`engineer-complex\` / high; **7+** \u2192 \`engineer-complex\` plus an
independent \`final-gate\` at the highest justified effort. Each runtime maps
these to its matching native roles (such as the \`genie_*\` profiles where
installed). Keep
model and effort in runtime session/agent configuration, never skill frontmatter.

## Execution Groups

### Group 1: <TODO: Group 1 title>

**Goal:** <TODO: one-sentence goal for Group 1.>

**Deliverables:**
1. <TODO: deliverable 1>
2. <TODO: deliverable 2>

**Acceptance Criteria:**
- [ ] <TODO: testable acceptance criterion>

**Validation:**
\`\`\`bash
# TODO: command that exits 0 on success
echo "replace with real validation"
\`\`\`

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] <TODO: functional criterion \u2014 user-facing behavior works>
- [ ] <TODO: integration criterion \u2014 system works end-to-end>
- [ ] <TODO: regression criterion \u2014 existing behavior not broken>

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| <TODO: risk> | <TODO: Low \\| Medium \\| High> | <TODO: how to handle> |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

---

## Files to Create/Modify

\`\`\`
# TODO: list files this wish will touch
\`\`\`
`;var g=256*1024;function A(t){let e=t.split(`
`),n=[],i=[],s="",o=null,r=!1,l=!1;for(let c of e){if(o===null){let p=/^#\s+(.+?)\s*$/.exec(c);if(p){/^Wish:/.exec(p[1].trim())&&(o=/^#\s+Wish:/m);continue}}if(/^\s*```/.test(c)){l=!l;continue}if(l)continue;let d=/^##\s+(.+?)\s*$/.exec(c);if(d){n.push(d[1].trim()),r=d[1].trim()==="Scope";continue}let T=/^###\s+(.+?)\s*$/.exec(c);if(T){let p=T[1].trim(),m=/^Group\s+(\S+):/.exec(p);if(m){s===""&&(s=`Group ${m[1]}:`);continue}r&&i.push(p);continue}}if(n.length===0||s===""||o===null)throw new Error('wish template fixture must define ## sections, a "# Wish:" title, and a "### Group N:" heading');let a=new RegExp("^###\\s+Group\\s+\\S+:");return{sections:n,subsections:i,groupHeadingSource:s,groupHeadingPattern:a,checkboxPattern:/^-\s+\[[ xX]\]/,titlePattern:o}}var f=A(E),N="2026-07-29",Y=new Set(["SHIPPED","DONE","EXECUTED"]);function x(t){if(t==null)return null;let e=t.split(/\s+[—-]\s+/)[0].replace(/\s+\([^)]*\)\s*$/,"").trim();return e===""?null:e}function b(t){let e=v(t,"row-end");return x(e!==null?e:C(t))}function L(t){let e=/^\|\s*\*\*Date\*\*\s*\|\s*(\S*?)\s*\|\s*$/m.exec(t);if(e)return e[1].trim();let n=/^\*\*Date:\*\*(\s*.*)$/m.exec(t);return n?n[1].trim():null}function $(t){let e=L(t);return e===null||!/^\d{4}-\d{2}-\d{2}$/.test(e)?!1:e<N}function w(t,e){let n=t.findIndex((i,s)=>s>e&&/^##\s+/.test(i));return{start:e+1,end:n<0?t.length:n}}function S(t,e){return t.findIndex(n=>e.test(n))}function Q(t,e,n){let i=[],{start:s,end:o}=w(t,e);return t.slice(s,o).some(l=>n.checkboxPattern.test(l))||i.push({line:e+2,message:"Success Criteria should have checkbox items (- [ ] or - [x])"}),i}function X(t,e,n){let i=[],{start:s,end:o}=w(t,e),r=t.slice(s,o).map((l,a)=>({line:l,index:s+a})).filter(l=>n.groupHeadingPattern.test(l.line));if(r.length===0)return i.push({line:e+2,message:`Execution Groups must contain at least one group heading matching the template ("${n.groupHeadingSource}", e.g. "### Group 1:")`}),i;for(let l=0;l<r.length;l++){let a=r[l].index,y=l+1<r.length?r[l+1].index:o,c=t.slice(a,y).join(`
`),d=a+1;c.includes("**Acceptance Criteria:**")||i.push({line:d,message:"execution group is missing its **Acceptance Criteria:** section"}),c.includes("**Validation:**")||i.push({line:d,message:"execution group is missing its **Validation:** command section"})}return i}function Z(t,e){let n=[],{start:i,end:s}=w(t,e);return t.slice(i,s).filter(r=>/^\s*-\s+\S/.test(r)).length===0&&n.push({line:e+2,message:"OUT scope should not be empty - add explicit exclusions"}),n}function P(t){let e=[];if($(t))return b(t)===null&&e.push({line:1,message:"wish document must record a Status (metadata table row or **Status:** line)"}),{passed:e.length===0,issues:e};let n=t.split(`
`),i=b(t),s=i!==null&&Y.has(i);i===null&&e.push({line:1,message:"wish document must record a Status (metadata table row or **Status:** line)"}),f.titlePattern.test(t)||e.push({line:1,message:"Missing required section: # Wish: title"});for(let a of f.sections)new RegExp(`^##\\s+${_(a)}\\s*$`,"m").test(t)||e.push({line:1,message:`Missing required section: ## ${a}`});for(let a of f.subsections)new RegExp(`^###\\s+${_(a)}\\s*$`,"m").test(t)||e.push({line:1,message:`Missing required section: ### ${a}`});let o=S(n,/^###\s+OUT\s*$/i);o>=0&&e.push(...Z(n,o));let r=S(n,/^##\s+Execution Groups\s*$/i);r>=0&&e.push(...X(n,r,f));let l=S(n,/^##\s+Success Criteria\s*$/i);return l>=0&&!s&&e.push(...Q(n,l,f)),{passed:e.length===0,issues:e}}function _(t){return t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}function I(t){let e;try{e=(0,h.lstatSync)(t)}catch(i){let s=i.code;return s==="ENOENT"||s==="ENOTDIR"?{kind:"missing"}:{kind:"error",reason:`unable to stat wish file (${s??"unknown error"})`}}if(e.isSymbolicLink())return{kind:"error",reason:"refusing to read a wish file that is a symbolic link"};if(!e.isFile())return{kind:"error",reason:"wish path is not a regular file"};if(e.size>g)return{kind:"error",reason:`wish file exceeds the ${g}-byte size cap`};let n=k(t,g);return n===null?{kind:"error",reason:"unable to read wish file"}:{kind:"content",content:n}}function V(t){let e=t.trim();if(!e)return null;let n;try{n=JSON.parse(e)}catch{return null}if(typeof n!="object"||n===null||Array.isArray(n))return null;let i=n,s=i.tool_input??{},o=typeof s.file_path=="string"?s.file_path:null;return o===null?null:{eventName:typeof i.hook_event_name=="string"?i.hook_event_name:null,filePath:o,proposedContent:typeof s.content=="string"?s.content:void 0,editOldString:typeof s.old_string=="string"?s.old_string:void 0,editNewString:typeof s.new_string=="string"?s.new_string:void 0,replaceAll:typeof s.replace_all=="boolean"?s.replace_all:void 0}}function H(t,e){return e.proposedContent!==void 0&&e.proposedContent!==null?e.proposedContent:e.editOldString!==void 0&&e.editOldString!==null&&e.editNewString!==void 0&&e.editNewString!==null?e.replaceAll===!0?t.split(e.editOldString).join(e.editNewString):t.replace(e.editOldString,e.editNewString):null}function ee(t){let e={};try{e=(0,W.parseArgs)({args:t,options:{file:{type:"string",short:"f"},help:{type:"boolean",short:"h"}},strict:!1}).values}catch{let n={};for(let i=0;i<t.length;i++)(t[i]==="--file"||t[i]==="-f")&&t[i+1]?n.file=t[++i]:(t[i]==="--help"||t[i]==="-h")&&(n.help=!0);e=n}return{file:typeof e.file=="string"?e.file:void 0,help:e.help===!0}}function te(){console.log(`
validate-wish - Validate wish document structure against the canonical template

Usage:
  node validate-wish.cjs --file <path-to-wish.md>
  node validate-wish.cjs --help

As a PreToolUse/PostToolUse hook, receives JSON on stdin with
hook_event_name and tool_input.file_path.

Options:
  -f, --file   Path to wish document to validate
  -h, --help   Show this help message

Exit codes:
  0  Validation passed (or not a wish file, or a new wish being created)
  1  --file mode: validation failed (template structure violated, symlink or size cap)
  2  Hook mode (stdin JSON): validation failed \u2014 command-hook exit 2 is the blocking failure
`)}function ne(t){return t.includes(".genie/wishes/")&&t.endsWith(".md")}function ie(t,e){if(t.passed)return console.error("\u2713 Wish document validation passed"),0;console.error("\u26A0 Wish document validation issues:");for(let n of t.issues)console.error(`  - line ${n.line}: ${n.message}`);return e}function se(){let t=process.argv.slice(2),e=ee(t);if(e.help)return te(),0;let n=null;if(e.file===void 0)try{let a=(0,h.readFileSync)(0,"utf-8");n=V(a)}catch{}let i=e.file??n?.filePath??null;if(!i||!ne(i))return 0;let o=n!==null?2:1,r=I(i);if(r.kind==="missing")return console.error("Wish file not found, skipping validation (new wish)"),0;if(r.kind==="error")return console.error(`\u26A0 ${r.reason}: ${i}`),o;let l=r.content;if(n!==null&&n.eventName==="PreToolUse"){let a=H(r.content,n);a!==null&&(l=a)}return ie(P(l),o)}var re=process.argv[1]??"",R=re.split(/[\\/]/).pop()??"";(R==="validate-wish.cjs"||R==="validate-wish.ts")&&process.exit(se());0&&(module.exports={TEMPLATE_CONTRACT_DATE,WISH_FILE_SIZE_CAP,isLegacyWish,normaliseStatus,parseHookInput,parseWishTemplateContract,proposedWishContent,readWishDate,readWishFile,readWishStatus,validateWish});
