import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

test('operational probe counts only exact incident lifecycle notices',()=>{
  const source=readFileSync('scripts/m8/pi-fault.sh','utf8');
  const fn=source.slice(source.indexOf('notices() {'),source.indexOf('\n# OOM kills'));
  const state=mkdtempSync(join(tmpdir(),'fcpi-notices-'));
  const count=key=>execFileSync('bash',['-c',fn+'\nSTATE=$1; notices "$2"','probe',state,key],{encoding:'utf8'}).trim();
  try{
    assert.equal(count('restart_budget_or_data_service_mcp-gateway'),'0');
    const out=join(state,'alerts/outbox');mkdirSync(out,{recursive:true});
    const key='restart_budget_or_data_service_mcp-gateway';
    for(const name of [
      '20261003T100000Z-recovery_attempted-'+key+'.json',
      '20261003T100001Z-investigation_started-'+key+'.json',
      '20261003T100002Z-opened-'+key+'.json.tmp',
      '20261003T100003Z-opened-other-'+key+'.json',
      '20261003T100004Z-diagnosis_ready-other-opened-'+key+'.json',
      '20261003T100005Z-opened-'+key+'-other.json',
    ])writeFileSync(join(out,name),'{}');
    assert.equal(count(key),'0');
    writeFileSync(join(out,'20261003T100006Z-opened-'+key+'.json'),'{}');
    assert.equal(count(key),'1');
    writeFileSync(join(out,'20261003T100007Z-cleared-'+key+'.json'),'{}');
    assert.equal(count(key),'2');
    assert.equal(count('mcp*'),'0');
  }finally{rmSync(state,{recursive:true,force:true});}
});
