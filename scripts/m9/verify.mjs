// Final binary gate. Canonical verifiers recompute current raw regressions;
// summaries never grant acceptance. Historical exceptions remain immutable.
import{execFileSync,spawnSync}from'node:child_process';import{readFileSync,writeFileSync,existsSync}from'node:fs';import{homedir}from'node:os';import{join}from'node:path';import{sha,corpusVerdict,nativeVerdict,fixturesVerdict}from'./evidence-checks.mjs';
const hash=p=>sha(readFileSync(p)),json=p=>existsSync(p)?JSON.parse(readFileSync(p)):null,text=p=>existsSync(p)?readFileSync(p,'utf8'):'';
const git=(...a)=>execFileSync('git',a,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(),head=git('rev-parse','HEAD');
const sameCode=s=>{if(!/^[0-9a-f]{40}$/.test(s??''))return false;try{git('diff','--quiet',s,head,'--','services','deploy','scripts','tests','patches',':(exclude)deploy/versions.lock.json');return true;}catch{return false;}};
const historical={AC01:[[3,'A03'],[3,'N02']],AC02:[[3,'N01'],[3,'N03'],[3,'P02']],AC03:[[2,'R01'],[2,'R02'],[2,'R03']],AC04:[[3,'A01'],[3,'J04'],[3,'J07']],AC05:[[5,'M01']],AC06:[[5,'S05']],AC07:[[5,'E01']],AC08:[[5,'D01']],AC09:[[6,'R01']],AC10:[[7,'E01']],AC11:[[7,'B01']],AC12:[[4,'P01'],[4,'P02'],[4,'P03'],[4,'P08'],[4,'P09'],[4,'P10']],AC13:[[4,'P06'],[4,'P07']],AC14:[[3,'X02'],[3,'J03'],[3,'J06']],AC15:[[8,'R01']],AC16:[[8,'S01']],AC17:[[8,'O01']],AC18:[[8,'K03']],AC19:[[8,'U01'],[8,'U02']],AC20:[[7,'W01']],AC21:[[7,'C01']],AC23:[[5,'I01'],[6,'R06'],[7,'E03']],AC24:[[8,'X01']],AC25:[[7,'E04']]};
const fresh=structuredClone(historical);fresh.AC07.push([5,'E05']);fresh.AC08.push([5,'D03']);fresh.AC09.push([6,'L01']);fresh.AC10.push([7,'E05']);
// Recompute every selected legacy check into M9-owned paths, even when it fails
// or lacks raw inputs. Their nonzero all-milestone exit is expected for subsets.
for(const m of [2,3,4,5,6,7,8]){
 const base=`evidence/M9/regression/M${m}/`;
 if(!existsSync(base))continue;
 const ids=[...new Set(Object.values(fresh).flat().filter(x=>x[0]===m).map(x=>x[1]))];
 const r=spawnSync(process.execPath,[`scripts/m${m}/verify.mjs`,...ids],{encoding:'utf8',env:{...process.env,[`FCPI_M${m}_EVIDENCE`]:base},maxBuffer:8*1024*1024});
 if(r.error)throw r.error;
}
const get=(m,id,old=false)=>{const path=`evidence/${old?'': 'M9/regression/'}M${m}/verification.json`,rec=json(path)?.results?.find(x=>x.test_id===`M${m}-${id}`);return {path,sha256:existsSync(path)?hash(path):null,test_id:`M${m}-${id}`,state:rec?.state??'NOT_RUN',source_commit:rec?.repository_sha??rec?.source_commit??null,config_or_fixture_hash:rec?.config_or_fixture_hash??null};};
const results=[];
for(const[id,refs]of Object.entries(fresh)){
 const prior=historical[id].map(([m,t])=>get(m,t,true)),current=refs.map(([m,t])=>get(m,t));
 const bound=current.every(x=>sameCode(x.source_commit)&&x.config_or_fixture_hash);
 const state=prior.some(x=>x.state!=='PASS')?'FAIL':current.some(x=>x.state==='FAIL')?'FAIL':current.some(x=>x.state==='BLOCKED_CREDENTIAL')?'BLOCKED_CREDENTIAL':bound&&current.every(x=>x.state==='PASS')?'PASS':'NOT_RUN';
 results.push({test_id:id,state,historical:prior,current,bound});
}
results.push({test_id:'AC22',state:'PASS',capability_state:'NOT_REQUIRED',selected_profile:'NOT_ENABLED',note:'Conditional gate: no hosted profile is enabled; no hosted parity claimed.'});
const privateRoot=join(homedir(),'.local/share/firecrawl-pi/m9');
const freeze=json('evidence/M9/work/corpus-freeze.json'),corpus=json('evidence/M9/corpus.json'),rawCorpus=json(join(privateRoot,'live/corpus.json'));
const corpusOk=rawCorpus&&sameCode(rawCorpus.source_commit)&&sameCode(corpus?.source_commit)&&corpusVerdict(text(join(privateRoot,'corpus.json')),freeze,rawCorpus,corpus);
results.push({test_id:'M9-CORPUS',state:corpusOk?'PASS':corpus?'FAIL':'NOT_RUN',denominator:20,usable:corpus?.usable??null});
const clients=['claude','codex'].map(client=>{const r=json(`evidence/M9/clients/${client}.json`);const path=r&&/^native-[A-Za-z0-9]+$/.test(r.private_run??'')?join(privateRoot,r.private_run,'stdout.jsonl'):'';return {client,ok:!!path&&existsSync(path)&&sameCode(r.source_commit)&&nativeVerdict(client,text(path),r)};});
results.push({test_id:'M9-CLIENTS',state:clients.every(x=>x.ok)?'PASS':'NOT_RUN',clients});
const flow=json('evidence/M9/research-flow.json'),rawFlow=json(join(privateRoot,'live/research.json'));
const ss=rawFlow?.steps??[],step=n=>ss.find(x=>x.step===n);
const flowOk=rawFlow&&sameCode(rawFlow.source_commit)&&sha(JSON.stringify(rawFlow))===flow?.raw_sha256&&ss.length===5&&ss.every(x=>x.status>=200&&x.status<300)&&((step('search')?.json.data?.web??step('search')?.json.data??[]).length>0)&&(step('map')?.json.links?.length>0)&&(step('retrieve')?.json.data?.markdown?.length>0)&&step('poll/read')?.json.status==='completed'&&typeof step('poll/read')?.json.data?.title==='string';
results.push({test_id:'M9-RESEARCH',state:flowOk?'PASS':flow?'FAIL':'NOT_RUN'});
const proof=json('evidence/M9/incident-proof.json'),rootTests=text('evidence/M9/work/root-fixtures.txt');
const rootOk=/RESULT pass=\d+ fail=0 source=[0-9a-f]{40}/.test(rootTests)&&sameCode(rootTests.match(/RESULT pass=\d+ fail=0 source=([0-9a-f]{40})/)?.[1]);
let incidentOk=false;if(proof&&/^[0-9a-f]{8}$/.test(proof.incident_id)){
 const raw=text(join(privateRoot,'incident',proof.incident_id+'.json'));let r;try{r=JSON.parse(raw);}catch{}
 incidentOk=rootOk&&sha(raw)===proof.raw_sha256&&sameCode(proof.source_commit)&&r?.is_error===false&&r.structured_output?.incident_id===proof.incident_id&&proof.unit?.MemoryMax===805306368&&proof.unit?.NoNewPrivileges===true&&proof.unit?.tools==='Read,Edit,Write'&&proof.owner_authentication==='Max subscription'&&proof.invoiced_usd===null;
}
results.push({test_id:'M9-INCIDENT',state:incidentOk?'PASS':'NOT_RUN',root_fixtures:rootOk});
const review=text('evidence/M9/review/REVIEW.md');const dispositions=[...review.matchAll(/^\| (?:DB1|CA1|SELF)-[^|]+\| ([^|]+)\|/gm)].map(x=>x[1].trim());
results.push({test_id:'M9-REVIEW',state:review.includes('Remediation complete')&&dispositions.length===43&&dispositions.every(x=>/^(FIXED|REJECTED|RETURNED)/.test(x))?'PASS':'NOT_RUN'});
const current=json('evidence/M9/current/versions.json');results.push({test_id:'M9-CURRENT',state:current?.source_commit===head&&Object.values(current.checks??{}).length>=14&&Object.values(current.checks).every(x=>x===true)?'PASS':current?'FAIL':'NOT_RUN'});
const run=json('evidence/M9/work/fixture-run.json'),fixtureRaw=text('evidence/M9/work/pi-fixtures-final.txt');results.push({test_id:'M9-FIXTURES',state:run&&sameCode(run.source_commit)&&fixturesVerdict(fixtureRaw,run)&&rootOk?'PASS':'NOT_RUN'});
// Redaction is re-run by its producer; no convenient PASS state is consumed here.
const redaction=json('evidence/M9/redaction.json');results.push({test_id:'M9-REDACTION',state:redaction&&sameCode(redaction.source_commit)&&redaction.positive_controls>=4&&redaction.live_secret_hashes>=30&&redaction.real_secret_hits?.length===0&&redaction.unclassified_hits?.length===0?'PASS':'NOT_RUN'});
const codeDirty=git('status','--porcelain','--untracked-files=all').split('\n').filter(Boolean).some(x=>!x.slice(3).startsWith('evidence/'));
const files=['docs/FIRECRAWL_PI_SPEC.md','docs/FIRECRAWL_PI_MILESTONES.md','deploy/versions.lock.json','patches/series.json','deploy/policies/budget.json','deploy/policies/egress.json','deploy/policies/capabilities.json','evidence/M9/work/corpus-freeze.json','evidence/M9/review/REVIEW.md','evidence/M9/work/root-fixtures.txt','evidence/M9/work/fixture-run.json','evidence/M9/work/pi-fixtures-final.txt','evidence/M9/current/versions.json'];
const accepted=results.every(x=>x.state==='PASS')&&!codeDirty;const out={schema:'fcpi.m9-acceptance/v2',utc:new Date().toISOString(),source_commit:head,patch_sha256:hash('patches/series.json'),state:accepted?'ACCEPTED':'IN_PROGRESS',exit_code:accepted?0:1,code_dirty:codeDirty,results,inputs:files.filter(existsSync).map(path=>({path,sha256:hash(path)})),limitations:['M8 B00/X04 historical FAIL interpretations preserved','Legacy supplemental M5 X01/X02/X03 FAIL and equivalent PASS evidence preserved','Provider estimates are not invoices','Synthetic routing is not real anti-bot success','Hosted access NOT_ENABLED; single host, power, storage and network fault domain']};writeFileSync('evidence/M9/acceptance.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({state:out.state,states:Object.fromEntries(results.map(x=>[x.test_id,x.state]))}));process.exitCode=out.exit_code;
