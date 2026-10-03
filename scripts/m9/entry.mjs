#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const target = Object.fromEntries(readFileSync('scripts/m1/pi-target.conf','utf8').split('\n').filter(l=>/^PI_\w+=/.test(l)).map(l=>[l.split('=')[0],l.slice(l.indexOf('=')+1).replace('$HOME',process.env.HOME)]));
const pi = command => execFileSync('ssh',['-i',target.PI_SSH_KEY,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=15',target.PI_SSH_TARGET,command],{encoding:'utf8',maxBuffer:8*1024*1024});
const git = (...args) => execFileSync('git',args,{encoding:'utf8'}).trim();
const status = JSON.parse(pi('sudo -n /opt/firecrawl-pi/scripts/fcpi status --json'));
const paid = JSON.parse(pi("sudo -n docker inspect fcpi-retrieval-service-1 | jq '.[0].Config.Env | map(select(startswith(\"PI_PAID_DISPATCH_ENABLED=\") or startswith(\"PI_CLOUD_ACCESS_ENABLED=\")))'"));
const caps = JSON.parse(pi("jq '{paidTotal:.paidTotal,categories:.categories}' /opt/firecrawl-pi/deploy/policies/budget.json"));
const checks={source:status.commit===git('rev-parse','HEAD'),healthy:status.healthy===true,foreign:status.foreign_containers.length===0,
  states:Array.from({length:9},(_,m)=>new RegExp(`\\| M${m} \\| ACCEPTED \\|`).test(readFileSync('docs/FIRECRAWL_PI_MILESTONES.md','utf8'))).every(Boolean),
  pre_m9:JSON.parse(readFileSync('evidence/M5/pre-m9-closure/entry-gate.json')).exit_code===0,
  zero_caps:Object.values(caps.categories).filter(x=>x.paid).every(x=>Object.values(x.caps).every(n=>n===0)) && Object.values(caps.paidTotal.caps).every(n=>n===0),
  no_paid:paid.includes('PI_PAID_DISPATCH_ENABLED=false'),no_cloud:paid.includes('PI_CLOUD_ACCESS_ENABLED=false'),remote:git('rev-parse','refs/remotes/origin/main')==='5ab47b979c9e243f62f46035714aa83a94d7b090'};
const paths=['docs/FIRECRAWL_PI_SPEC.md','docs/FIRECRAWL_PI_MILESTONES.md','deploy/versions.lock.json','patches/series.json','deploy/policies/budget.json','evidence/M5/pre-m9-closure/entry-gate.json'];
mkdirSync('evidence/M9/work',{recursive:true});
const result={test_id:'M9-ENTRY',utc:new Date().toISOString(),source_commit:git('rev-parse','HEAD'),checks,exit_code:Object.values(checks).every(Boolean)?0:1,host:status.host,caps,inputs:paths.map(path=>({path,sha256:hash(path)})),
 historical_exceptions:['M8 B00/X04 remain interpreted under accepted historical evidence','M5 supplemental X01/X02/X03 remain FAIL with current equivalent PASS','PRE-M9 synthetic route is not real anti-bot success; vendor estimates are not invoices'],
 ownership:{session:'01a0ffc9-2dbf-7892-8248-fe282fcc5cf4',worktree:git('rev-parse','--show-toplevel'),branch:git('branch','--show-current'),scope:'M9 canonical scope; M8 F13; onboarding; bounded incident workflow; no publication',other_firecrawl_chat:'Validate M5–M7 live providers is idle',active_claude_cwds:['PiCar','omarchy-mac-bootstrap'],protected:['all accepted evidence except new evidence/M9','unrelated host services','remote/main and evidence-referenced history'],worktrees:git('worktree','list','--porcelain').split('\n').filter(l=>!l.startsWith('worktree '))}};
writeFileSync('evidence/M9/work/entry-gate.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({checks,exit_code:result.exit_code,healthy:status.healthy}));process.exitCode=result.exit_code;
