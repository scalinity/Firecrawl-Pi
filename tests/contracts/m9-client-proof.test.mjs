import test from 'node:test';import assert from 'node:assert/strict';import {clientProof} from '../../scripts/m9/client-proof.mjs';
const call={type:'tool_use',id:'a',name:'mcp__fcpi__firecrawl_scrape',input:{url:'http://fixture'}};
const result=x=>[{message:{content:[call]}},{message:{content:[{type:'tool_result',tool_use_id:'a',content:JSON.stringify(x)}]}}];
test('native proof excludes arguments, error output, prose and other servers',()=>{
 for(const x of [{success:false,error:'Static fixture'},{success:true,data:{markdown:'Welcome'}},{text:'Static fixture'}])assert.equal(clientProof('claude',result(x)).usable,false);
 assert.equal(clientProof('claude',result({data:{markdown:'Static fixture\n==============\nExpected body'}})).usable,true);
 assert.equal(clientProof('claude',result({data:{markdown:'Static fixture\nnot a heading'}})).usable,false);
 const ok=result({data:{markdown:'# Static fixture\nExpected body'}});assert.equal(clientProof('claude',ok).usable,true);
 ok[0].message.content[0]={...call,name:'mcp__other__firecrawl_scrape'};assert.equal(clientProof('claude',ok).usable,false);
 const native=[{item:{type:'mcp_tool_call',server:'fcpi',tool:'firecrawl_scrape',status:'completed',result:{content:[{type:'text',text:JSON.stringify({data:{markdown:'Static fixture\n=====\nBody'}})}]}}}];
 assert.equal(clientProof('codex',native).usable,true);
 assert.equal(clientProof('codex',[...native,{item:{type:'command_execution',command:'synthetic forbidden shell'}}]).usable,false);
 assert.equal(clientProof('codex',[{item:{type:'mcp_tool_call',server:'fcpi',tool:'firecrawl_scrape',status:'completed',arguments:{url:'Static fixture'},result:{content:[{type:'text',text:JSON.stringify({success:false,error:'Static fixture'})}]}}}]).usable,false);
});
