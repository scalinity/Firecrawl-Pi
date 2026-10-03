// Trusted host utility, run in the pinned Node image with network disabled.
// Input and signatures travel on stdin/stdout to the notifier, never argv/logs.
import { readFile } from 'node:fs/promises';
import { issueGrant } from '../../services/access/src/incidents.mjs';
const chunks=[];for await(const c of process.stdin)chunks.push(c);
const n=JSON.parse(Buffer.concat(chunks));
const key=await readFile('/run/secrets/incident_signing_key','utf8');
const u=new URL(n.origin);
if(u.protocol!=='https:'||u.origin!==n.origin||u.username||u.password)throw new Error('Private HTTPS origin required');
const labels={investigate:'Investigate',details:'View Report',dismiss:'Dismiss',apply_fix:'Apply Fix',rollback:'Roll Back'};
if(!Array.isArray(n.actions)||n.actions.length>3)throw new Error('Invalid action list');
const actions=[];
for(const action of n.actions){
 const {grant,signature}=await issueGrant({grantsDir:'/grants',key,incident_id:n.incident_id,action,base_sha:n.base_sha,patch_sha:n.patch_sha??null,tests_sha:n.tests_sha??null});
 const url=`${n.origin}/platform/v1/incidents/action/${grant.id}`;
 actions.push(action==='details' ? {action:'view',label:labels[action],url:`${url}?proof=${signature}`}
  : {action:'http',label:labels[action],url,method:'POST',headers:{'X-FCPI-Approval':signature},clear:true});
}
process.stdout.write(JSON.stringify(actions)+'\n');
