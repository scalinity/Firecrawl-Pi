import test from 'node:test';import assert from 'node:assert/strict';import{loadConfig}from'../src/config.mjs';import{mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
test('the full incident configuration passes startup; partial or unknown policy fails closed',()=>{
 const d=mkdtempSync(join(tmpdir(),'fcpi-config-'));
 try{
  mkdirSync(join(d,'art'));writeFileSync(join(d,'art/.fcpi-artifact-root'),'fixture');
  const base={PI_CORE_URL:'http://127.0.0.1:3002',PI_ALLOWED_HOSTS:'http://127.0.0.1:3380',PI_GATEWAY_CLIENTS_FILE:join(d,'clients'),PI_CAPABILITIES_FILE:process.env.FCPI_TEST_MANIFEST??new URL('../../../deploy/policies/capabilities.json',import.meta.url).pathname,PI_ARTIFACT_ROOT:join(d,'art'),PI_CREDENTIALS_DIR:d,PI_POSTGRES_HOST:'fixture',PI_POSTGRES_DB:'fixture',PI_POSTGRES_USER:'fixture',PI_INCIDENT_GRANTS_DIR:d,PI_INCIDENT_REQUESTS_DIR:d,PI_INCIDENT_REPORTS_DIR:d,PI_INCIDENT_KEY_FILE:join(d,'key'),PI_INCIDENT_OWNER_FILE:join(d,'owner')};
  writeFileSync(join(d,'gateway_postgres_password'),'fixture-not-a-production-password');
  assert.equal(loadConfig(base).incidents.ownerFile,base.PI_INCIDENT_OWNER_FILE);
  assert.throws(()=>loadConfig({...base,PI_INCIDENT_OWNER_FILE:undefined}),/configured together/);
  assert.throws(()=>loadConfig({...base,PI_ENABLE_UNSAFE:'true'}),/unknown configuration/);
  assert.equal(loadConfig(base).modelExtractExtraMs,0,'absent, a request that names its model gets no more time than any other');
  assert.equal(loadConfig({...base,PI_MODEL_EXTRACT_EXTRA_MS:'300000'}).modelExtractExtraMs,300000);
  assert.throws(()=>loadConfig({...base,PI_MODEL_EXTRACT_EXTRA_MS:'600001'}),/PI_MODEL_EXTRACT_EXTRA_MS must be between/);
  assert.throws(()=>loadConfig({...base,PI_MODEL_EXTRACT_EXTRA_MS:'-1'}),/PI_MODEL_EXTRACT_EXTRA_MS must be an integer/);
 }finally{rmSync(d,{recursive:true,force:true});}
});
