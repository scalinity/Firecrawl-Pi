// One bounded subscription investigation against the current healthy deployment.
// No apply grant, code deployment, paid retrieval or provider policy change.
import{execFileSync}from'node:child_process';import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{createHash,randomBytes}from'node:crypto';import{homedir}from'node:os';
import{incidentVerdict}from'./evidence-checks.mjs';
const review=readFileSync('evidence/M9/review/REVIEW.md','utf8');if(!review.includes('Remediation complete'))throw Error('Address fixtures must pass first');
const t=Object.fromEntries(readFileSync('scripts/m1/pi-target.conf','utf8').split('\n').filter(l=>/^PI_\w+=/.test(l)).map(l=>[l.split('=')[0],l.slice(l.indexOf('=')+1).replace('$HOME',process.env.HOME)]));
const pi=cmd=>execFileSync('ssh',['-i',t.PI_SSH_KEY,'-o','IdentitiesOnly=yes','-o','BatchMode=yes',t.PI_SSH_TARGET,cmd],{encoding:'utf8',maxBuffer:20*1024*1024});
const source=pi('cat /opt/firecrawl-pi/.fcpi-source-commit').trim();if(source!==execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())throw Error('Deployment differs');
const id=randomBytes(4).toString('hex');pi(`sudo -n bash /opt/firecrawl-pi/scripts/m9/incident-prepare.sh ${id}`);
const props=pi(`sudo -n systemctl show fcpi-incident-${id}.service -p MemoryMax -p MemorySwapMax -p RuntimeMaxUSec -p NoNewPrivileges -p User -p Group -p CPUQuotaPerSecUSec -p TasksMax -p Slice -p KillMode -p TimeoutStopUSec -p ProtectSystem -p ProtectHome -p PrivateTmp -p ReadWritePaths -p InaccessiblePaths -p BindReadOnlyPaths`).trim().split('\n').map(l=>l.split('='));const unit=Object.fromEntries(props);
let completed=false;for(let n=0;n<75;n++){await new Promise(r=>setTimeout(r,5000));if(pi(`sudo -n systemctl is-active fcpi-incident-${id}.service || true`).trim()!=='active'){completed=true;break;}}
if(!completed)throw Error('Bounded unit did not end');
const root=homedir()+'/.local/share/firecrawl-pi/m9/incident';mkdirSync(root,{recursive:true,mode:0o700});
let raw='';try{raw=pi(`sudo -n cat /var/lib/firecrawl-pi/incidents/work/${id}/run/result.json`);}catch{}
writeFileSync(root+'/'+id+'.json',raw,{mode:0o600});
let transcript='';try{transcript=pi(`sudo -n cat /var/lib/firecrawl-pi/incidents/work/${id}/run/auth/projects/-var-lib-firecrawl-pi-incidents-work-${id}-empty/$(sudo -n cat /var/lib/firecrawl-pi/incidents/work/${id}/session-id).jsonl`);}catch{}
writeFileSync(root+'/'+id+'.transcript.jsonl',transcript,{mode:0o600});
const authRemoved=pi(`sudo -n test ! -e /var/lib/firecrawl-pi/incidents/work/${id}/run/auth/access-token; echo $?`).trim()==='0';let result;try{result=JSON.parse(raw);}catch{}
const out={schema:'fcpi.incident-live/v1',utc:new Date().toISOString(),source_commit:source,incident_id:id,controlled_healthy_diagnosis:true,raw_sha256:createHash('sha256').update(raw).digest('hex'),unit:{...unit,MemoryMax:Number(unit.MemoryMax),NoNewPrivileges:unit.NoNewPrivileges==='yes',declared_tools:'Read,Edit,Write,StructuredOutput',tools_evidence:'pinned source-bound agent/hook; StructuredOutput serializes only the fixed diagnosis schema; not a systemd property'},owner_authentication:'Max subscription',auth_removed:authRemoved,is_error:result?.is_error??null,model:'claude-opus-5-5',api_equivalent_estimate_usd:result?.total_cost_usd??null,invoiced_usd:null,state:'IMPLEMENTED_UNVERIFIED'};
out.transcript_sha256=createHash('sha256').update(transcript).digest('hex');
out.state=incidentVerdict(raw,out,transcript)?'VERIFIED_LIVE':'IMPLEMENTED_UNVERIFIED';
writeFileSync('evidence/M9/incident-proof.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({state:out.state,incident_id:id,auth_removed:authRemoved,api_equivalent_estimate_usd:out.api_equivalent_estimate_usd}));process.exitCode=out.state==='VERIFIED_LIVE'?0:1;
