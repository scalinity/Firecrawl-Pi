import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,writeFileSync,mkdirSync,rmSync,symlinkSync,readFileSync,copyFileSync,chmodSync,readdirSync}from'node:fs';
import{tmpdir}from'node:os';import{join}from'node:path';
import{execFileSync,spawnSync}from'node:child_process';
import{sha}from'../../scripts/m9/evidence-checks.mjs';
import{inputHash,collectorSources,collectionVerdict,codeDirty,inputKey}from'../../scripts/m9/collection.mjs';
const current='a'.repeat(40),old='b'.repeat(40),path='evidence/M9/regression/M8/raw/faults.txt';
const raw=`### meta\n{"deployed_commit":"${current}"}\n### outcome\nPASS\n`;
const span=()=>({clean:true,local:current,pi:current,pi_tree_sha256:'c'.repeat(64),pi_expected_sha256:'c'.repeat(64)});
const receipt=()=>({schema:'fcpi.collection-receipt/v1',path,sha256:sha(raw),test_id:'faults',exit_code:0,started_utc:'2026-10-03T00:00:00Z',completed_utc:'2026-10-03T00:01:00Z',before:span(),after:span(),private_record:'test.json'});
const privateProof=r=>Buffer.from(JSON.stringify({command:['controlled-producer'],receipts:[r]}));
const verdict=(r=receipt(),s=raw)=>{const bytes=privateProof(r);return collectionVerdict(path,r&&{...r,private_record_sha256:sha(bytes)},sha(s),s,x=>x===current,bytes);};
test('actual input identity binds independently of the verifier revision',()=>{
 assert.equal(verdict().bound,true);
 for(const mutate of [r=>r.before.pi=old,r=>r.before.local=old,r=>r.after.pi=old,r=>r.after.local=old,r=>r.sha256='0'.repeat(64),r=>r.path=path+'.other',r=>r.exit_code=1,r=>r.after.clean=false,r=>r.before.clean=false,r=>r.after.pi_tree_sha256='d'.repeat(64),r=>delete r.before.pi_expected_sha256,r=>r.completed_utc='2026-10-02T00:00:00Z']){const r=receipt();mutate(r);assert.equal(verdict(r).bound,false);}
 assert.equal(verdict(null).attributed,false);
 const stale=raw.replace(current,old),r=receipt();r.sha256=sha(stale);assert.equal(verdict(r,stale).bound,false);
 for(const bad of ['','not-a-commit']){const s=raw.replace(current,bad),r=receipt();r.sha256=sha(s);assert.equal(verdict(r,s).bound,false);}
});
test('private producer records cannot be missing, tampered or substituted',()=>{
 const r=receipt(),bytes=privateProof(r),signed={...r,private_record_sha256:sha(bytes)};
 for(const proof of [null,Buffer.from('tampered'),privateProof({...r,test_id:'other'})])assert.equal(collectionVerdict(path,signed,sha(raw),raw,x=>x===current,proof).bound,false);
 const changed={...signed,exit_code:1};assert.equal(collectionVerdict(path,changed,sha(raw),raw,x=>x===current,bytes).attributed,false);
});
test('soak and counter intervals bind their start and every controlled sample',()=>{
 const s=`source_commit=${current}\n### meta\n{"commit":"${current}"}\n### samples\n{"commit":"${current}"}\n{"commit":"${old}"}\n### target\ncommit=${old}\n`;
 assert.deepEqual(collectorSources(s),[current,current,current,old]);const r=receipt();r.sha256=sha(s);assert.equal(verdict(r,s).bound,false);
 assert.deepEqual(collectorSources(`### meta\nsource_commit=${current} start_source_commit=${old}\n`),[current,old]);
 for(const sample of ['{}','broken','{"commit":null}','{"commit":""}']){const v=`### samples\n${sample}\n`,r=receipt();r.sha256=sha(v);assert.equal(verdict(r,v).bound,false);}
 assert.deepEqual(collectorSources(`source_commit=${old}\n### outcome\nsource_commit=${current}\n`),[old]);
});
test('NUL porcelain rejects both code paths of staged renames and copies',()=>{
 assert.equal(codeDirty('?? evidence/M9/new\0 M evidence/M9/raw\0'),false);
 for(const s of ['R  scripts/new\0evidence/old\0','R  evidence/new\0scripts/old\0','C  evidence/new\0tests/old\0','R  evidence/new\0'])assert.equal(codeDirty(s),true);
 assert.equal(codeDirty('R  evidence/new\0evidence/old\0'),false);
 assert.equal(inputKey('evidence/M9/reboots///'),'evidence/M9/reboots');
 const r={...receipt(),path:'evidence/M9/reboots',sha256:'f'.repeat(64)},bytes=privateProof(r);
 assert.equal(collectionVerdict('evidence/M9/reboots/',{...r,private_record_sha256:sha(bytes)},r.sha256,'',x=>x===current,bytes).bound,true);
});
test('unstamped inputs need receipts; body and immutable image stamps cannot supply identity',()=>{
 const s=`### meta\nFCPI_SOURCE_COMMIT=${old}\n### target\nsource_commit=${old}\n`,r=receipt();r.sha256=sha(s);
 assert.deepEqual(collectorSources(s),[]);assert.equal(verdict(r,s).bound,true);assert.equal(verdict(null,s).bound,false);
 assert.deepEqual(collectorSources(`### static_meta\nutc=now source_commit=${current}\n### next\n`),[current]);
});
test('real wrapper preserves producer bytes, stdin, relative env and side outputs; failures invalidate receipts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fcpi-wrapper-')),root=process.cwd(),env={...process.env,HOME:join(dir,'home'),PATH:join(dir,'bin')+':'+process.env.PATH};
 const git=(...a)=>execFileSync('git',a,{cwd:dir,env,stdio:['ignore','pipe','pipe']});
 try{
  for(const d of ['services','deploy','scripts/m1','scripts/m9','tests','patches','home','bin'])mkdirSync(join(dir,d),{recursive:true});
  for(const file of ['collect-input.mjs','collection.mjs','source-observation.mjs','evidence-checks.mjs','client-proof.mjs'])copyFileSync(join(root,'scripts/m9',file),join(dir,'scripts/m9',file));
  for(const d of ['services','deploy','tests','patches'])writeFileSync(join(dir,d,'fixture'),'controlled');
  writeFileSync(join(dir,'scripts/m1/pi-target.conf'),'PI_SSH_TARGET=fixture.invalid\nPI_SSH_KEY=fixture-key\n');
  // Use the owner's existing Git identity, without changing config or identity.
  const ownerHome=process.env.HOME;env.HOME=ownerHome;git('init','-q');git('add','services','deploy','scripts','tests','patches');git('commit','-qm','test: controlled collection fixture');env.HOME=join(dir,'home');
  env.FIXTURE_SOURCE=git('rev-parse','HEAD').toString().trim();
  const files=git('ls-tree','-r','--name-only','HEAD').toString().trim().split('\n').sort();env.FIXTURE_TREE=sha(files.map(p=>sha(readFileSync(join(dir,p)))+'  '+p+'\n').join(''));
  writeFileSync(join(dir,'.gitignore'),'home/\nbin/\n.gitignore\n');
  writeFileSync(join(dir,'bin/ssh'),`#!${process.execPath}\nimport fs from 'node:fs';const f=process.env.HOME+'/calls';const n=Number(fs.existsSync(f)?fs.readFileSync(f):0)+1;fs.writeFileSync(f,String(n));if(process.env.FAIL_AFTER==='true'&&n>1)process.exit(1);console.log(process.env.FIXTURE_SOURCE);console.log(process.env.FIXTURE_TREE);\n`);chmodSync(join(dir,'bin/ssh'),0o755);
  // Node treats an extensionless executable as CommonJS, so keep the shim so.
  const shim=readFileSync(join(dir,'bin/ssh'),'utf8').replace("import fs from 'node:fs';","const fs=require('node:fs');");writeFileSync(join(dir,'bin/ssh'),shim);
  const run=(opts,script,input,extra={})=>spawnSync(process.execPath,['scripts/m9/collect-input.mjs','M8','controlled','raw/output.bin',...opts,'--',process.execPath,'-e',script],{cwd:dir,env:{...env,...extra},input});
  const producer="const fs=require('node:fs');const e=process.env.FCPI_M8_EVIDENCE;if(e!=='evidence/M9/regression/M8/')process.exit(9);fs.mkdirSync(e+'reboots',{recursive:true});fs.writeFileSync(e+'reboots/new.txt',fs.readFileSync(0));process.stdout.write(Buffer.from([0,255,128,10]));";
  const r=run(['--also','reboots'],producer,'stdin proof');assert.equal(r.status,0,r.stderr.toString());
  const base=join(dir,'evidence/M9/regression/M8'),bytes=readFileSync(join(base,'raw/output.bin'));assert.deepEqual([...bytes],[0,255,128,10]);assert.equal(readFileSync(join(base,'reboots/new.txt'),'utf8'),'stdin proof');
  const manifest=JSON.parse(readFileSync(join(base,'collection.json')));assert.equal(manifest.receipts.length,2);
  for(const receipt of manifest.receipts){const proof=readFileSync(join(env.HOME,'.local/share/firecrawl-pi/m9/collections',receipt.private_record));assert.equal(collectionVerdict(receipt.path,receipt,inputHash(join(dir,receipt.path)),'',s=>s===env.FIXTURE_SOURCE,proof).bound,true);}
  writeFileSync(join(env.HOME,'calls'),'0');const failed=run([],"process.stdout.write(Buffer.from([0,255,128,10]));",'',{FAIL_AFTER:'true'});assert.notEqual(failed.status,0);assert.equal(JSON.parse(readFileSync(join(base,'collection.json'))).receipts.some(x=>x.path.endsWith('/raw/output.bin')),false);
  assert.equal(readdirSync(join(base,'reboots')).length,1);assert.equal(readdirSync(join(base,'collection-history')).length,1);
  const reserved=spawnSync(process.execPath,['scripts/m9/collect-input.mjs','M8','bad','verification.json','--',process.execPath,'-e',''],{cwd:dir,env});assert.notEqual(reserved.status,0);
  symlinkSync(join(dir,'home'),join(base,'escape'));const escaped=spawnSync(process.execPath,['scripts/m9/collect-input.mjs','M8','bad','escape/leak','--',process.execPath,'-e',''],{cwd:dir,env});assert.notEqual(escaped.status,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('directory hashes include exact names and bytes and refuse symbolic links',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fcpi-collection-'));try{mkdirSync(join(dir,'d'));writeFileSync(join(dir,'d/a'),'one');const a=inputHash(dir);assert.equal(inputHash(dir),a);writeFileSync(join(dir,'d/a'),'two');assert.notEqual(inputHash(dir),a);symlinkSync(join(dir,'d/a'),join(dir,'link'));assert.throws(()=>inputHash(dir),/symlink/);}finally{rmSync(dir,{recursive:true,force:true});}
});
