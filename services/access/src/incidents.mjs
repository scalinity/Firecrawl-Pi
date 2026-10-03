// M9: private phone approvals. A grant binds one action to one incident, deployed base,
// patch and test report. The signature is an HTTP header for mutations. Exclusive,
// fsynced request creation consumes it across restarts; the gateway executes no host command.
import { readFile, open } from 'node:fs/promises';
import { sign, verify, randomBytes } from 'node:crypto';
import { join } from 'node:path';

const HEX = /^[0-9a-f]{64}$/;
const ACTIONS = new Set(['investigate','details','dismiss','apply_fix','rollback']);
export function validGrant(g, now = Date.now()) {
  return g?.schema === 'fcpi.incident-grant/v1' && /^[0-9a-f]{32}$/.test(g.id)
    && /^[0-9a-f]{8}$/.test(g.incident_id) && ACTIONS.has(g.action)
    && /^[0-9a-f]{40}$/.test(g.base_sha) && (g.patch_sha === null || HEX.test(g.patch_sha))
    && (g.tests_sha === null || HEX.test(g.tests_sha))
    && Number.isSafeInteger(g.issued_at) && Number.isSafeInteger(g.expires_at)
    && g.issued_at <= now && g.expires_at > now && g.expires_at - g.issued_at <= 3600000
    && (g.action !== 'apply_fix' || (HEX.test(g.patch_sha) && HEX.test(g.tests_sha)));
}
const signedBytes = g => Buffer.from(JSON.stringify([
  g.schema,g.id,g.incident_id,g.action,g.base_sha,g.patch_sha,g.tests_sha,g.issued_at,g.expires_at,
]));
export const signatureFor = (key,g) => sign(null,signedBytes(g),key).toString('hex');
export const verifySignature = (key,g,signature) => typeof signature==='string' && /^[0-9a-f]{128}$/.test(signature)
  && verify(null,signedBytes(g),key,Buffer.from(signature,'hex'));
export async function durableExclusive(path, data) {
  const f = await open(path,'wx',0o640);
  try { await f.writeFile(JSON.stringify(data)+'\n'); await f.sync(); } finally { await f.close(); }
  const dir = await open(join(path,'..'),'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
export async function issueGrant({grantsDir,key,incident_id,action,base_sha,patch_sha=null,tests_sha=null,now=Date.now()}) {
  const g={schema:'fcpi.incident-grant/v1',id:randomBytes(16).toString('hex'),incident_id,action,base_sha,patch_sha,tests_sha,issued_at:now,expires_at:now+1800000};
  if(!validGrant(g,now)) throw new Error('Invalid incident grant');
  await durableExclusive(join(grantsDir,g.id+'.json'),g);
  return {grant:g,signature:signatureFor(key,g)};
}
export function makeIncidentActions({grantsDir,requestsDir,keyFile,reportsDir=null,now=()=>Date.now()}) {
  return {async consume(id,signature,{method='POST',bodyBytes=0}={}) {
    const no = (status,code) => ({status,body:{success:false,code}});
    if(!['POST','GET'].includes(method)) return no(405,'METHOD_NOT_ALLOWED');
    if(bodyBytes!==0) return no(400,'EMPTY_BODY_REQUIRED');
    if(!/^[0-9a-f]{32}$/.test(id) || typeof signature!=='string' || !/^[0-9a-f]{128}$/.test(signature)) return no(401,'INVALID_APPROVAL');
    let g;
    try { g=JSON.parse(await readFile(join(grantsDir,id+'.json'),'utf8')); }
    catch(e) { if(e.code==='ENOENT' || e instanceof SyntaxError) return no(401,'INVALID_APPROVAL'); throw e; }
    if(g.id!==id || !validGrant(g,now())) return no(401,'INVALID_APPROVAL');
    if(method==='GET' && (g.action!=='details' || !reportsDir)) return no(405,'METHOD_NOT_ALLOWED');
    const key=(await readFile(keyFile,'utf8')).trim();
    // Only a public verifier key is mounted here. The gateway cannot mint an
    // owner approval even if its writable request spool were compromised.
    if(!verifySignature(key,g,signature)) return no(401,'INVALID_APPROVAL');
    try { await durableExclusive(join(requestsDir,id+'.json'),{...g,signature,approved_at:now()}); }
    catch(e) { if(e.code==='EEXIST') return no(409,'APPROVAL_ALREADY_USED'); throw e; }
    if(method==='GET') {
      const report=JSON.parse(await readFile(join(reportsDir,g.incident_id+'.json'),'utf8'));
      if(report.incident_id!==g.incident_id || report.base_sha!==g.base_sha) throw new Error('Incident report binding mismatch');
      return {status:200,body:{success:true,report}};
    }
    return {status:202,body:{success:true,incident_id:g.incident_id,action:g.action,state:'QUEUED'}};
  }};
}
