import test from 'node:test';import assert from 'node:assert/strict';import{mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{spawnSync}from'node:child_process';import{createHash}from'node:crypto';
test('large diagnostic projections stay readable and disclose omitted evidence',()=>{
 const d=mkdtempSync(join(tmpdir(),'fcpi-diag-'));
 try{
  writeFileSync(join(d,'REDACTION.txt'),'secret values checked: 50; files carrying one: 0\n');
  const content='first observation\n'+'⚠ diagnostic data\n'.repeat(10000)+'last observation\n';
  writeFileSync(join(d,'status.json'),content);mkdirSync(join(d,'containers'));
  for(let i=0;i<100;i++)writeFileSync(join(d,'containers/'+String(i).padStart(3,'0')+'.log'),content);
  const args=['scripts/m9/incident-input.sh',d,'123abcde','a'.repeat(40),'b'.repeat(64)];
  const r=spawnSync('bash',args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.ok(Buffer.byteLength(r.stdout)<=20480);
  assert.ok(r.stdout.split('\n').length<=1001);assert.ok(r.stdout.split('\n').every(l=>l.length<2000));
  const x=JSON.parse(r.stdout),s=x.diagnostics.find(f=>f.name==='status.json');
  assert.equal(x.original_files,102);assert.ok(x.omitted_excerpts>0);assert.equal(x.diagnostics.length+x.omitted_files,102);assert.equal(x.bundle_sha256,'b'.repeat(64));
  const sha=b=>createHash('sha256').update(b).digest('hex'),names=['REDACTION.txt','status.json',...Array.from({length:100},(_,i)=>'containers/'+String(i).padStart(3,'0')+'.log')].sort();
  assert.equal(x.full_manifest_sha256,sha(names.map(n=>sha(readFileSync(join(d,n)))+'  '+n+'\n').join('')));
  assert.equal(s.original_bytes,Buffer.byteLength(content));assert.equal(s.sha256,createHash('sha256').update(content).digest('hex'));assert.equal(s.truncated,true);
  assert.ok(s.content_lines.join('\n').includes('first observation')&&s.content_lines.join('\n').includes('last observation'));assert.match(x.trust,/incomplete/);assert.equal(x.diagnostics[0].name,'status.json');
  const firstOmitted=x.diagnostics.findIndex(f=>f.excerpt_omitted);assert.ok(x.diagnostics.slice(firstOmitted).every(f=>f.excerpt_omitted));
  for(const marker of ['redaction failed\n','prefix secret values checked: 50; files carrying one: 0 suffix\n']){writeFileSync(join(d,'REDACTION.txt'),marker);const bad=spawnSync('bash',args,{encoding:'utf8'});assert.notEqual(bad.status,0);assert.equal(bad.stdout,'');}
  const missing=spawnSync('bash',[...args.slice(0,1),join(d,'missing'),...args.slice(2)],{encoding:'utf8'});assert.notEqual(missing.status,0);assert.equal(missing.stdout,'');
 }finally{rmSync(d,{recursive:true,force:true});}
});
