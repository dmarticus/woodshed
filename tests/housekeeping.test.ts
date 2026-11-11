import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command } from "../src/command";
import { cleanArtifacts, reapOrphanedConnects } from "../src/housekeeping";
import { Store } from "../src/store";
import type { Snapshot } from "../src/model";
import { decisionsFixture } from "./fixtures/merged-decisions";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
test.each(["clean","ignored","blocked","open","dirty","unpublished","working","active","protected"])("cleanup handles %s work correctly and retains spend history",async state=>{
 const root=mkdtempSync(join(tmpdir(),"woodshed-housekeeping-"));roots.push(root);
 const data=join(root,"data"),repo=join(root,"repo"),directory=join(data,"jobs","fixture"),checkout=join(directory,"checkout");mkdirSync(directory,{recursive:true});
 const git=(...args:string[])=>command(["git",...args],{cwd:repo});
 await command(["git","init","--initial-branch=main",repo]);await git("config","user.name","Fixture");await git("config","user.email","fixture@example.com");await git("config","commit.gpgsign","false");await git("commit","--allow-empty","-m","chore: fixture");await git("update-ref","refs/remotes/origin/main","HEAD");await git("worktree","add","--detach",checkout);
 const now=Date.now(),old=new Date(now-35*86400000).toISOString();
 const store=new Store(":memory:");store.put({snapshot:{number:42,state:state==="open"?"OPEN":"MERGED"} as Snapshot,closedAt:state==="open"?undefined:old,job:state==="protected"?{name:"fixture"} as any:undefined,decision:{kind:"closed",reason:"Merged"},fingerprint:"",paused:false,attempts:0});
 store.saveRun({id:"fixture",number:42,startedAt:old,endedAt:state==="active"?undefined:old,state:state==="active"?"running":"succeeded",model:"fixture",turns:1,costUSD:.5,costsByDay:{[old.slice(0,10)]:.5},summary:"Done"});
 await Bun.write(join(directory,"runtime.json"),JSON.stringify({status:state==="blocked"||state==="working"?state:"done"}));
 if(state==="dirty")await Bun.write(join(checkout,"unpublished.txt"),"Preserve this work\n");
 if(state==="ignored"){await Bun.write(join(checkout,".gitignore"),"node_modules/\n");await command(["git","add",".gitignore"],{cwd:checkout});await command(["git","commit","-m","chore: ignore"],{cwd:checkout});await command(["git","update-ref","refs/remotes/origin/main","HEAD"],{cwd:checkout});mkdirSync(join(checkout,"node_modules","pkg"),{recursive:true});await Bun.write(join(checkout,"node_modules","pkg","index.js"),"\n");}
 if(state==="unpublished")await command(["git","commit","--allow-empty","-m","chore: local only"],{cwd:checkout});
 utimesSync(directory,new Date(old),new Date(old));
 await cleanArtifacts(data,store,now);
 expect(existsSync(checkout)).toBe(["dirty","unpublished","working","active","protected"].includes(state));expect(store.run("fixture")?.costUSD).toBe(.5);expect(store.spent(old.slice(0,10))).toBe(.5);
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

test("housekeeping stops hc connect relays whose SSH session ended", () => {
 const proc=mkdtempSync(join(tmpdir(),"woodshed-proc-"));roots.push(proc);
 const processes:[number,number,string,string][]=[[1,0,"systemd","/sbin/init"],[10,1,"sshd","sshd: woodshed@notty"],[11,10,"herdr-core","/home/woodshed/.local/bin/herdr-core\0connect\0"],[12,1,"herdr-core","/home/woodshed/.local/bin/herdr-core\0connect\0"],[13,1,"herdr-core","/home/woodshed/.local/bin/herdr-core\0serve\0"],[14,1,"hc","/home/woodshed/.local/bin/hc\0connect\0"]];
 for(const [pid,ppid,comm,cmdline] of processes){mkdirSync(join(proc,String(pid)));writeFileSync(join(proc,String(pid),"comm"),comm+"\n");writeFileSync(join(proc,String(pid),"cmdline"),cmdline);writeFileSync(join(proc,String(pid),"stat"),`${pid} (${comm}) S ${ppid} 0 0`);}
 const killed:number[]=[];
 expect(reapOrphanedConnects(proc,process.getuid?.(),pid=>{killed.push(pid);})).toBe(2);
 expect(killed.sort()).toEqual([12,14]);
 expect(reapOrphanedConnects(proc,-1,pid=>{killed.push(pid);})).toBe(0);
});
