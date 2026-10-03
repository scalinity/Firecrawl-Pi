// Bound final acceptance primitives. These recompute outcomes from private raw
// responses and public hashes; a convenient summary state cannot grant a PASS.
import{createHash}from'node:crypto';import{clientProof}from'./client-proof.mjs';
export const sha=x=>createHash('sha256').update(x).digest('hex');
export function reviewVerdict(review){
 const rows=review.split('\n').filter(line=>line.includes('|')).map(line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim()))
  .filter(c=>!c.every(x=>/^:?-+:?$/.test(x))&&!( /^(?:Finding|Earlier finding|Additional finding)$/i.test(c[0])&&/^Disposition$/i.test(c[1])))
  .map(c=>({finding:c[0],outcome:c[1]??'',columns:c.length}));
 const expected=['SELF-01','SELF-02'];
 for(const [prefix,counts]of Object.entries({DB1:{C:5,W:6,S:9},CA1:{C:4,W:10,S:7}}))
  for(const [kind,count]of Object.entries(counts))for(let i=1;i<=count;i++)expected.push(`${prefix}-${kind}${i}`);
 const originals=rows.filter(x=>/^(?:DB1|CA1|SELF)-/.test(x.finding));
 const complete=review.includes('Remediation complete')&&originals.length===expected.length&&expected.every(id=>originals.some(x=>x.finding===id))&&
  new Set(rows.map(x=>x.finding)).size===rows.length&&rows.every(x=>x.columns>=3&&/^(?:DB1|CA1|SELF|M8|M9)-[A-Za-z0-9-]+$/.test(x.finding)&&/^(FIXED|REJECTED|RETURNED)$/.test(x.outcome));
 return {complete,rows,returned:[...new Set(rows.filter(x=>/^RETURNED\b/i.test(x.outcome)).map(x=>x.finding))]};
}
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
export function incidentSourceRead(transcript,id){
 if(typeof transcript!=='string'||!/^[0-9a-f]{8}$/.test(id??''))return false;
 let events;try{events=transcript.trim().split('\n').map(x=>JSON.parse(x));}catch{return false;}
 const uses=new Set();
 for(const e of events){
  if(e?.type!=='assistant'||!Array.isArray(e.message?.content))continue;
  for(const c of e.message.content)if(c?.type==='tool_use'&&c.name==='Read'&&typeof c.id==='string'&&c.input?.file_path===`/var/lib/firecrawl-pi/incidents/work/${id}/tree/scripts/ops/tick.sh`)uses.add(c.id);
 }
 return events.some(e=>e?.type==='user'&&Array.isArray(e.message?.content)&&e.message.content.some(c=>c?.type==='tool_result'&&uses.has(c.tool_use_id)&&c.is_error!==true&&typeof c.content==='string'&&/^\s*\d+\t/m.test(c.content)&&c.content.includes('queue_unreadable')));
}
export function incidentVerdict(raw,proof,transcript){
 let r;try{r=JSON.parse(raw);}catch{return false;}
 if(!r||typeof r!=='object'||!/^([0-9a-f]{8})$/.test(proof?.incident_id??''))return false;
 const u=proof?.unit,models=Object.keys(r.modelUsage??{});
 const w='/var/lib/firecrawl-pi/incidents/work/'+proof.incident_id;
 const paths=x=>typeof x==='string'?x.split(/\s+/).filter(Boolean).map(p=>p.replace(/^-/,'')).sort():[];
 const exactPaths=(got,want)=>JSON.stringify(paths(got))===JSON.stringify(want.sort());
 return typeof transcript==='string'&&sha(transcript)===proof.transcript_sha256&&incidentSourceRead(transcript,proof.incident_id)&&
  sha(raw)===proof?.raw_sha256&&r.is_error===false&&r.structured_output?.incident_id===proof.incident_id&&
  models.length>0&&models.every(x=>x==='claude-opus-5-5')&&u?.MemoryMax===805306368&&u.NoNewPrivileges===true&&
  u.declared_tools==='Read,Edit,Write,StructuredOutput'&&u.User==='danny'&&u.Group==='danny'&&u.MemorySwapMax==='0'&&u.RuntimeMaxUSec==='5min 30s'&&
  u.CPUQuotaPerSecUSec==='500ms'&&u.TasksMax==='128'&&u.Slice==='fcpi.slice'&&u.KillMode==='control-group'&&u.TimeoutStopUSec==='15s'&&
  u.ProtectSystem==='strict'&&u.ProtectHome==='read-only'&&u.PrivateTmp==='yes'&&
  exactPaths(u.ReadWritePaths,[w+'/tree',w+'/run'])&&exactPaths(u.InaccessiblePaths,['/etc/firecrawl-pi','/srv/firecrawl-pi/data','/run/docker.sock','/home/danny/.ssh','/home/danny/.codex','/home/danny/.claude','/var/lib/firecrawl-pi/incidents/control'])&&
  exactPaths(u.BindReadOnlyPaths,['/home/danny/.local/bin/claude:/home/danny/.local/bin/claude:rbind'])&&proof.auth_removed===true&&
  proof.owner_authentication==='Max subscription'&&proof.invoiced_usd===null;
}
