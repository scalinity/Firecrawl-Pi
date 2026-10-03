import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{execFileSync}from'node:child_process';
test('restore preserves private incident state only for inspection, without a control surface',()=>{
 const p=JSON.parse(readFileSync(new URL('../fixtures/m8/rendered-compose.json',import.meta.url)));
 p.services['access-gateway'].environment.PI_INCIDENT_REQUESTS_DIR='/srv/incidents/requests';
 p.services['access-gateway'].volumes.push({type:'bind',source:'/var/lib/firecrawl-pi/incidents/control/requests',target:'/srv/incidents/requests',bind:{create_host_path:false}});
 const out=JSON.parse(execFileSync('jq',['-L','scripts/ops','--arg','R','/isolated','include "restore"; compose($R)'],{input:JSON.stringify(p),encoding:'utf8'}));
 assert.ok(p.services['access-gateway'].volumes.some(x=>x.target==='/srv/incidents/requests'));
 assert.ok(!out.services['access-gateway'].volumes.some(x=>x.target.startsWith('/srv/incidents')));
 assert.ok(!Object.keys(out.services['access-gateway'].environment).some(x=>x.startsWith('PI_INCIDENT_')));
 assert.equal(out.services['retrieval-service'].environment.PI_PAID_DISPATCH_ENABLED,'false');
});
