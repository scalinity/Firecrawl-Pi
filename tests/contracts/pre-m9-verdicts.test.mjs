import { test } from "node:test";
import assert from "node:assert/strict";
import { closureVerdicts } from "../../scripts/pre-m9/verdicts.mjs";
const end={meta:[{}],end:[{exit:0}]};
const m5={...end,live_model:[{case:"missing_is_null",status:200,json:{product:"Fixture Widget",manufacturer:null},fcpi:{extraction:{model:"gpt-6-luna",sources:{"$":["fixture"]}}}}],
  live_parser:[{case:"scan_cached",status:200,head:"FCPI SCAN 42",rows_before:2,rows_after:2}],provider_log:[{events:[...Array.from({length:4},()=>({event:"model_call",outcome:"answered",model:"gpt-6-luna",resolved_model:"gpt-6-luna-2026-10-02"})),{event:"parse",parser:"llamaparse-cost-effective",cached:true}]}]};
const m6={...end,live_browser:[{case:"assigned_subresource_route",status:200,pagePresent:true,imageLoaded:true,proxyUsed:"stealth",acquisitions:[{strategies:["residential_browser"],proxy_bytes:100}],renders:[{ok:true,requests:2,blocked:0,over_limit:0}],ledger:[{provider:"decodo",state:"SETTLED",usage:{bytes:100,tunnels:1}}]}]};
const m7={...end,live_cache:[{case:"enhanced_cached",status:200,cache:"hit",rows_before:1,rows_after:1}],live_auto:[{case:"synthetic_challenge_real_zyte",success:false,code:"SCRAPE_FCPI_RETRIEVAL",class:"BLOCKED_PUBLIC_CONTENT",ledger:[{provider:"zyte",logical_id:"a",state:"SETTLED",actual:1,usage:{mode:"http",requests:1}}],acquisitions:[{logical_id:"a",failure:"BLOCKED_PUBLIC_CONTENT",strategies:["direct_http","enhanced"],enhanced_mode:"http",attempts_used:2}]}]};
test("positive closure controls pass, absent records never pass",()=>{
  assert.ok(Object.values(closureVerdicts(m5,m6,m7)).every(x=>x.state==="PASS"));
  assert.ok(Object.values(closureVerdicts({}, {}, {})).every(x=>x.state==="FAIL"));
});
test("wrong/null invention, cache charges, home browser routing and duplicate Zyte fail their own proofs",()=>{
  const a=structuredClone(m5), b=structuredClone(m6), c=structuredClone(m7);
  a.live_model[0].json.manufacturer="invented";a.live_parser[0].rows_after=3;
  b.live_browser[0].imageLoaded=false;
  c.live_cache[0].rows_after=2;c.live_auto[0].ledger.push({...c.live_auto[0].ledger[0]});
  assert.ok(Object.values(closureVerdicts(a,b,c)).every(x=>x.state==="FAIL"));
});
test("an unrelated decoded failure cannot establish challenge rejection",()=>{
  const c=structuredClone(m7);c.live_auto[0].class="TARGET_UNREACHABLE";
  assert.equal(closureVerdicts(m5,m6,c).automatic_enhanced.state,"FAIL");
});

test("missing image request, missing tunnel, duplicate enhanced strategy and missing accounting fail",()=>{
  for(const mutate of [b=>b.renders[0].requests=1,b=>b.ledger[0].usage.tunnels=0]) {const b=structuredClone(m6); mutate(b.live_browser[0]);assert.equal(closureVerdicts(m5,b,m7).residential_browser.state,"FAIL");}
  for(const mutate of [a=>a.acquisitions[0].strategies.push("enhanced"),a=>a.acquisitions[0].enhanced_mode="browser",a=>delete a.ledger[0].usage]) {const c=structuredClone(m7); mutate(c.live_auto[0]);assert.equal(closureVerdicts(m5,m6,c).automatic_enhanced.state,"FAIL");}
});
