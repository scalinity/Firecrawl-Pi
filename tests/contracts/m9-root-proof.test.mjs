import{test}from'node:test';import assert from'node:assert/strict';import{generateKeyPairSync}from'node:crypto';import{signatureFor,verifiedRequest}from'../../services/access/src/incidents.mjs';
test('privileged controller independently rejects forged/tampered/expired gateway spool entries',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');const now=Date.now();const issued={schema:'fcpi.incident-grant/v1',id:'a'.repeat(32),incident_id:'123abcde',action:'apply_fix',base_sha:'b'.repeat(40),patch_sha:'c'.repeat(64),tests_sha:'d'.repeat(64),issued_at:now-100,expires_at:now+1000};
 const request={...issued,signature:signatureFor(privateKey,issued),approved_at:now};
 const good=verifiedRequest(request,issued,publicKey,issued.id,now);assert.equal(good.action,'apply_fix');assert.equal(good.signature,undefined);
 for(const changed of [{action:'rollback'},{base_sha:'e'.repeat(40)},{patch_sha:'f'.repeat(64)},{tests_sha:'e'.repeat(64)},{signature:'0'.repeat(128)},{approved_at:now+500},{approved_at:now-101},{id:'f'.repeat(32)}])assert.throws(()=>verifiedRequest({...request,...changed},issued,publicKey,issued.id,now));
 assert.throws(()=>verifiedRequest(request,issued,publicKey,issued.id,now+1001));
 assert.throws(()=>verifiedRequest({...request,patch_sha:'e'.repeat(64)},{...issued,patch_sha:'e'.repeat(64)},publicKey,issued.id,now));
});
