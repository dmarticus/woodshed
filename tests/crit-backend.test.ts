import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAPIToken, authorized } from "../src/api-auth";
import { StateEvents } from "../src/events";
import { Controller } from "../src/controller";
import { Store } from "../src/store";
import { decide, fingerprint, type Config, type Snapshot } from "../src/model";
import { assessmentKey } from "../src/triage";
import { GitHub } from "../src/github";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function temp() { const root=mkdtempSync(join(tmpdir(),"woodshed-crit-"));roots.push(root);return root; }
const snapshot = (): Snapshot => ({ number:42,title:"Fixture",url:"https://github.com/example/project/pull/42",head:"a",branch:"feature",base:"main",state:"OPEN",draft:false,mergeable:"MERGEABLE",mergeStateStatus:"CLEAN",reviewDecision:"APPROVED",checks:[{name:"Tests",status:"COMPLETED",conclusion:"SUCCESS",url:""}],threads:[],reviews:[{author:"reviewer",state:"APPROVED",head:"a",body:"",submittedAt:""}],labels:[] });
function harness() {
  const store=new Store(":memory:"); let live=snapshot(); let resumes=0;
  const config={repository:"example/project",mode:"auto",automation:true,maxConcurrentJobs:1,maxAttempts:3,runCapUSD:5,dailyCapUSD:20} as Config;
  const runner:any={launchTriage:async()=>{},stop:async()=>{},resume:async()=>{resumes++;},status:async()=>({state:"working"}),telemetry:async(job:any)=>store.run(job.name)};
  const github:any={snapshot:async()=>live,canMaintain:async()=>true,label:async()=>{}};
  const controller=new Controller(config,store,github,runner);
  store.put({snapshot:live,decision:{kind:"human",reason:"Confirm product behavior",question:"Keep reports visible?",title:"Choose visibility",options:[{id:"keep",label:"Keep visible",value:"Keep reports visible"}]},paused:false,attempts:0,fingerprint:fingerprint(live)});
  return {store,config,runner,controller,live:(next:Snapshot)=>{live=next;},resumes:()=>resumes};
}

test("the API credential persists privately and rejects symlinks and browser-origin requests",()=>{
  const path=join(temp(),"api-token"); const key=loadAPIToken(path);
  expect(loadAPIToken(path)).toBe(key);expect(statSync(path).mode&0o777).toBe(0o600);
  expect(authorized(new Request("http://127.0.0.1",{headers:{Authorization:`Bearer ${key}`}}),key)).toBe(true);
  for(const origin of ["https://example.com","http://127.0.0.1:7341",""]) expect(authorized(new Request("http://127.0.0.1",{headers:{Authorization:`Bearer ${key}`,Origin:origin}}),key)).toBe(false);
  expect(authorized(new Request("http://127.0.0.1"),key)).toBe(false);
  const link=join(temp(),"link");symlinkSync(path,link);expect(()=>loadAPIToken(link)).toThrow();
});

test("live state streams send updates and can be cancelled without a polling client",async()=>{
  const events=new StateEvents();events.publish({version:1});const reader=events.response().body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"version":1');
  events.publish({version:2});expect(new TextDecoder().decode((await reader.read()).value)).toContain('"version":2');
  await reader.cancel();events.publish({version:3});
});

test.each(["same", "changed"])("stale answers are preserved and %s questions are handled without replaying blindly",async kind=>{
  const h=harness();const old=h.store.get(42)!;
  const live={...snapshot(),head:"b",reviews:[]};h.live(live);
  const record={...old,snapshot:live};
  if(kind==="changed") record.decision={...record.decision,question:"Hide archived reports?"};
  record.assessment={head:"b",key:assessmentKey(live),report:"Verified question",attempts:1,followups:0,result:{head:"b",route:"ask",category:"product",title:record.decision.title!,reason:record.decision.reason,question:record.decision.question!,options:record.decision.options,evidence:[{url:live.url,detail:"Current reviewer asks this question"}]}};
  h.store.put(record);
  await h.controller.action(42,"reply",{head:"a",decisionId:old.decision.id,questionKey:old.decision.questionKey,message:"Keep reports visible"});
  if(kind==="same") {expect(h.store.get(42)?.assessment?.reply).toBe("Keep reports visible");expect(h.store.get(42)?.pendingAnswer).toBeUndefined();}
  else {expect(h.store.get(42)?.pendingAnswer).toMatchObject({text:"Keep reports visible",requiresConfirmation:true});expect(h.store.get(42)?.assessment?.reply).toBeUndefined();}
});

test.each([19.5,1])("a run-only top-up respects daily spend %s and never changes default caps",async spent=>{
  const h=harness();const record=h.store.get(42)!;const now=new Date().toISOString();
  record.job={name:"saved",head:"a",fingerprint:record.fingerprint,startedAt:now,adapter:"app-server",budgetUSD:5};record.humanHead="a";record.budgetDay="today";record.decision={kind:"human",reason:"Spend cap reached"};h.store.put(record);
  h.store.saveRun({id:"saved",number:42,startedAt:now,endedAt:now,state:"budget",model:"fixture",turns:2,costUSD:5,costsByDay:{},summary:"Cap",budgetUSD:5});
  h.store.db.query("INSERT INTO usage_days VALUES(?,?,?) ON CONFLICT(run,day) DO UPDATE SET cost=excluded.cost").run("saved",new Intl.DateTimeFormat("sv-SE").format(new Date()),spent);
  if(spent===19.5) await expect(h.controller.action(42,"topup",{head:"a",runId:"saved",amount:1})).rejects.toThrow("daily cap");
  else {await h.controller.action(42,"topup",{head:"a",runId:"saved",amount:1});expect(h.store.get(42)?.job).toMatchObject({budgetUSD:6,budgetOverride:true});expect(h.store.get(42)?.resumeRequested).toBeTruthy();expect(h.resumes()).toBe(0);await h.controller.reconcile(snapshot());expect(h.resumes()).toBe(1);}
  expect(h.config.runCapUSD).toBe(5);expect(h.config.dailyCapUSD).toBe(20);
});

test("pausing requires an explicit resume before a new run",async()=>{
  const h=harness();const record=h.store.get(42)!;record.paused=true;h.store.put(record);
  await expect(h.controller.action(42,"retry",{head:"a"})).rejects.toThrow("Resume");
  expect(h.store.get(42)?.paused).toBe(true);
});

test.each(["header", "exit"])("GitHub conditional reads reuse a validated ETag response on 304 via %s",async kind=>{
  const calls:string[][]=[];
  const github=new GitHub({} as Config,async argv=>{calls.push(argv);if(calls.length===2&&kind==="exit")throw new Error("gh exited 1: gh: HTTP 304");return calls.length===1?'HTTP/2 200 OK\r\netag: "fixture"\r\n\r\n{"value":42}':'HTTP/2 304 Not Modified\r\n\r\n';});
  expect(await github.conditionalJSON("fixture")).toEqual({value:42});expect(await github.conditionalJSON("fixture")).toEqual({value:42});expect(calls[1]).toContain('If-None-Match: "fixture"');
});
