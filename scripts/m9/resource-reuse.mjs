// M9 inherits accepted long-duration measurements only with unchanged resource
// assumptions and source-bound targeted tests. Historical bytes keep their source.
import{sha,corpusVerdict}from'./evidence-checks.mjs';
import{liveEvidenceInWindow}from'./live-contract.mjs';
import{collectorSources}from'./collection.mjs';
export const executionSource='6366dd8b5b080c3059203412cabd6b8ad7d7832b';
export const runtimeDeltaPaths=['services','deploy','patches','scripts/ops',':(glob)scripts/m9/incident-*'];
export const runtimeDeltaArgs=['diff','--raw','--no-abbrev','--no-renames','--no-ext-diff','--no-textconv','--no-color',executionSource];
export const resourceBaseline='55d756c5fb12fc5e741ab4145c47a7d7fdee1237';
export const acceptedResourceHashes={
 'evidence/M8/INTERPRETATION.md':'8b380d655c7f7b836bebc7e0c42d0406dc4c7b2b775aedcf210425441ce55a1e',
 'evidence/M8/verification.json':'8986ddf76d253eccfd00ccd26ead66b9d014305cebe9997535e51647d8804642',
 'evidence/M8/raw/soak.txt':'85971bcf6f4095b65a31945f41c80e0c098547c716597571f0237deebbbc2d92',
 'evidence/M8/raw/redis-soak.txt':'d7f41a463ed89f91cfbce12824b30c2c896fcf81cb9f1b1849f64d95078934ae'
};
// These files evaluate evidence; none runs a workload or changes the Pi. Keep
// all other scripts/tests in source-equivalence checks, including collectors.
export const proofOnlyPaths=['scripts/m9/verify.mjs','scripts/m9/resource-reuse.mjs','tests/contracts/m9-resource-reuse.test.mjs'];
// The live corpus driver is not used by earlier milestone fixtures, native
// onboarding, incident investigation or the completed resource workload. Its
// changes never qualify old corpus/research execution as current.
const liveProducerPaths=['scripts/m9/live.mjs','scripts/m9/live-contract.mjs','tests/contracts/m9-live.test.mjs'];
export function onlyProofChanges(paths,independent=false){return paths.length>0&&paths.every(p=>proofOnlyPaths.includes(p)||(independent&&liveProducerPaths.includes(p)));}
export function frames(raw){let key;const out={};for(const line of raw.split('\n')){const m=/^### (\S+)$/.exec(line);if(m){key=m[1];if(['meta','samples','end'].includes(key)&&out[key])throw Error('Duplicate resource frame');out[key]??=[];}else if(key&&line.startsWith('{')){try{out[key].push(JSON.parse(line));}catch{throw Error('Malformed resource record');}}else if(key==='samples'&&line.trim())throw Error('Non-JSON sample');}return out;}
const MIB=1048576,percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
const canonical=o=>JSON.stringify(o,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export function sameResourceCompose(before,after){
 const a=structuredClone(before),b=structuredClone(after);
 for(const s of ['access-gateway','retrieval-service','browser-worker']){if(!a.services?.[s]||!b.services?.[s])return false;delete a.services[s].image;delete b.services[s].image;}
 const env={PI_INCIDENT_GRANTS_DIR:'/srv/incidents/grants',PI_INCIDENT_REQUESTS_DIR:'/srv/incidents/requests',PI_INCIDENT_KEY_FILE:'/srv/incidents/public-key.pem',PI_INCIDENT_REPORTS_DIR:'/srv/incidents/reports',PI_INCIDENT_OWNER_FILE:'/srv/incidents/owner.sha256'};
 for(const[k,v]of Object.entries(env)){if(b.services['access-gateway'].environment[k]!==v)return false;delete b.services['access-gateway'].environment[k];const matches=b.services['access-gateway'].volumes.filter(m=>m.target===v),m=matches[0];if(matches.length!==1||m.type!=='bind'||m.source!=='/var/lib/firecrawl-pi/incidents/control/'+v.slice('/srv/incidents/'.length)||m.bind?.create_host_path!==false||(m.read_only===true)!==(v!=='/srv/incidents/requests'))return false;}
 const targets=new Set(Object.values(env));b.services['access-gateway'].volumes=b.services['access-gateway'].volumes.filter(v=>!targets.has(v.target));
 return canonical(a)===canonical(b);
}
export function resourceReuseVerdict({historical,assessment,runtimeDeltaHash,composeEquivalent,resources,workload,redis,redisMemory,incidentId,incidentOk,sourceEquivalent,inputsBound,serviceNames,actualRuntimePaths}){
 const cond={},metric={};
 cond.accepted_bytes=Object.entries(acceptedResourceHashes).every(([p,h])=>historical[p]&&sha(historical[p])===h);
 try{const v=JSON.parse(historical['evidence/M8/verification.json']);cond.accepted_checks=['M8-S01','M8-S02','M8-S04','M8-S05','M8-O04'].every(id=>{const r=v.results.find(r=>r.test_id===id);return r?.state==='PASS'&&r.code_dirty===false;});}catch{cond.accepted_checks=false;}
 cond.historical_sources=collectorSources(String(historical['evidence/M8/raw/soak.txt']??'')).length>=1001&&collectorSources(String(historical['evidence/M8/raw/soak.txt']??'')).every(s=>s===executionSource);
 cond.assessment=assessment?.schema==='fcpi.m9-resource-applicability/v1'&&['APPLICABILITY_PENDING_TARGETED_TESTS','VALID_FOR_M9'].includes(assessment.state)&&assessment.disposition==='REUSE_WITH_TARGETED_REGRESSION'&&assessment.material_invalidation===false&&assessment.duplicate_24h_soak==='NOT_SCHEDULED'&&assessment.soak_execution_source===executionSource&&Object.entries(acceptedResourceHashes).every(([p,h])=>assessment.historical_inputs?.some(x=>x.path===p&&x.sha256===h))&&JSON.stringify(assessment.runtime_delta_paths)===JSON.stringify(runtimeDeltaPaths)&&/^[0-9a-f]{64}$/.test(runtimeDeltaHash??'')&&assessment?.accepted_repository_baseline===resourceBaseline&&/^[0-9a-f]{40}$/.test(assessment.source_commit??'')&&sourceEquivalent(assessment.source_commit)&&assessment.runtime_delta_sha256===runtimeDeltaHash&&assessment.owner_instruction?.includes('no duplicate 24-hour soak');
 cond.assessed_paths=Array.isArray(actualRuntimePaths)&&JSON.stringify(assessment?.changed_runtime_paths)===JSON.stringify(actualRuntimePaths)&&actualRuntimePaths.every(path=>assessment?.path_assessments?.some(x=>x.path===path&&x.material_invalidation===false&&typeof x.reason==='string'&&x.reason.length>=20));
 cond.resource_configuration=composeEquivalent===true;cond.current_input_bindings=inputsBound===true;cond.incident=incidentOk===true&&/^[0-9a-f]{8}$/.test(incidentId??'');
 try{
  const f=frames(resources),samples=f.samples??[],meta=f.meta?.[0],end=f.end?.[0];
  cond.duration=meta?.duration_s===1800&&end?.elapsed_s>=1800&&samples.length>=110&&Date.parse(end.utc)-Date.parse(meta.utc)>=1800000;
  cond.sample_times=f.meta?.length===1&&f.end?.length===1&&samples.length>0&&Date.parse(end.utc)-Date.parse(meta.utc)<=1920000&&samples.every((s,i)=>Number.isFinite(Date.parse(s.utc))&&Date.parse(s.utc)>=Date.parse(meta.utc)&&Date.parse(s.utc)<=Date.parse(end.utc)&&(!i||(Date.parse(s.utc)>Date.parse(samples[i-1].utc)&&Date.parse(s.utc)-Date.parse(samples[i-1].utc)<=45000)))&&Date.parse(samples.at(-1).utc)-Date.parse(samples[0].utc)>=1750000;
  cond.no_restart=samples.length>0&&/^[0-9a-f]{64}$/.test(samples[0].boot_id_sha256??'')&&samples.every(s=>s.boot_id_sha256===samples[0].boot_id_sha256&&s.container_identities?.length===15&&s.container_identities.every(c=>c.oom_killed===false))&&samples.every(s=>canonical(s.container_identities)===canonical(samples[0].container_identities));
  cond.source=samples.length>0&&[meta?.source_commit,end?.source_commit,...samples.map(s=>s.commit)].every(s=>sourceEquivalent(s));
  cond.healthy=samples.length>0&&samples.every(s=>s.healthy===true&&Array.isArray(serviceNames)&&serviceNames.length===15&&canonical(Object.keys(s.services??{}).sort())===canonical([...serviceNames].sort())&&Object.values(s.services).every(v=>v.state==='running'&&v.health==='healthy'&&v.swap_denied===true&&v.oom_kills===0&&Number.isFinite(v.peak_mib)&&v.limit_mib>0&&v.peak_mib/v.limit_mib<.9));
  cond.host=samples.length>0&&samples.every(s=>s.host?.mem?.available_mib>=1024&&s.host?.throttled==='0x0'&&s.host?.host_oom_kill===0&&s.host?.sample_age_s>=0&&s.host.sample_age_s<=120&&s.slice_memory_current>0&&s.slice_memory_current<5632*MIB&&s.paid_dispatch===false);
  cond.queue=samples.length>0&&samples.every(s=>s.queue?.ok===true&&s.queue.oldest_queued_s<=300)&&samples.at(-1).queue.queued===0&&samples.at(-1).queue.active===0;
  cond.disk=samples.length>0&&samples.at(-1).host.disk.free>=samples[0].host.disk.free-2*1024*MIB;
  const concurrent=samples.flatMap(s=>(s.models??[]).filter(m=>m.unit==='fcpi-incident-'+incidentId+'.service'));
  cond.concurrent_incident=concurrent.length>0&&concurrent.every(m=>m.memory_current>0&&m.memory_current<=768*MIB&&m.memory_peak>0&&m.memory_peak<.9*768*MIB&&m.memory_swap===0);
  metric.samples=samples.length;metric.minimum_available_mib=Math.min(...samples.map(s=>s.host?.mem?.available_mib??0));metric.slice_peak_mib=Math.round(Math.max(...samples.map(s=>s.slice_memory_current??0))/MIB);metric.incident_peak_mib=Math.round(Math.max(0,...concurrent.map(s=>s.memory_peak))/MIB);
  const w=frames(workload),log=w.soak_log??[],window=w.meta?.[0];
  cond.aligned_windows=Date.parse(meta?.utc)>=window?.start_epoch*1000&&Date.parse(meta?.utc)<=window?.start_epoch*1000+60000&&Date.parse(end?.utc)>=window?.end_epoch*1000;
  cond.workload_window=window?.end_epoch-window?.start_epoch===1800&&sourceEquivalent(window?.commit)&&log.some(x=>x.class==='end'&&Date.parse(x.utc)>=window.end_epoch*1000);
  const requests=log.filter(x=>x.class!=='end');cond.workload_outcomes=requests.length>=70&&requests.every(x=>x.ok===true&&x.status===200&&Number.isFinite(x.ms)&&x.ms>=0&&Date.parse(x.utc)>=window.start_epoch*1000&&Date.parse(x.utc)<=window.end_epoch*1000)&&[0,1,2,3,4,5].every(k=>requests.some(x=>Date.parse(x.utc)>=window.start_epoch*1000+k*300000&&Date.parse(x.utc)<window.start_epoch*1000+(k+1)*300000));
  cond.concurrent_traffic=samples.some(s=>Date.parse(s.utc)>=window.start_epoch*1000&&Date.parse(s.utc)<=window.end_epoch*1000&&(s.models??[]).some(m=>m.unit==='fcpi-incident-'+incidentId+'.service')&&s.controlled_request?.incident_overlap===true&&s.controlled_request.ok===true&&s.controlled_request.status===200&&Number.isFinite(s.controlled_request.ms));
  const probeLatency=samples.map(s=>s.controlled_request?.ms);cond.targeted_requests=samples.length>0&&samples.every(s=>s.controlled_request?.ok===true&&s.controlled_request.status===200&&Number.isFinite(s.controlled_request.ms)&&s.controlled_request.ms>=0)&&percentile(probeLatency,.95)<=5000;metric.controlled_static_p95_ms=percentile(probeLatency,.95);metric.controlled_static_max_ms=Math.max(...probeLatency);
  cond.continuity=Date.parse(samples[0]?.utc)<=window.start_epoch*1000+60000&&Date.parse(samples.at(-1)?.utc)>=window.end_epoch*1000&&Date.parse(end?.utc)<=window.end_epoch*1000+120000;
  cond.workload_coverage=['static','status','js','mcp_list','mcp_scrape','search','map','pdf','extract','crawl_submit','crawl_done','batch_submit','batch_done','screenshot'].every(c=>requests.some(x=>x.class===c));
  const latency=Object.fromEntries(['static','js','status','mcp_list'].map(c=>[c,percentile(requests.filter(x=>x.class===c).map(x=>x.ms),.95)]));cond.latency=latency.static<=5000&&latency.js<=20000&&latency.status<=2000&&latency.mcp_list<=2000;metric.requests=requests.length;metric.p95_ms=latency;
  const redisUtc=/\butc=([^\s]+)/.exec(redis)?.[1],resetUtc=/\breset_utc=([^\s]+)/.exec(redis)?.[1];cond.redis_window=Date.parse(redisUtc)>=window.end_epoch*1000&&Date.parse(resetUtc)>=window.start_epoch*1000-60000&&Date.parse(resetUtc)<=window.start_epoch*1000;
  const memoryField=k=>Number(new RegExp('^'+k+':(\\d+)$','m').exec(redisMemory??'')?.[1]);cond.redis_memory=Date.parse(/\butc=([^\s]+)/.exec(redisMemory??'')?.[1])>=window.end_epoch*1000&&memoryField('used_memory')>0&&memoryField('maxmemory')>0&&memoryField('used_memory_peak')<.9*memoryField('maxmemory')&&memoryField('evicted_keys')===0&&memoryField('total_error_replies')===0;
  const stats=redis.split('\n').filter(l=>l.startsWith('cmdstat_'));cond.redis=stats.length>=5&&stats.every(l=>!/rejected_calls=[1-9]|failed_calls=[1-9]/.test(l))&&/^acl_log_read=ok entries=0$/m.test(redis)&&/(?:^| )core_user=fcpi_core(?: |$)/m.test(redis)&&/^user default off /m.test(redis);
 }catch{cond.targeted_parse=false;}
 const failed=Object.entries(cond).filter(([,v])=>v!==true).map(([k])=>k);return {state:failed.length?'FAIL':'PASS',failed,conditions:cond,metrics:metric,note:'Accepted M8 24-hour evidence reused, combined with current 30-minute targeted resource regression and bounded incident invocation; no new 24-hour soak.'};
}

// M8's all-history scan intentionally retains the failed pre-fix M9 probe.
// Interpret only this immutable six-line block; no current unexplained line is
// exempt. The original probe includes the matched real CLOUD_DENIED proxy event.
export const priorCloudProbe='evidence/M9/regression/M2/raw/initial-learned-browser-rt-ssrf.txt';
export const priorCloudProbeHash='326688cdd8f595b7051638327f859ec8865b5918608f0f2f71af857469121599';
export const priorCloudBlockHash='bfa000be11c79077d0920d74766fe655e7e6e9d931f4b57c32e7b4582b5fce9d';
export function cloudWindowVerdict({logs,open,close,failedProbe,currentSecurity,inputsBound,legacyRecord}){
 const cond={inputs_bound:inputsBound===true,current_security:currentSecurity===true,prior_probe:sha(failedProbe)===priorCloudProbeHash};let retained=0,date,closeUtc,logsUtc,count=0;
 cond.legacy_failure=legacyRecord?.test_id==='M8-X01'&&legacyRecord.state==='FAIL'&&/^failed=core_logs; guard handle \d+→\d+, web accepted delta=0, proxy-port delta=0; core logs=\d+$/.test(legacyRecord.actual??'');
 try{
  const sections=s=>{const out={};for(const b of s.split(/^### /m).slice(1)){const k=b.split('\n')[0];if(Object.hasOwn(out,k))throw Error('Duplicate scan section');out[k]=b.slice(b.indexOf('\n')+1);}return out;};
  const a=sections(open),z=sections(close),ls=sections(logs),pairs=Object.entries(ls).filter(([k])=>/^(instance|stored)_[0-9a-f]{12}$/.test(k));count=pairs.length;
  cond.scan_sections=Object.keys(ls).every(k=>k==='meta'||k==='end'||/^(instance|stored)_[0-9a-f]{12}$/.test(k))&&Number(/\binstances=(\d+)/.exec(ls.meta??'')?.[1])===pairs.filter(([k])=>k.startsWith('instance_')).length;
  date=/\butc=([^\s]+)/.exec(a.meta??'')?.[1];closeUtc=/\butc=([^\s]+)/.exec(z.meta??'')?.[1];logsUtc=/\butc=([^\s]+)/.exec(ls.meta??'')?.[1];const t=Date.parse(date),end=Date.parse(closeUtc),scan=Date.parse(logsUtc),handle=s=>/guard_table_handle=(\d+)/.exec(s.meta??'')?.[1],counter=(s,section,k)=>Number(new RegExp('^'+k+' packets=(\\d+)$','m').exec(s[section]??'')?.[1]);
  cond.times=Number.isFinite(t)&&end-t>=60000&&scan>=end;
  cond.window=/^\d+$/.test(handle(a)??'')&&handle(a)===handle(z)&&counter(z,'guard_after','egress_web_accepted')-counter(a,'counters','egress_web_accepted')===0&&counter(z,'guard_after','egress_proxy_accepted')-counter(a,'counters','egress_proxy_accepted')===0;
  cond.counter_control=counter(z,'guard_after','egress_special_dropped')-counter(a,'counters','egress_special_dropped')>0;
  cond.classified_logs=pairs.length>0&&pairs.every(([name,block])=>{const c=/^classified (.*)$/m.exec(block)?.[1],kv=Object.fromEntries((c??'').split(' ').map(x=>x.split('='))),controls=Number(/^control=Starting services count=(\d+)$/m.exec(block)?.[1]),unexplained=(block.match(/^unexplained /gm)??[]).length;if(kv.dns_unexplained!=='0'||!(controls>=1)||unexplained!==Number(kv.cloud_unexplained))return false;if(kv.cloud_unexplained==='0')return true;if(name!=='stored_fc9fbe6cdf11'||kv.cloud_unexplained!=='6'||sha(name+'\n'+block)!==priorCloudBlockHash)return false;const newest=Date.parse(/^newest_line_utc=(.*)$/m.exec(block)?.[1]);if(!(newest<t))return false;retained++;return true;});
  cond.legacy_coverage=Number(/core logs=(\d+)$/.exec(legacyRecord?.actual??'')?.[1])===count;
 }catch{cond.scan_parse=false;}
 cond.exact_retained_failure=retained===1;
 return {state:Object.values(cond).every(x=>x===true)?'PASS':'FAIL',conditions:cond,failed:Object.entries(cond).filter(([,v])=>v!==true).map(([k])=>k),legacy_test_state:legacyRecord?.state??'NOT_RUN',legacy_failure_detail:legacyRecord?.actual??null,retained_unexplained_lines:retained===1?6:null,prior_probe_sha256:priorCloudProbeHash,prior_block_sha256:priorCloudBlockHash,window_start_utc:date,window_close_utc:closeUtc,logs_meta_utc:logsUtc,note:'M8-X01 retains FAIL for one immutable pre-fix M9-REG-12 block. The proxy refused a deliberate redirect probe; no Cloud egress. Timestamp/URL and matched real attempt-id connect the hash-pinned probe events. All other scan conditions remain mandatory; actual later provider-window logs are audited separately.'};
}

export function liveCloudVerdict(raw,window,bound){
 const time=Date.parse(/\butc=([^\s]+)/.exec(raw)?.[1]),start=Date.parse(window?.started_utc),finished=Date.parse(window?.required_work_finished_utc),closed=Date.parse(window?.closed_utc),expiry=Date.parse(window?.expires_at),value=k=>Number(new RegExp('(?:^| )'+k+'=(\\d+)(?: |$)','m').exec(raw)?.[1]);
 const created=Date.parse(/\bstarted_at=([^\n ]+)/.exec(raw)?.[1]);
 return {state:bound===true&&window?.state==='CLOSED'&&window.paid_dispatch===false&&window.provider_caps_zero===true&&Number.isFinite(start)&&finished>=start&&time>=finished&&closed>=time&&closed<=expiry&&expiry-start<=2700000&&created>=start&&value('lines')>10&&value('acquisition')>=20&&value('cloud_host')===0?'PASS':'NOT_RUN',window_start_utc:window?.started_utc??null,audit_utc:Number.isFinite(time)?new Date(time).toISOString():null,note:'Actual paid-container logs cover every authorized live operation before shutoff; zero Cloud-host lines, with acquisition/log counts as positive controls. Controlled denial proofs are recorded separately.'};
}

// Recheck only failed low-risk corpus cases with supported caller options.
// Keep the original batch, all twenty targets/criteria and its paid audit intact.
export function corpusLineageComplete({firstStarted,firstRecord,finalStarted,finalRecord}){return(!firstStarted||!!firstRecord)&&(!finalStarted||!!(finalRecord&&firstRecord));}
export function corpusRecheckVerdict({specText,freeze,initialText,initialRecord,initialWindow,recheckText,record,finalRecord,sourceEquivalent,bound,prior}){
 try{
  const initial=JSON.parse(initialText),spec=JSON.parse(specText),count=(raw,key)=>{const m=[...String(raw).matchAll(new RegExp('(?:^| )'+key+'=(\\d+)(?= |$)','gm'))];return m.length===1?Number(m[0][1]):NaN;};
  if(!sourceEquivalent(initial.source_commit)||!liveEvidenceInWindow(initial,initialRecord,initialWindow))return false;
  const results=structuredClone(initial.results),spent=results.map(r=>r.acquisition?.attempts_used),receipts=new Set(initial.results.map(r=>r?.json?.data?.metadata?.scrapeId).filter(Boolean));let previousEnd=Date.parse(initialWindow.closed_utc);
  const batches=prior?[{...prior,profile:1},{recheckText,record,bound,profile:2}]:[{recheckText,record,bound,profile:1}];
  if(prior&&(record.prior_raw_sha256!==sha(prior.recheckText)||record.prior_record_sha256!==sha(JSON.stringify(prior.record))))return false;
  for(const batch of batches){
   const r=JSON.parse(batch.recheckText),rec=batch.record,identity=raw=>{const rows=String(raw).split('\n').filter(l=>/^container=[0-9a-f]{12,64} started_at=\S+$/.test(l));return rows.length===1&&Number.isFinite(Date.parse(rows[0].split('started_at=')[1]))?rows[0]:null},start=Date.parse(rec.started_utc),end=Date.parse(rec.completed_utc);
   if(batch.profile===2&&r.deployed_commit!==r.source_commit)return false;
   if(!identity(r.cloud_audit)||identity(r.cloud_audit)!==identity(r.cloud_audit_before))return false;
   if(batch.bound!==true||r.source_commit!==rec.source_commit||!sourceEquivalent(r.source_commit)||rec.initial_raw_sha256!==sha(initialText)||rec.raw_sha256!==sha(batch.recheckText)||rec.initial_public_sha256!==sha(JSON.stringify(initialRecord))||
    ![start,end,previousEnd].every(Number.isFinite)||end<start||start<=previousEnd||r.status_before?.healthy!==true||!Array.isArray(r.results)||JSON.stringify(r.results.map(x=>x.id).sort())!==JSON.stringify(['P01','P02','P07','P08'])||
    ![r.before,r.after].every(s=>s.paid_dispatch===false&&s.caps_zero===true)||!Array.isArray(r.ledger_keys_before)||JSON.stringify(r.ledger_keys_before)!==JSON.stringify(r.ledger_keys_after)||
    count(r.cloud_audit,'cloud_host')!==0||count(r.cloud_audit_before,'cloud_host')!==0||!Number.isFinite(count(r.cloud_audit_before,'acquisition'))||!Number.isFinite(count(r.cloud_audit,'acquisition'))||count(r.cloud_audit,'acquisition')-count(r.cloud_audit_before,'acquisition')<4)return false;
   for(const item of r.results){
    const i=spec.targets.findIndex(t=>t.id===item.id),target=spec.targets[i],response=item.response,sid=response?.json?.data?.metadata?.scrapeId,summary=rec.results?.find(x=>x.id===item.id);
    if(i<0||!['static','js'].includes(target.page_class)||!Number.isInteger(target.max_attempts)||target.max_attempts<1||target.max_attempts>3||initialRecord.results[i].usable!==false)return false;
    const js=target.page_class==='js',extra=batch.profile===1?(js?{waitFor:1000}:{}):({actions:[{type:'wait',milliseconds:js?(item.id==='P08'?10000:1000):0}]});
    const expected={url:target.url,formats:batch.profile===1?['markdown']:['markdown','rawHtml'],maxAge:0,storeInCache:false,onlyMainContent:false,...extra};
    const began=Date.parse(response?.started_utc),finished=Date.parse(response?.completed_utc),used=response?.acquisition?.attempts_used;
    if(!sid||receipts.has(sid)||response.acquisition?.logical_id!==sid||canonical(item.request)!==canonical(expected)||summary?.request_sha256!==sha(JSON.stringify(item.request))||summary?.attempts!==used||summary?.status!==response.status||
     !Number.isFinite(began)||!Number.isFinite(finished)||began<start||finished>end||finished<began||!Number.isInteger(spent[i])||!Number.isInteger(used)||used<1||spent[i]+used>target.max_attempts||
     response.acquisition.proxy_bytes!==0||response.acquisition.proxy_micro_usd!==0||response.acquisition.enhanced_micro_usd!==0)return false;
    receipts.add(sid);spent[i]+=used;if(batch.profile===2&&summary.cumulative_attempts!==spent[i])return false;results[i]=response;
   }
   previousEnd=end;
  }
  return finalRecord.evidence_mode==='INITIAL_BATCH_PLUS_UNPAID_RECHECKS'&&finalRecord.initial_usable===initialRecord.usable&&corpusVerdict(specText,freeze,{results},finalRecord);
 }catch{return false;}
}
