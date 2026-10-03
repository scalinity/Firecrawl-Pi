import test from 'node:test';import assert from 'node:assert/strict';import {sha,corpusVerdict,fixturesVerdict,nativeVerdict,incidentVerdict,incidentSourceRead}from'../../scripts/m9/evidence-checks.mjs';
test('missing, edited, failed or summary-only evidence cannot grant acceptance',()=>{
 const raw='# tests 270\n# pass 270\n# fail 0\n';assert.equal(fixturesVerdict(raw,{state:'PASS',exit_code:0}),false);
 assert.equal(fixturesVerdict(raw,{raw_sha256:sha(raw),exit_code:0}),false); // missing suites
 assert.equal(nativeVerdict('codex','', {state:'VERIFIED_LIVE',exit_code:0,raw_sha256:sha('')}),false);
 const spec=JSON.stringify({targets:Array.from({length:20},(_,i)=>({id:String(i),page_class:'static',url:`https://d${i%5}.test/`,required_text:'Exact body',max_attempts:3}))});
 const rs=JSON.parse(spec).targets.map(t=>({id:t.id,page_class:t.page_class,domain:new URL(t.url).hostname,status:200,content_sha256:sha('Exact body'),usable:true}));
 const record={corpus_sha256:sha(spec),denominator:20,completed:20,usable:20,results:rs},body={results:rs.map(x=>({status:200,acquisition:{attempts_used:1},json:{success:true,data:{markdown:'Exact body'}}}))},freeze={sha256:sha(spec)};
 assert.equal(corpusVerdict(spec,freeze,body,record),true);
 body.results[0].acquisition.attempts_used=4;assert.equal(corpusVerdict(spec,freeze,body,record),false);body.results[0].acquisition.attempts_used=1;
 body.results[0].json.data.markdown='challenge';assert.equal(corpusVerdict(spec,freeze,body,record),false);
 assert.equal(corpusVerdict(spec,freeze,{results:[]},record),false);
});
test('incident acceptance requires actual model and every enforced resource bound',()=>{
 const raw=JSON.stringify({is_error:false,structured_output:{incident_id:'123abcde'},modelUsage:{'claude-opus-5-5':{inputTokens:10}}});
 const w='/var/lib/firecrawl-pi/incidents/work/123abcde';
 const transcript=[{type:'assistant',message:{content:[{type:'tool_use',id:'read1',name:'Read',input:{file_path:w+'/tree/scripts/ops/tick.sh'}}]}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:'read1',content:'151\tqueue_unreadable',is_error:false}]}}].map(x=>JSON.stringify(x)).join('\n');
 const verdict=(raw,proof,trace=transcript)=>incidentVerdict(raw,proof,trace);
 const proof={incident_id:'123abcde',raw_sha256:sha(raw),transcript_sha256:sha(transcript),unit:{MemoryMax:805306368,NoNewPrivileges:true,declared_tools:'Read,Edit,Write,StructuredOutput',User:'danny',Group:'danny',MemorySwapMax:'0',RuntimeMaxUSec:'5min 30s',CPUQuotaPerSecUSec:'500ms',TasksMax:'128',Slice:'fcpi.slice',KillMode:'control-group',TimeoutStopUSec:'15s',ProtectSystem:'strict',ProtectHome:'read-only',PrivateTmp:'yes',ReadWritePaths:w+'/tree '+w+'/run',InaccessiblePaths:'/etc/firecrawl-pi /srv/firecrawl-pi/data /run/docker.sock -/home/danny/.ssh -/home/danny/.codex /home/danny/.claude /var/lib/firecrawl-pi/incidents/control',BindReadOnlyPaths:'/home/danny/.local/bin/claude:/home/danny/.local/bin/claude:rbind'},auth_removed:true,owner_authentication:'Max subscription',invoiced_usd:null};
 assert.equal(verdict(raw,proof),true);
 assert.equal(incidentVerdict(raw,proof),false);
 assert.equal(verdict(raw,proof,transcript+' '),false);
 for(const trace of ['',transcript.replaceAll('read1','wrong').replace('"tool_use_id":"wrong"','"tool_use_id":"missing"'),transcript.replace('"is_error":false','"is_error":true'),transcript.replace('123abcde','ffffffff'),transcript.replace('151\\tqueue_unreadable','permission denied'),'null','invalid'])assert.equal(verdict(raw,{...proof,transcript_sha256:sha(trace)},trace),false);
 assert.equal(verdict(raw,{...proof,transcript_sha256:'0'.repeat(64)}),false);
 assert.equal(incidentSourceRead(transcript,'123abcde'),true);
 for(const [key,value]of Object.entries({MemoryMax:0,NoNewPrivileges:false,declared_tools:'Bash',User:'root',Group:'root',MemorySwapMax:'infinity',RuntimeMaxUSec:'infinity',CPUQuotaPerSecUSec:'infinity',TasksMax:'infinity',Slice:'system.slice',KillMode:'process',TimeoutStopUSec:'infinity',ProtectSystem:'no',ProtectHome:'no',PrivateTmp:'no',ReadWritePaths:'/',InaccessiblePaths:'',BindReadOnlyPaths:null}))assert.equal(verdict(raw,{...proof,unit:{...proof.unit,[key]:value}}),false,key);
 for(const key of Object.keys(proof.unit)){const unit={...proof.unit};delete unit[key];assert.equal(verdict(raw,{...proof,unit}),false,'missing '+key);}
 for(const value of [null,'',false,0])assert.equal(verdict(raw,{...proof,unit:{...proof.unit,MemorySwapMax:value}}),false);
 const wrong=raw.replace('claude-opus-5-5','other-model');assert.equal(verdict(wrong,{...proof,raw_sha256:sha(wrong)}),false);
 assert.equal(verdict(raw,{...proof,auth_removed:false}),false);
 for(const bind of ['/home/danny/.local/bin/claude','/home/danny/.local/bin/claude:/tmp/other:rbind'])assert.equal(verdict(raw,{...proof,unit:{...proof.unit,BindReadOnlyPaths:bind}}),false);
 assert.equal(verdict(raw,{...proof,invoiced_usd:0}),false);
 assert.equal(verdict(raw,{...proof,incident_id:'aaaaaaaa'}),false);
 assert.equal(verdict(raw+' ',proof),false);
 for(const value of ['null','[]','42','"text"','invalid'])assert.equal(verdict(value,{...proof,raw_sha256:sha(value)}),false);
 for(const modelUsage of [undefined,{}, {'claude-opus-5-5':{},other:{}}]){const value=JSON.stringify({is_error:false,structured_output:{incident_id:'123abcde'},modelUsage});assert.equal(verdict(value,{...proof,raw_sha256:sha(value)}),false);}
});
