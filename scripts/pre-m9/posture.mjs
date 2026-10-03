#!/usr/bin/env node
// Supplemental current-layout assertions; never overwrites historical milestone evidence.
import { readFileSync, writeFileSync } from "node:fs";
import { ROOT, sections, kv, repoState, sha256File } from "../m0/lib.mjs";
const EV="evidence/M5/pre-m9-closure/", R=EV+"raw/";
const read=p=>readFileSync(`${ROOT}/${p}`,"utf8"), json=p=>JSON.parse(read(p));
const st=sections(R+"stack.txt"), prior=sections(R+"stack-before-live.txt"), status=json(R+"status-after.json"), input=json(R+"posture-input.json");
const containers=st.containers.filter(l=>l.includes(" name=")).map(l=>kv(l.split(" ")));
const cg=st.cgroups.map(l=>kv(l.split(" ")));
const scans=[prior,st].map(s=>kv(s.retrieval_log_scan.find(l=>l.startsWith("lines=")).split(" ")));
const budgetHashes=[prior,st].map(s=>kv(s.retrieval_log_scan.find(l=>l.startsWith("budget_policy_sha256_logged=")).split(" ")));
const core=Object.entries(sections(R+"core-logs-final.txt")).filter(([k])=>/^(instance|stored)_/.test(k)).map(([,v])=>v);
const before=sections(EV+"snapshot-before.txt"), after=sections(EV+"snapshot-after.txt");
const ids=new Set([...before.docker_ps,...after.docker_ps].map(l=>l.split("\t")[0]));
// All Docker resources are FCPI here; no unrelated containers/namespaces may be present.
const normalize=s=>Object.fromEntries(Object.entries(s).map(([k,ls])=>[k,ls.filter(l=>
  !(k==="meta" && /^20\d\d-/.test(l)) && !(k==="systemd_running" && /^session-\d+\.scope$/.test(l)) &&
  !(k==="systemd_running" && [...ids].some(id=>l===`docker-${id}.scope`)) &&
  !(k==="docker_ps" && /\tfcpi-(retrieval-service|fixture-m6)-1\t/.test(l)) &&
  !(k==="findmnt" && (l.startsWith("/run/docker/netns/") || [...ids].some(id=>l.startsWith(`/var/lib/docker/rootfs/overlayfs/${id} `)))) &&
  !(k==="firewall" && l.startsWith("nft_ruleset_sha256=")))]));
const rules=p=>read(p).split("\n").filter(l=>!l.startsWith("#") && l.trim()!== 'ip daddr 10.231.6.2 iifname != "fcpi-egress" counter drop').join("\n");
const net=n=>st.networks.find(l=>l.startsWith(n+" "))??"";
const pub=st.published.filter(l=>l.includes(" -> "));
const p=input.providers.body, caps=p.caps, compose=json(EV+"rendered-compose.json");
const ledger=json("evidence/M6/pre-m9-closure/raw/ledger-after-stop.json").rows;
const checks={
  healthy:status.healthy===true && Object.keys(status.services).length===15 && Object.values(status.services).every(x=>x.state==="running"&&x.health==="healthy"&&x.oom_kills===0),
  native:containers.length===15 && containers.every(x=>x.platform==="linux/arm64") && st.containers.filter(l=>l.includes(" uname_m=")).length===15 && st.containers.filter(l=>l.includes(" uname_m=")).every(l=>l.endsWith("uname_m=aarch64")),
  effective_swap:cg.length===15 && cg.every(x=>x.parent_swap_max==="0" || x["memory.swap.max"]==="0"),
  isolation:containers.every(x=>x.privileged==="false"&&x.docker_sock_mount==="0"&&x.cap_drop==="ALL"&&x.security_opt.includes("no-new-privileges")) && /internal=true .*gateway_mode_ipv4=isolated/.test(net("fcpi_search")) && /internal=true .*gateway_mode_ipv4=isolated/.test(net("fcpi_model")) && ["search","model"].every(n=>st.networks.includes(`bridge fcpi-${n} addresses=`)),
  private_access:pub.length===1 && pub[0]==="access-gateway 3300/tcp -> 127.0.0.1:3380" && st.gateway_unauthenticated.includes("status_without_token=401"),
  zero_paid:input.providers.status===200 && p.paidDispatch===false && ["llm","parser","proxy","enhanced"].every(n=>Object.values(caps[n].caps).every(v=>v===0)) && input.overridesAbsent===true,
  secret_modes:input.secretModes.length===4 && input.secretModes.every(m=>m==="600:3310:3310"),
  complete_accounting:ledger.length===14 && ledger.every(x=>x.state==="SETTLED" && x.actual>=0),
  log_hygiene:scans[0].lines>=100 && ["search","model_call","parse","extraction"].every(k=>scans[0][k]>0) && scans[1].lines>=1 && scans.every(s=>["provider_key_like","client_token_like","bearer","proxy_authorization","basic_credential","session_username","signature"].every(k=>s[k]==="0")),
  budget_hash:budgetHashes.every(h=>h.budget_policy_sha256_logged===h.budget_policy_sha256_deployed && h.budget_policy_sha256_deployed===sha256File("deploy/policies/budget.json")),
  cloud_disabled:["access-gateway","mcp-gateway","retrieval-service"].every(n=>compose.services[n].environment.PI_CLOUD_ACCESS_ENABLED==="false"),
  cloud:scans.every(s=>s.cloud_host==="0") && core.length>=1 && core.every(ls=>{const c=kv(ls.find(l=>l.startsWith("classified ")).split(" "));return c.cloud_unexplained==="0"&&c.dns_unexplained==="0"&&ls.some(l=>/^control=Starting services count=[1-9]/.test(l));}) && Object.values(json(EV+"additional-verification.json").tests).every(x=>x.state==="PASS"),
  host_headroom:status.host.mem.available_mib>1024 && status.host.host_oom_kill===0 && status.host.throttled==="0x0",
  preserved:status.foreign_containers.length===0 && [...before.docker_ps,...after.docker_ps].every(l=>/\tfcpi-/.test(l)) && before.meta[1]===after.meta[1] && JSON.stringify(normalize(before))===JSON.stringify(normalize(after)) && rules("evidence/M8/raw/nft-ruleset.txt")===rules(R+"nft-ruleset.txt"),
  offdevice_restore:status.backup.offdevice==="yes" && status.backup.last_restore_test.result==="PASS"
};
const inputs=[R+"stack.txt",R+"stack-before-live.txt",R+"status-after.json",R+"posture-input.json",R+"core-logs-final.txt",R+"nft-ruleset.txt",EV+"snapshot-before.txt",EV+"snapshot-after.txt","evidence/M6/pre-m9-closure/raw/ledger-after-stop.json","evidence/M8/raw/nft-ruleset.txt"];
const out={utc:new Date().toISOString(),...repoState(),test_id:"PRE-M9-CURRENT-POSTURE",expected:"current M8 layout, inherited workload log controls and final live accounting; no M9 acceptance run",checks,state:Object.values(checks).every(Boolean)?"PASS":"FAIL",inputs:inputs.map(path=>({path,sha256:sha256File(path)})),patch_sha256:sha256File("patches/series.json"),config_sha256:sha256File("deploy/policies/budget.json"),image:json("deploy/versions.lock.json").images.retrieval};
writeFileSync(`${ROOT}/${EV}posture-verification.json`,JSON.stringify(out,null,2)+"\n");
console.log(out.state, Object.entries(checks).filter(([,v])=>!v).map(([k])=>k));process.exitCode=out.state==="PASS"?0:1;
