import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import {issueGrant,makeIncidentActions} from '../src/incidents.mjs';

async function fixture(fn) {
  const d=await mkdtemp(join(tmpdir(),'fcpi-approvals-'));
  const grantsDir=join(d,'grants'),requestsDir=join(d,'requests'),keyFile=join(d,'key');
  await mkdir(grantsDir); await mkdir(requestsDir);
  const {privateKey:key,publicKey}=generateKeyPairSync('ed25519'),base_sha='b'.repeat(40),now=()=>1000000;
  await writeFile(keyFile,publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  try { await fn({grantsDir,requestsDir,keyFile,key,base_sha,now}); }
  finally { await rm(d,{recursive:true,force:true}); }
}
test('one authenticated action survives restart and concurrent replay',()=>fixture(async c=>{
  const {grant,signature}=await issueGrant({...c,now:c.now(),incident_id:'123abcde',action:'apply_fix',patch_sha:'c'.repeat(64),tests_sha:'d'.repeat(64)});
  const a=makeIncidentActions(c);
  const r=await Promise.all(Array.from({length:12},()=>a.consume(grant.id,signature)));
  assert.equal(r.filter(x=>x.status===202).length,1);assert.equal(r.filter(x=>x.status===409).length,11);
  assert.equal((await makeIncidentActions(c).consume(grant.id,signature)).status,409);
  const q=JSON.parse(await readFile(join(c.requestsDir,grant.id+'.json')));
  assert.equal(q.patch_sha,grant.patch_sha);assert.equal(q.tests_sha,grant.tests_sha);
}));
test('a URL alone, wrong MAC, payload, or expired grant never approves',()=>fixture(async c=>{
  const {grant,signature}=await issueGrant({...c,now:c.now(),incident_id:'123abcde',action:'investigate'});
  const a=makeIncidentActions(c);
  for(const sig of [undefined,'','f'.repeat(128)]) assert.equal((await a.consume(grant.id,sig)).status,401);
  assert.equal((await a.consume(grant.id,signature,{bodyBytes:1})).status,400);
  assert.equal((await a.consume(grant.id,signature,{method:'GET'})).status,405);
  assert.equal((await makeIncidentActions({...c,now:()=>grant.expires_at}).consume(grant.id,signature)).status,401);
}));
test('a changed patch or action invalidates an issued MAC',()=>fixture(async c=>{
  const {grant,signature}=await issueGrant({...c,now:c.now(),incident_id:'123abcde',action:'apply_fix',patch_sha:'c'.repeat(64),tests_sha:'d'.repeat(64)});
  await writeFile(join(c.grantsDir,grant.id+'.json'),JSON.stringify({...grant,patch_sha:'e'.repeat(64)}));
  assert.equal((await makeIncidentActions(c).consume(grant.id,signature)).status,401);
}));
test('unbound fixes and unknown actions cannot be issued',()=>fixture(async c=>{
  for(const action of ['apply_fix','enable_paid','shell']) await assert.rejects(issueGrant({...c,now:c.now(),incident_id:'123abcde',action}));
}));
