// Final binary gate. Canonical verifiers recompute current raw regressions;
// summaries never grant acceptance. Historical exceptions remain immutable.
import{execFileSync,spawnSync}from'node:child_process';import{readFileSync,writeFileSync,existsSync,mkdirSync,renameSync}from'node:fs';import{homedir}from'node:os';import{join}from'node:path';import{sha,corpusVerdict,nativeVerdict,fixturesVerdict,incidentVerdict,reviewVerdict}from'./evidence-checks.mjs';
import{inputHash,collectionVerdict,inputKey,codeDirty}from'./collection.mjs';
import{acceptedResourceHashes,resourceBaseline,resourceReuseVerdict,sameResourceCompose,onlyProofChanges,runtimeDeltaPaths,runtimeDeltaArgs,cloudWindowVerdict,priorCloudProbe,liveCloudVerdict}from'./resource-reuse.mjs';
const hash=p=>sha(readFileSync(p)),json=p=>existsSync(p)?JSON.parse(readFileSync(p)):null,text=p=>existsSync(p)?readFileSync(p,'utf8'):'';
const git=(...a)=>execFileSync('git',a,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(),head=git('rev-parse','HEAD');
const equivalentSources=new Map();
const sameCode=s=>{if(equivalentSources.has(s))return equivalentSources.get(s);if(!/^[0-9a-f]{40}$/.test(s??''))return false;try{const paths=git('diff','--name-only','--no-renames',s,head,'--','services','deploy','scripts','tests','patches').split('\n').filter(Boolean);const ok=paths.length===0||onlyProofChanges(paths);equivalentSources.set(s,ok);return ok;}catch{return false;}};
writeFileSync('evidence/M9/acceptance.json',JSON.stringify({schema:'fcpi.m9-acceptance/v2',utc:new Date().toISOString(),source_commit:head,state:'IN_PROGRESS',exit_code:1,verification_pending:true})+'\n');
const historical={AC01:[[3,'A03'],[3,'N02']],AC02:[[3,'N01'],[3,'N03'],[3,'P02']],AC03:[[2,'R01'],[2,'R02'],[2,'R03']],AC04:[[3,'A01'],[3,'J04'],[3,'J07']],AC05:[[5,'M01']],AC06:[[5,'S05']],AC07:[[5,'E01']],AC08:[[5,'D01']],AC09:[[6,'R01']],AC10:[[7,'E01']],AC11:[[7,'B01']],AC12:[[4,'P01'],[4,'P02'],[4,'P03'],[4,'P08'],[4,'P09'],[4,'P10']],AC13:[[4,'P06'],[4,'P07']],AC14:[[3,'X02'],[3,'J03'],[3,'J06']],AC15:[[8,'R01']],AC16:[[8,'S01']],AC17:[[8,'O01']],AC18:[[8,'K03']],AC19:[[8,'U01'],[8,'U02']],AC20:[[7,'W01']],AC21:[[7,'C01']],AC23:[[5,'I01'],[6,'R06'],[7,'E03']],AC24:[[8,'X01']],AC25:[[7,'E04']]};
const fresh=structuredClone(historical);fresh.AC07.push([5,'E05']);fresh.AC08.push([5,'D03']);fresh.AC09.push([6,'L01']);fresh.AC10.push([7,'E05']);
// Each acceptance row needs all its current contract evidence, including the
// scope/budget/cleanup cases beside its successful acquisition example.
for(const [id,refs] of Object.entries({
 AC03:[[2,'R04']],AC04:[[3,'A02']],AC06:[[5,'S01'],[5,'S02'],[5,'S03']],
 AC07:[[5,'E02'],[5,'E03'],[5,'E04'],[5,'B02']],AC08:[[5,'D02']],
 AC09:[[6,'R02'],[6,'R03'],[6,'R04'],[6,'R05'],[6,'R06'],[6,'R09']],
 AC11:[[7,'B02'],[7,'B03'],[7,'B04']],AC12:[[4,'P04'],[4,'P05']],
 AC21:[[7,'C02'],[7,'C03']],
 AC15:[[8,'R02'],[8,'R03'],[8,'I01'],[8,'I02'],[8,'I03'],[8,'I04'],[8,'I07'],[8,'I15']],
 AC16:[[8,'S02'],[8,'S04'],[8,'S05']],
 AC17:[[8,'O02'],[8,'O03'],[8,'O04'],[8,'N01'],[8,'N02']],
 AC18:[[8,'K01'],[8,'K02']],
 AC23:[[6,'R07'],[8,'I08'],[8,'I09'],[8,'I10'],[8,'I11']],
 AC25:[[2,'S01'],[2,'S02'],[2,'S03'],[5,'E03'],[5,'B02'],[6,'R09'],[7,'E02'],[8,'X02']]
}))fresh[id].push(...refs);
// Recompute every selected legacy check into M9-owned paths, even when it fails
// or lacks raw inputs. Their nonzero all-milestone exit is expected for subsets.
for(const m of [2,3,4,5,6,7,8]){
 const base=`evidence/M9/regression/M${m}/`;
 if(!existsSync(base))continue;
 const ids=[...new Set(Object.values(fresh).flat().filter(x=>x[0]===m).map(x=>x[1]))];
 const previous=base+'verification.json';if(existsSync(previous)){mkdirSync(base+'verification-history',{recursive:true});renameSync(previous,base+'verification-history/'+Date.now()+'.json');}
 const r=spawnSync(process.execPath,[`scripts/m${m}/verify.mjs`,...ids],{encoding:'utf8',env:{...process.env,[`FCPI_M${m}_EVIDENCE`]:base},maxBuffer:8*1024*1024});
 if(r.error)throw r.error;
}
const normalBinding=input=>{const key=inputKey(input),base='evidence/M9/regression/M8/',r=(json(base+'collection.json')?.receipts??[]).filter(x=>x.path===key);try{const rec=r.length===1?r[0]:null,p=rec&&/^[A-Za-z0-9_.-]+$/.test(rec.private_record??'')?join(homedir(),'.local/share/firecrawl-pi/m9/collections',rec.private_record):'';return collectionVerdict(key,rec,inputHash(key),/\.json$/.test(key)?'':text(key),sameCode,p&&existsSync(p)?readFileSync(p):null).bound;}catch{return false;}};
let resourceReuse;
function reusedResources(){
 if(resourceReuse)return resourceReuse;
 const assessment=json('evidence/M9/work/AC16-applicability.json'),base='evidence/M9/regression/M8/raw/';
 const input=['targeted-resources.txt','targeted-workload.txt','targeted-redis.txt','targeted-redis-memory.txt'].map(x=>base+x);
 const pr=json('evidence/M9/incident-proof.json'),pid=pr?.incident_id,root=text('evidence/M9/work/root-fixtures.txt'),rootSource=root.match(/RESULT pass=\d+ fail=0 source=([0-9a-f]{40})/)?.[1];
 let incidentOk=false;if(/^[0-9a-f]{8}$/.test(pid??'')){const d=join(homedir(),'.local/share/firecrawl-pi/m9/incident');incidentOk=sameCode(pr.source_commit)&&sameCode(rootSource)&&incidentVerdict(text(join(d,pid+'.json')),pr,text(join(d,pid+'.transcript.jsonl')));}
 let runtimeDeltaHash=null,composeEquivalent=false,actualRuntimePaths=[];
 try{runtimeDeltaHash=sha(execFileSync('git',[...runtimeDeltaArgs,head,'--',...runtimeDeltaPaths],{maxBuffer:8*1024*1024}));actualRuntimePaths=git('diff','--name-only','--no-renames',runtimeDeltaArgs.at(-1),head,'--',...runtimeDeltaPaths).split('\n').filter(Boolean);composeEquivalent=sameResourceCompose(JSON.parse(execFileSync('git',['show',resourceBaseline+':evidence/M8/rendered-compose.json'],{encoding:'utf8',maxBuffer:8*1024*1024})),json('evidence/M9/regression/M8/rendered-compose.json'));}catch{}
 resourceReuse=resourceReuseVerdict({historical:Object.fromEntries(Object.keys(acceptedResourceHashes).map(p=>[p,existsSync(p)?readFileSync(p):null])),assessment,runtimeDeltaHash,composeEquivalent,actualRuntimePaths,serviceNames:Object.keys(json('evidence/M9/regression/M8/rendered-compose.json')?.services??{}),resources:text(input[0]),workload:text(input[1]),redis:text(input[2]),redisMemory:text(input[3]),incidentId:pid,incidentOk,sourceEquivalent:sameCode,inputsBound:input.every(normalBinding)&&normalBinding('evidence/M9/regression/M8/rendered-compose.json')});
 resourceReuse.assessment_sha256=existsSync('evidence/M9/work/AC16-applicability.json')?hash('evidence/M9/work/AC16-applicability.json'):null;resourceReuse.inputs=input.filter(existsSync).map(path=>({path,sha256:hash(path)}));resourceReuse.source_commit=head;resourceReuse.historical_execution_source='6366dd8b5b080c3059203412cabd6b8ad7d7832b';resourceReuse.accepted_repository_baseline=resourceBaseline;
 writeFileSync('evidence/M9/resource-reuse.json',JSON.stringify(resourceReuse,null,2)+'\n');return resourceReuse;
}
const reusedBinding=(input,id)=>{if(!['S01','S02','S04','O04'].includes(id))return null;const name=input.split('/').at(-1),prior='evidence/M8/raw/'+name;if(input!=='evidence/M9/regression/M8/raw/'+name||!acceptedResourceHashes[prior]||!existsSync(input)||hash(input)!==acceptedResourceHashes[prior])return null;return {path:input,attributed:existsSync(input)&&hash(input)===acceptedResourceHashes[prior],bound:existsSync(input)&&hash(input)===acceptedResourceHashes[prior]&&reusedResources().state==='PASS',evidence_mode:'ACCEPTED_M8_REUSE',historical_input:prior,execution_source:'6366dd8b5b080c3059203412cabd6b8ad7d7832b',note:'Immutable historical bytes, never retagged as current execution.'};};

let cloudWindow;
function currentCloudWindow(){if(cloudWindow)return cloudWindow;const base='evidence/M9/regression/M8/raw/',paths=['core-logs-final.txt','guard-window-open.txt','egress-probe.txt'].map(p=>base+p),v=json('evidence/M9/regression/M2/verification.json')?.results.find(r=>r.test_id==='M2-S03');cloudWindow=cloudWindowVerdict({logs:text(paths[0]),open:text(paths[1]),close:text(paths[2]),failedProbe:text(priorCloudProbe),legacyRecord:json('evidence/M9/regression/M8/verification.json')?.results.find(r=>r.test_id==='M8-X01'),currentSecurity:v?.state==='PASS'&&v.code_dirty===false&&sameCode(v.repository_sha??v.source_commit),inputsBound:paths.every(normalBinding)});cloudWindow.inputs=[...paths,priorCloudProbe].filter(existsSync).map(path=>({path,sha256:hash(path)}));cloudWindow.source_commit=head;writeFileSync('evidence/M9/cloud-window.json',JSON.stringify(cloudWindow,null,2)+'\n');return cloudWindow;}
const get=(m,id,old=false)=>{const path=`evidence/${old?'': 'M9/regression/'}M${m}/verification.json`,rec=json(path)?.results?.find(x=>x.test_id===`M${m}-${id}`),base=`evidence/M9/regression/M${m}/`;
 const receipts=old?[]:(json(base+'collection.json')?.receipts??[]),inputPaths=old?[]:(rec?.input_paths??[]).filter(p=>p.startsWith(base));
 const externalEvidence=old?[]:(rec?.input_paths??[]).filter(p=>p.startsWith('evidence/')&&!p.startsWith(base));
 const bindings=inputPaths.map(input=>{const reused=m===8?reusedBinding(input,id):null;if(reused)return reused;const key=inputKey(input),matches=receipts.filter(x=>x.path===key);try{const r=matches.length===1?matches[0]:null,privatePath=r&&/^[A-Za-z0-9_.-]+$/.test(r.private_record??'')?join(homedir(),'.local/share/firecrawl-pi/m9/collections',r.private_record):'',privateBytes=privatePath&&existsSync(privatePath)?readFileSync(privatePath):null,isText=!input.endsWith('/')&&!/\.json$/.test(input);return {path:input,...collectionVerdict(key,r,inputHash(key),isText?text(input):'',sameCode,privateBytes)};}catch{return {path:input,attributed:false,bound:false};}});
 return {path,sha256:existsSync(path)?hash(path):null,test_id:`M${m}-${id}`,state:!old&&m===8&&id==='X01'&&rec?.state==='FAIL'?currentCloudWindow().state:rec?.state??'NOT_RUN',legacy_state:!old&&m===8&&id==='X01'?rec?.state:null,interpretation:!old&&m===8&&id==='X01'?currentCloudWindow():null,verifier_commit:rec?.repository_sha??rec?.source_commit??null,code_dirty:rec?.code_dirty??true,config_or_fixture_hash:rec?.config_or_fixture_hash??null,bindings,tested_bound:old?null:externalEvidence.length===0&&inputPaths.length>0&&bindings.every(x=>x.bound),external_evidence_inputs:externalEvidence};};
const results=[];
for(const[id,refs]of Object.entries(fresh)){
 const prior=historical[id].map(([m,t])=>get(m,t,true)),current=refs.map(([m,t])=>get(m,t));
 const bound=current.every(x=>sameCode(x.verifier_commit)&&x.code_dirty===false&&x.config_or_fixture_hash&&x.tested_bound);
 const state=prior.some(x=>x.state!=='PASS')?'FAIL':current.some(x=>x.state==='FAIL')?'FAIL':current.some(x=>x.state==='BLOCKED_CREDENTIAL')?'BLOCKED_CREDENTIAL':bound&&current.every(x=>x.state==='PASS')?'PASS':'NOT_RUN';
 results.push({test_id:id,state,historical:prior,current,bound});
}
results.push({test_id:'AC22',state:'PASS',capability_state:'NOT_REQUIRED',selected_profile:'NOT_ENABLED',note:'Conditional gate: no hosted profile is enabled; no hosted parity claimed.'});
results.push({test_id:'M9-RESOURCE-REUSE',...reusedResources()});
results.push({test_id:'M9-CLOUD-WINDOW',...currentCloudWindow()});
const liveCloudPath='evidence/M9/regression/M8/raw/live-provider-cloud-audit.txt';results.push({test_id:'M9-LIVE-CLOUD',...liveCloudVerdict(text(liveCloudPath),json('evidence/M9/work/live-window.json'),normalBinding(liveCloudPath))});
const evaluatorTests=json('evidence/M9/work/resource-verifier-tests.json'),evaluatorRaw=text('evidence/M9/work/resource-verifier-tests.txt');
const evaluatorOk=evaluatorTests?.exit_code===0&&evaluatorTests.source_commit===head&&evaluatorTests.raw_sha256===sha(evaluatorRaw)&&evaluatorTests.test_sha256===hash('tests/contracts/m9-resource-reuse.test.mjs')&&evaluatorTests.helper_sha256===hash('scripts/m9/resource-reuse.mjs')&&/^# fail 0$/m.test(evaluatorRaw)&&!/^not ok /m.test(evaluatorRaw)&&Number(evaluatorRaw.match(/^# pass (\d+)$/m)?.[1])>=17&&/ok \d+ - the immutable old failed Cloud probe/.test(evaluatorRaw);
results.push({test_id:'M9-RESOURCE-EVALUATOR-TESTS',state:evaluatorOk?'PASS':'NOT_RUN'});
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
 const raw=text(join(privateRoot,'incident',proof.incident_id+'.json'));
 const transcript=text(join(privateRoot,'incident',proof.incident_id+'.transcript.jsonl'));
 incidentOk=rootOk&&sameCode(proof.source_commit)&&incidentVerdict(raw,proof,transcript);
}
results.push({test_id:'M9-INCIDENT',state:incidentOk?'PASS':proof?'FAIL':'NOT_RUN',root_fixtures:rootOk});
const review=text('evidence/M9/review/REVIEW.md'),reviewResult=reviewVerdict(review);
results.push({test_id:'M9-REVIEW',state:reviewResult.complete?'PASS':review?'FAIL':'NOT_RUN',finding_count:reviewResult.rows.length});
const returned=reviewResult.returned;
results.push({test_id:'M9-RETURNED-FINDINGS',state:returned.length?'FAIL':'PASS',owning_milestone_remediation_required:returned});
const current=json('evidence/M9/current/versions.json');results.push({test_id:'M9-CURRENT',state:current?.source_commit===head&&Object.values(current.checks??{}).length>=14&&Object.values(current.checks).every(x=>x===true)?'PASS':current?'FAIL':'NOT_RUN'});
const run=json('evidence/M9/work/fixture-run.json'),fixtureRaw=text('evidence/M9/work/pi-fixtures-final.txt');results.push({test_id:'M9-FIXTURES',state:run&&sameCode(run.source_commit)&&fixturesVerdict(fixtureRaw,run)&&rootOk?'PASS':'NOT_RUN'});
// Re-run the scanner, including its live hash controls, rather than trust a summary.
spawnSync(process.execPath,['scripts/m9/redaction.mjs'],{encoding:'utf8',maxBuffer:8*1024*1024});
const redaction=json('evidence/M9/redaction.json');results.push({test_id:'M9-REDACTION',state:redaction&&redaction.source_commit===head&&redaction.inputs?.length>1000&&redaction.inputs.every(x=>existsSync(x.path)&&hash(x.path)===x.sha256)&&redaction.positive_controls>=4&&redaction.live_secret_hashes>=30&&redaction.real_secret_hits?.length===0&&redaction.unclassified_hits?.length===0?'PASS':'NOT_RUN'});
const dirty=codeDirty(execFileSync('git',['status','--porcelain=v1','-z','--untracked-files=all'],{encoding:'utf8'}));
const files=['evidence/M9/work/live-window.json','evidence/M9/regression/M8/raw/live-provider-cloud-audit.txt','evidence/M9/cloud-window.json','evidence/M9/work/resource-verifier-tests.txt','evidence/M9/work/AC16-applicability.json','evidence/M9/resource-reuse.json','evidence/M9/regression/M8/raw/targeted-resources.txt','evidence/M9/regression/M8/raw/targeted-workload.txt','evidence/M9/regression/M8/raw/targeted-redis.txt','evidence/M9/regression/M8/raw/targeted-redis-memory.txt','evidence/M9/work/resource-verifier-tests.json','docs/FIRECRAWL_PI_SPEC.md','docs/FIRECRAWL_PI_MILESTONES.md','deploy/versions.lock.json','patches/series.json','deploy/policies/budget.json','deploy/policies/egress.json','deploy/policies/capabilities.json','evidence/M9/work/corpus-freeze.json','evidence/M9/review/REVIEW.md','evidence/M9/work/root-fixtures.txt','evidence/M9/work/fixture-run.json','evidence/M9/work/pi-fixtures-final.txt','evidence/M9/current/versions.json'];
const accepted=results.every(x=>x.state==='PASS')&&!dirty;const out={schema:'fcpi.m9-acceptance/v2',utc:new Date().toISOString(),source_commit:head,patch_sha256:hash('patches/series.json'),state:accepted?'ACCEPTED':'IN_PROGRESS',exit_code:accepted?0:1,code_dirty:dirty,results,inputs:files.filter(existsSync).map(path=>({path,sha256:hash(path)})),limitations:['M8 B00/X04 historical FAIL interpretations preserved','Legacy supplemental M5 X01/X02/X03 FAIL and equivalent PASS evidence preserved','Provider estimates are not invoices','Synthetic routing is not real anti-bot success','Hosted access NOT_ENABLED; single host, power, storage and network fault domain']};writeFileSync('evidence/M9/acceptance.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({state:out.state,states:Object.fromEntries(results.map(x=>[x.test_id,x.state]))}));process.exitCode=out.exit_code;
