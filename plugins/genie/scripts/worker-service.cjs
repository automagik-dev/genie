#!/usr/bin/env bun
"use strict";var T=require("http"),i=require("fs"),h=require("path"),m=require("os"),p=require("child_process"),u=48888,w=(0,h.join)((0,m.homedir)(),".genie"),g=(0,h.join)(w,"worker.pid"),v=(0,h.join)(w,"workflow-state.json");(0,i.existsSync)(w)||(0,i.mkdirSync)(w,{recursive:!0});function l(){try{if((0,i.existsSync)(v))return JSON.parse((0,i.readFileSync)(v,"utf-8"))}catch{}return{lastUpdate:new Date().toISOString()}}function f(o){o.lastUpdate=new Date().toISOString(),(0,i.writeFileSync)(v,JSON.stringify(o,null,2))}function n(o,e,a=200){o.writeHead(a,{"Content-Type":"application/json"}),o.end(JSON.stringify(e))}function d(o){return new Promise((e,a)=>{let s="";o.on("data",c=>s+=c),o.on("end",()=>{try{e(s?JSON.parse(s):{})}catch{a(new Error("Invalid JSON"))}})})}async function y(o,e){let s=new URL(o.url||"/",`http://localhost:${u}`).pathname,c=o.method||"GET";if(e.setHeader("Access-Control-Allow-Origin","*"),e.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS"),e.setHeader("Access-Control-Allow-Headers","Content-Type"),c==="OPTIONS"){e.writeHead(204),e.end();return}if(s==="/health"||s==="/"){n(e,{status:"ok",service:"automagik-genie",version:process.env.GENIE_VERSION||"dev",port:u,uptime:process.uptime()});return}if(s==="/api/workflow/status"&&c==="GET"){let r=l();n(e,r);return}if(s==="/api/workflow/update"&&c==="POST"){try{let r=await d(o),t=l();Object.assign(t,r),f(t),n(e,{success:!0,state:t})}catch{n(e,{error:"Invalid request body"},400)}return}if(s==="/api/workflow/wish/start"&&c==="POST"){try{let r=await d(o),t=l();t.activeWish=r.slug,f(t),n(e,{success:!0,wish:r.slug})}catch{n(e,{error:"Invalid request"},400)}return}if(s==="/api/workflow/forge/start"&&c==="POST"){try{let r=await d(o),t=l();t.activeForge={wishSlug:r.wishSlug,completedTasks:[],failedTasks:[]},f(t),n(e,{success:!0,forge:t.activeForge})}catch{n(e,{error:"Invalid request"},400)}return}if(s==="/api/workflow/forge/task"&&c==="POST"){try{let r=await d(o),t=l();if(!t.activeForge){n(e,{error:"No active forge session"},400);return}r.status==="started"?t.activeForge.currentTask=r.task:r.status==="completed"?(t.activeForge.completedTasks.push(r.task),t.activeForge.currentTask=void 0):r.status==="failed"&&(t.activeForge.failedTasks.push(r.task),t.activeForge.currentTask=void 0),f(t),n(e,{success:!0,forge:t.activeForge})}catch{n(e,{error:"Invalid request"},400)}return}if(s==="/api/hook/context"&&c==="GET"){let r=l(),t="";r.activeWish&&(t+=`Active Wish: ${r.activeWish}
`),r.activeForge&&(t+=`Active Forge: ${r.activeForge.wishSlug}
`,r.activeForge.currentTask&&(t+=`  Current Task: ${r.activeForge.currentTask}
`),t+=`  Completed: ${r.activeForge.completedTasks.length} tasks
`,r.activeForge.failedTasks.length>0&&(t+=`  Failed: ${r.activeForge.failedTasks.length} tasks
`)),t?n(e,{context:t}):n(e,{context:null});return}if(s==="/api/admin/restart"&&c==="POST"){n(e,{success:!0,message:"Worker restarting..."}),setTimeout(()=>{process.exit(0)},100);return}n(e,{error:"Not found",path:s},404)}function S(){try{if((0,i.existsSync)(g)){let o=parseInt((0,i.readFileSync)(g,"utf-8").trim(),10);return process.kill(o,0),!0}}catch{}return!1}function I(){(0,i.writeFileSync)(g,String(process.pid))}var k=process.argv[2];if(k==="start"){if(S()&&(console.log("Worker already running"),process.exit(0)),process.argv[3]!=="--foreground"){let e=(0,p.spawn)(process.argv[0],[process.argv[1],"start","--foreground"],{detached:!0,stdio:"ignore"});e.unref(),console.log(`Worker started (PID: ${e.pid})`),process.exit(0)}let o=(0,T.createServer)((e,a)=>{y(e,a).catch(s=>{console.error("Request error:",s),n(a,{error:"Internal server error"},500)})});o.listen(u,"127.0.0.1",()=>{I(),console.log(`automagik-genie worker listening on http://127.0.0.1:${u}`)}),process.on("SIGTERM",()=>{o.close(),process.exit(0)}),process.on("SIGINT",()=>{o.close(),process.exit(0)})}else if(k==="stop"){try{if((0,i.existsSync)(g)){let o=parseInt((0,i.readFileSync)(g,"utf-8").trim(),10);process.kill(o,"SIGTERM"),console.log("Worker stopped")}else console.log("Worker not running")}catch{console.log("Worker not running")}process.exit(0)}else if(k==="status"){if(S()){let o=(0,i.readFileSync)(g,"utf-8").trim();console.log(`Worker running (PID: ${o})`);try{(0,p.execSync)(`curl -s http://127.0.0.1:${u}/health`,{encoding:"utf-8"}),console.log("Health: OK")}catch{console.log("Health: Unable to connect")}}else console.log("Worker not running");process.exit(0)}else if(k==="hook"){if(process.argv[3]==="context")try{let e=(0,p.execSync)(`curl -s http://127.0.0.1:${u}/api/hook/context`,{encoding:"utf-8"}),a=JSON.parse(e);a.context&&console.log(`
<genie-workflow>
${a.context}</genie-workflow>
`)}catch{}process.exit(0)}else console.log(`
automagik-genie worker service

Usage:
  worker-service start     Start the worker (daemonized)
  worker-service stop      Stop the worker
  worker-service status    Check worker status
  worker-service hook <type>  Run hook command

Endpoints:
  GET  /health                    Health check
  GET  /api/workflow/status       Get workflow state
  POST /api/workflow/update       Update workflow state
  POST /api/workflow/wish/start   Start tracking a wish
  POST /api/workflow/forge/start  Start forge session
  POST /api/workflow/forge/task   Update forge task status
  GET  /api/hook/context          Get context for injection
  POST /api/admin/restart         Restart worker
`),process.exit(0);
