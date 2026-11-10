import { join } from "node:path";
const root = process.cwd();
const tokenFile = join(root, ".woodshed/preview-api-token");
const processHandle = Bun.spawn([process.execPath,"src/server.ts"], {env:{...process.env,WOODSHED_DEMO:"1",WOODSHED_PORT:"7344"},stdout:"pipe",stderr:"pipe"});
const output = new Response(processHandle.stdout).text();
const errors = new Response(processHandle.stderr).text();
const base="http://127.0.0.1:7344";
function check(ok:unknown, text:string):asserts ok {if(!ok)throw new Error(text);}
try {
 let token="";let ready=false;
 for(let i=0;i<100;i++){
  if(await Bun.file(tokenFile).exists())token=(await Bun.file(tokenFile).text()).trim();
  try{if(token){const r=await fetch(`${base}/health`,{headers:{Authorization:`Bearer ${token}`}});ready=r.ok;if(ready)break;}}catch{}
  if(processHandle.exitCode!==null)throw new Error(await errors);
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 check(ready,"Preview API did not start");
 const auth={Authorization:`Bearer ${token}`};
 check((await fetch(`${base}/api/state`)).status===401,"State must require authentication");
 check((await fetch(`${base}/health`)).status===401,"Health must require authentication");
 check((await fetch(`${base}/api/events`)).status===401,"Stream must require authentication");
 check((await fetch(`${base}/api/state`,{headers:{...auth,Origin:base}})).status===401,"Browser origins must be rejected");
 check((await fetch(`${base}/api/state`,{headers:{...auth,Host:"attacker.example"}})).status===403,"Unexpected Host must be rejected");
 const state=await fetch(`${base}/api/state`,{headers:auth}).then(r=>r.json());
 check(state.demo&&!state.automation,"Smoke must only run against a preview");
 const stream=await fetch(`${base}/api/events`,{headers:auth});check(stream.headers.get("content-type")==="text/event-stream","Expected live state stream");
 const reader=stream.body!.getReader();const first=await reader.read();check(new TextDecoder().decode(first.value).includes("event: state"),"Expected initial state event");
 const record=state.prs[0];
 const paused=await fetch(`${base}/api/prs/${record.snapshot.number}/pause`,{method:"POST",headers:auth,body:JSON.stringify({head:record.snapshot.head})});check(paused.ok,"Preview pause should persist locally");
 const update=await reader.read();check(new TextDecoder().decode(update.value).includes('"Paused by you"'),"Expected pushed change after action");
 await reader.cancel();
 const health=await fetch(`${base}/health`,{headers:auth}).then(r=>r.json());check(typeof health.queueDepth==="number","Expected queue health");
 console.log("Passed: token authentication, Origin/Host rejection, health, pushed state, preview action isolation.");
} finally {processHandle.kill();await processHandle.exited;await output;await errors;}
