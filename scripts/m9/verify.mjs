// Binary M9 release gate. Historical acceptance remains immutable and is cited
// explicitly; fresh mandatory evidence is never inferred from an old PASS.
import{execFileSync}from'node:child_process';import{readFileSync,writeFileSync,existsSync,readdirSync}from'node:fs';import{createHash}from'node:crypto';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');const json=p=>existsSync(p)?JSON.parse(readFileSync(p)):null;const text=p=>existsSync(p)?readFileSync(p,'utf8'):'';
const historic=(m,id)=>({path:`evidence/M${m}/verification.json`,test_id:`M${m}-${id}`});
const matrix={AC01:[historic(3,'A03'),historic(3,'N02')],AC02:[historic(3,'N01'),historic(3,'N03'),historic(3,'P02')],AC03:[historic(2,'R01'),historic(2,'R02'),historic(2,'R03')],AC04:[historic(3,'A01'),historic(3,'J04'),historic(3,'J07')],AC05:[historic(5,'M01')],AC06:[historic(5,'S05')],AC07:[historic(5,'E01')],AC08:[historic(5,'D01')],AC09:[historic(6,'R01')],AC10:[historic(7,'E01')],AC11:[historic(7,'B01')],AC12:[historic(4,'P01'),historic(4,'P02'),historic(4,'P03'),historic(4,'P08'),historic(4,'P09'),historic(4,'P10')],AC13:[historic(4,'P06'),historic(4,'P07')],AC14:[historic(3,'X02'),historic(3,'J03'),historic(3,'J06')],AC15:[historic(8,'R01')],AC16:[historic(8,'S01')],AC17:[historic(8,'O01')],AC18:[historic(8,'K03')],AC19:[historic(8,'U01'),historic(8,'U02')],AC20:[historic(7,'W01')],AC21:[historic(7,'C01')],AC23:[historic(5,'I01'),historic(6,'R06'),historic(7,'E03')],AC24:[historic(8,'X01')],AC25:[historic(7,'E04')]};
const current=json('evidence/M9/current/versions.json'),live=json('evidence/M9/live-gates.json'),corpus=json('evidence/M9/corpus.json'),flow=json('evidence/M9/research-flow.json');
const review=text('evidence/M9/review/REVIEW.md');const fixtures=text('evidence/M9/work/pi-fixtures-final.txt');const results=[];
for(const [id,refs] of Object.entries(matrix)){
 const historical=refs.map(r=>({...r,record:json(r.path)?.results.find(x=>x.test_id===r.test_id)}));
 const historicPass=historical.every(r=>r.record?.state==='PASS');
 const fresh=live?.criteria?.[id];
 results.push({test_id:id,state:!historicPass?'FAIL':fresh?.state??'NOT_RUN',historical:historical.map(({record,...r})=>({...r,state:record?.state??'NOT_RUN',sha256:hash(r.path),source_commit:record?.source_commit??record?.repository_sha??null})),fresh:fresh??null});
}
results.push({test_id:'AC22',state:live?.hosted_enabled?'NOT_RUN':'PASS',capability_state:live?.hosted_enabled?'IMPLEMENTED_UNVERIFIED':'NOT_ENABLED',note:'Optional hosted profiles are disabled; no hosted parity claimed.'});
const corpusPass=corpus?.completed===20&&corpus?.denominator===20&&corpus?.domain_count>=5&&corpus?.usable/corpus.denominator>=.9;
results.push({test_id:'M9-CORPUS',state:corpusPass?'PASS':corpus?'FAIL':'NOT_RUN',denominator:corpus?.denominator??20,usable:corpus?.usable??null,completed:corpus?.completed??0});
const clientPass=['claude','codex'].every(x=>json(`evidence/M9/clients/${x}.json`)?.state==='VERIFIED_LIVE');results.push({test_id:'M9-CLIENTS',state:clientPass?'PASS':'NOT_RUN'});
results.push({test_id:'M9-RESEARCH',state:flow?.steps?.length>=5&&flow.steps.every(x=>x.status>=200&&x.status<300)&&flow.steps.some(x=>x.job_status==='completed')?'PASS':flow?'FAIL':'NOT_RUN'});
results.push({test_id:'M9-INCIDENT',state:json('evidence/M9/incident-proof.json')?.state??'NOT_RUN'});
results.push({test_id:'M9-REVIEW',state:review.includes('Remediation complete')&&!/Disposition: PENDING/.test(review)?'PASS':'NOT_RUN'});
results.push({test_id:'M9-CURRENT',state:current?.exit_code===0?'PASS':current?'FAIL':'NOT_RUN'});
results.push({test_id:'M9-FIXTURES',state:fixtures.includes('# fail 0')&&!/^not ok /m.test(fixtures)&&json('evidence/M9/work/fixture-run.json')?.exit_code===0?'PASS':'NOT_RUN'});
results.push({test_id:'M9-REDACTION',state:json('evidence/M9/redaction.json')?.state??'NOT_RUN'});
const files=new Set(['docs/FIRECRAWL_PI_SPEC.md','docs/FIRECRAWL_PI_MILESTONES.md','deploy/versions.lock.json','patches/series.json','deploy/policies/budget.json','deploy/policies/egress.json','deploy/policies/capabilities.json',...Object.values(matrix).flat().map(x=>x.path)]);
for(const p of ['evidence/M9/current/versions.json','evidence/M9/corpus.json','evidence/M9/review/REVIEW.md','evidence/M9/incident-proof.json','evidence/M9/live-gates.json','evidence/M9/redaction.json'])if(existsSync(p))files.add(p);
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();const codeDirty=git('status','--porcelain','--untracked-files=all').split('\n').filter(Boolean).some(x=>!x.slice(3).startsWith('evidence/'));
const accepted=results.every(x=>x.state==='PASS')&&!codeDirty;
const out={schema:'fcpi.m9-acceptance/v1',utc:new Date().toISOString(),source_commit:git('rev-parse','HEAD'),code_dirty:codeDirty,patch_sha256:hash('patches/series.json'),state:accepted?'ACCEPTED':'IN_PROGRESS',exit_code:accepted?0:1,results,inputs:[...files].map(path=>({path,sha256:hash(path)})),limitations:['M8 B00/X04 historical FAIL interpretations preserved','Legacy supplemental M5 X01/X02/X03 remain FAIL with current equivalent PASS evidence','Decodo/Zyte accounting estimates are not reconciled invoices','Synthetic controlled challenge routing is not real anti-bot success','Optional hosted ingress disabled; single-host/power/storage/network fault domain']};writeFileSync('evidence/M9/acceptance.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({state:out.state,exit_code:out.exit_code,code_dirty:codeDirty,states:Object.fromEntries(results.map(x=>[x.test_id,x.state]))}));process.exitCode=out.exit_code;
