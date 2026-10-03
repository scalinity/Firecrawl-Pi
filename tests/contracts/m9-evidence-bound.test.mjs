import test from 'node:test';import assert from 'node:assert/strict';import {sha,corpusVerdict,fixturesVerdict,nativeVerdict}from'../../scripts/m9/evidence-checks.mjs';
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
