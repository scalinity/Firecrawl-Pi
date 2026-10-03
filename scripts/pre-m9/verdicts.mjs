// Additional PRE-M9 live proofs. Historical milestone verifiers still own their original checks.
const one = (e, section, c) => e[section]?.find(r=>r.case===c);
const result = (conditions) => ({ state:Object.values(conditions).every(Boolean)?"PASS":"FAIL", failed:Object.keys(conditions).filter(k=>!conditions[k]) });
const ended = e => e.meta?.length===1 && e.end?.length===1 && e.end[0].exit===0 && !e.error;
export function closureVerdicts(m5, m6, m7) {
  const n = one(m5,"live_model","missing_is_null"), p = one(m5,"live_parser","scan_cached");
  const model = m5.provider_log?.flatMap(r=>r.events??[]).filter(r=>r.event==="model_call" && r.outcome==="answered") ?? [];
  const b = one(m6,"live_browser","assigned_subresource_route"), c = one(m7,"live_cache","enhanced_cached"), a = one(m7,"live_auto","synthetic_challenge_real_zyte");
  return {
    model_null_and_selection: result({ complete:ended(m5), null_preserved:n?.status===200 && n.json?.product==="Fixture Widget" && n.json.manufacturer===null,
      provenance:n?.fcpi?.extraction?.sources?.["$"]?.length===1,
      requested_model:n?.fcpi?.extraction?.model==="gpt-6-luna", resolved_model:model.length>=4 && model.every(x=>x.model==="gpt-6-luna" && /^gpt-6-luna(?:-|$)/.test(x.resolved_model??"")) }),
    parser_cache:result({ complete:ended(m5), cached_content:p?.status===200 && /FCPI\s*SCAN\s*42/i.test(p.head??""),
      no_new_reservation:p?.rows_before>=2 && p.rows_before===p.rows_after,
      cache_event:(m5.provider_log?.flatMap(r=>r.events??[])??[]).some(x=>x.event==="parse" && x.parser==="llamaparse-cost-effective" && x.cached===true) }),
    residential_browser:result({ complete:ended(m6), content:b?.status===200 && b.pagePresent===true && b.imageLoaded===true && b.proxyUsed==="stealth",
      route:b?.acquisitions?.some(x=>x.strategies?.includes("residential_browser") && x.proxy_bytes>0 && !x.failure),
      subresources:b?.renders?.some(x=>x.ok===true && x.requests>=1 && x.blocked===0 && x.over_limit===0),
      settlement:b?.ledger?.some(x=>x.provider==="decodo" && x.state==="SETTLED" && x.usage?.bytes>0 && x.usage?.tunnels>=2) }),
    enhanced_cache:result({ complete:ended(m7), cached:c?.status===200 && c.cache==="hit", no_dispatch:c?.rows_before>=1 && c.rows_after===c.rows_before }),
    automatic_enhanced:result({ complete:ended(m7), challenge_rejected:a?.success===false && a.code==="BLOCKED_PUBLIC_CONTENT",
      one_dispatch:a?.ledger?.length===1 && a.ledger[0].provider==="zyte",
      bounded_route:a?.acquisitions?.some(x=>x.failure==="BLOCKED_PUBLIC_CONTENT" && x.strategies?.[0]==="direct_http" && x.strategies.filter(s=>/^enhanced_/.test(s)).length===1 && x.attempts_used<=4 && x.logical_id===a.ledger?.[0]?.logical_id),
      accounted:a?.ledger?.every(x=>["SETTLED","RELEASED"].includes(x.state) && Number.isFinite(Number(x.actual))) })
  };
}
