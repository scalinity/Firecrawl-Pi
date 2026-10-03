// Bound final acceptance primitives. These recompute outcomes from private raw
// responses and public hashes; a convenient summary state cannot grant a PASS.
import{createHash}from'node:crypto';import{clientProof}from'./client-proof.mjs';
export const sha=x=>createHash('sha256').update(x).digest('hex');
export function corpusVerdict(specText,freeze,raw,record){
 const spec=JSON.parse(specText),targets=spec.targets;
 if(sha(specText)!==freeze.sha256||record?.corpus_sha256!==freeze.sha256||targets.length!==20||raw?.results?.length!==20||record?.results?.length!==20)return false;
 if(new Set(targets.map(x=>new URL(x.url).hostname)).size<5)return false;
 let usable=0;
 for(let i=0;i<targets.length;i++){
  const target=targets[i],r=raw.results[i],pub=record.results[i];
  const text=r.json?.data?.markdown??'';
  const criteria=(Array.isArray(target.required_text)?target.required_text:[target.required_text]);
  const ok=r.status===200&&r.json.success===true&&criteria.every(x=>new RegExp(x,'i').test(text))&&Number.isInteger(r.acquisition?.attempts_used)&&r.acquisition.attempts_used<=target.max_attempts;
  if(pub.id!==target.id||pub.page_class!==target.page_class||pub.domain!==new URL(target.url).hostname||pub.status!==r.status||pub.content_sha256!==sha(text)||pub.usable!==ok)return false;
  if(ok)usable++;
 }
 return usable/targets.length>=.9&&record.usable===usable&&record.denominator===20&&record.completed===20;
}
export function nativeVerdict(client,raw,record){
 if(!record||sha(raw)!==record.raw_sha256||record.exit_code!==0)return false;
 const events=raw.split('\n').flatMap(x=>{try{return[JSON.parse(x)];}catch{return[];}});
 const p=clientProof(client,events);
 return p.usable&&record.arrival?.length===1&&record.arrival[0].client==='m9'+client&&record.arrival[0].tool==='firecrawl_scrape'&&record.arrival[0].is_error===false&&record.arrival[0].downstream?.status===200;
}
export function fixturesVerdict(raw,run){
 const ns=[...raw.matchAll(/^# tests (\d+)$/gm)].map(x=>+x[1]);
 const passes=[...raw.matchAll(/^# pass (\d+)$/gm)].map(x=>+x[1]);
 const failures=[...raw.matchAll(/^# fail (\d+)$/gm)].map(x=>+x[1]);
 return run?.exit_code===0&&sha(raw)===run.raw_sha256&&ns.length>=3&&ns.reduce((a,b)=>a+b,0)>=270&&ns.length===passes.length&&ns.every((n,i)=>n===passes[i])&&failures.length===ns.length&&failures.every(x=>x===0)&&!/^not ok /m.test(raw);
}
