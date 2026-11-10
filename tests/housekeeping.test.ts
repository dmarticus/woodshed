import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command } from "../src/command";
import { cleanArtifacts } from "../src/housekeeping";
import { Store } from "../src/store";
import type { Snapshot } from "../src/model";
import { decisionsFixture } from "./fixtures/merged-decisions";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
test.each(["clean","dirty","blocked","active"])("cleanup preserves %s work correctly and retains spend history",async state=>{
 const root=mkdtempSync(join(tmpdir(),"woodshed-housekeeping-"));roots.push(root);
 const data=join(root,"data"),repo=join(root,"repo"),directory=join(data,"jobs","fixture"),checkout=join(directory,"checkout");mkdirSync(directory,{recursive:true});
 const git=(...args:string[])=>command(["git",...args],{cwd:repo});
 await command(["git","init","--initial-branch=main",repo]);await git("config","user.name","Fixture");await git("config","user.email","fixture@example.com");await git("config","commit.gpgsign","false");await git("commit","--allow-empty","-m","chore: fixture");await git("worktree","add","--detach",checkout);
 const now=Date.now(),old=new Date(now-35*86400000).toISOString();
 const store=new Store(":memory:");store.put({snapshot:{number:42,state:"MERGED"} as Snapshot,closedAt:old,decision:{kind:"closed",reason:"Merged"},fingerprint:"",paused:false,attempts:0});
 store.saveRun({id:"fixture",number:42,startedAt:old,endedAt:state==="active"?undefined:old,state:state==="active"?"running":"succeeded",model:"fixture",turns:1,costUSD:.5,costsByDay:{[old.slice(0,10)]:.5},summary:"Done"});
 await Bun.write(join(directory,"runtime.json"),JSON.stringify({status:state==="blocked"?"blocked":"done"}));
 if(state==="dirty")await Bun.write(join(checkout,"unpublished.txt"),"Preserve this work\n");
 utimesSync(directory,new Date(old),new Date(old));
 await cleanArtifacts(data,store,now);
 expect(existsSync(checkout)).toBe(state!=="clean");expect(store.run("fixture")?.costUSD).toBe(.5);expect(store.spent(old.slice(0,10))).toBe(.5);
});

test("housekeeping prunes wholly deleted decision scopes even without job artifacts", async () => {
 const root=mkdtempSync(join(tmpdir(),"woodshed-decision-cleanup-"));roots.push(root);
 const f=decisionsFixture();f.store.put(f.record());await f.history.processPending();
 f.remove("a.ts");f.remove("b.ts");f.unavailable(true);
 await cleanArtifacts(root,f.store,Date.now(),undefined,f.history);
 expect((await f.history.query("src")).records).toHaveLength(1);
 f.unavailable(false);
 await cleanArtifacts(root,f.store,Date.now(),undefined,f.history);
 expect((await f.history.query("src")).records).toHaveLength(0);
});
