import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function probe(args, { url='redis://fcpi_core:synthetic-core-password@redis:6379', ops=true }={}) {
  const dir=mkdtempSync(join(tmpdir(),'fcpi-redis-'));
  try {
    writeFileSync(join(dir,'sudo'),`#!/usr/bin/env bash
shift
case $1 in
 test) [ "$OPS" = yes ] ;;
 cat) printf '%s' synthetic-ops-password ;;
 sed) printf '%s\\n' "$URL" | sed "$2" "$3" ;;
 docker)
   shift
   case $1 in
     compose) echo fixture-container ;;
     exec) shift 3; exec "$@" ;;
     *) exit 3 ;;
   esac ;;
 *) exit 3 ;;
esac
`,{mode:0o755});
    writeFileSync(join(dir,'redis-cli'),`#!/usr/bin/env bash
printf '%s\\n' "$*"
[ "$REDISCLI_AUTH" = synthetic-ops-password ] && echo password=ops
[ "$REDISCLI_AUTH" = synthetic-core-password ] && echo password=core
exit 0
`,{mode:0o755});
    return spawnSync('bash',['scripts/ops/redis-cli.sh',...args],{encoding:'utf8',env:{...process.env,PATH:`${dir}:${process.env.PATH}`,URL:url,OPS:ops?'yes':'no'}});
  } finally { rmSync(dir,{recursive:true,force:true}); }
}
test('INFO uses the operator without the password in argv',()=>{
  const r=probe(['INFO','persistence']);assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/--user fcpi_ops INFO persistence/);assert.match(r.stdout,/password=ops/);
  assert.doesNotMatch(r.stdout,/synthetic-(ops|core)-password/);
});
test('key scans and fixture writes use the narrowed core user',()=>{
  for(const args of [['--scan','--pattern','crawl:fixture*'],['SET','fcpi:m9:test','fixture']]){
    const r=probe(args);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/--user fcpi_core/);assert.match(r.stdout,/password=core/);
  }
});
test('the preserved pre-M8 deployment remains readable',()=>{
  const r=probe(['INFO','persistence'],{ops:false,url:'redis://:synthetic-core-password@redis:6379'});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/--user default/);assert.match(r.stdout,/password=core/);
});
test('unexpected users and missing passwords fail closed',()=>{
  assert.notEqual(probe(['GET','x'],{url:'redis://administrator:synthetic-core-password@redis:6379'}).status,0);
  assert.notEqual(probe(['GET','x'],{url:'not-a-url'}).status,0);
});
