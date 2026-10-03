import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const d=realpathSync(mkdtempSync(join(tmpdir(),'fcpi-hook-')));
const tree=join(d,'tree'),input=join(d,'123abcde/redacted.json');
mkdirSync(join(d,'123abcde'));
mkdirSync(join(tree,'services/access/src'),{recursive:true});
mkdirSync(join(tree,'services/access/test'),{recursive:true});
spawnSync('git',['init','--quiet',tree]);spawnSync('git',['-C',tree,'fetch','--quiet',process.cwd(),'HEAD']);spawnSync('git',['-C',tree,'update-ref','HEAD','FETCH_HEAD']);writeFileSync(input,'{}');
// macOS realpath lacks -m. The Linux launcher uses the system realpath; this
// fixture supplies equivalent canonicalisation while the hook checks links itself.
writeFileSync(join(d,'realpath'),`#!/usr/bin/env node
const fs=require('fs'),p=require('path');let a=process.argv.slice(2);if(a[0]==='-m')a.shift();let q=p.resolve(a[0]);while(!fs.existsSync(q)){q=p.dirname(q)}console.log(p.resolve(fs.realpathSync(q),p.relative(q,p.resolve(a[0]))));
`,{mode:0o755});
function decision(tool,file,payload={file_path:file},inputPath=input) {
 const r=spawnSync('bash',['scripts/m9/incident-hook.sh'],{input:JSON.stringify({tool_name:tool,tool_input:payload}),encoding:'utf8',env:{...process.env,PATH:`${d}:${process.env.PATH}`,FCPI_INCIDENT_WORKTREE:tree,FCPI_INCIDENT_INPUT:inputPath}});
 assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
}
test('incident file guard permits bounded reads and a proposed source fix',()=>{
 assert.equal(decision('Read',input),'allow');assert.equal(decision('Edit',join(tree,'services/access/src/changes.mjs')),'allow');
 assert.equal(decision('Write',join(tree,'services/access/test/new-incident.test.mjs')),'allow');
});
test('only the native schema serialization tool may emit this incident handle',()=>{
 assert.equal(decision('StructuredOutput',null,{incident_id:'123abcde'}),'allow');
 assert.equal(decision('StructuredOutput',null,{incident_id:'ffffffff'}),'deny');
 assert.equal(decision('StructuredOutput',null,{}),'deny');
 for(const value of [12345678,['123abcde']])assert.equal(decision('StructuredOutput',null,{incident_id:value}),'deny');
 assert.equal(decision('StructuredOutput',null,{incident_id:'123abcde'},join(d,'nonhex/input.json')),'deny');
 assert.equal(decision('mcp__x__StructuredOutput',null,{incident_id:'123abcde'}),'deny');
});
test('secrets, security changes, runtime hooks and execution tools are denied',()=>{
 for(const path of ['/etc/firecrawl-pi/secrets/clients/ops.token',join(tree,'.claude/settings.json'),join(tree,'deploy/policies/budget.json'),join(tree,'services/access/src/auth.mjs'),join(tree,'services/access/src/incidents.mjs'),join(tree,'services/access/src/../src/store.mjs')]) assert.equal(decision('Write',path),'deny',path);
 for(const tool of ['Bash','Agent','Glob','mcp__x__shell'])assert.equal(decision(tool,input),'deny',tool);
 assert.equal(decision('Read',join(tree,'../../redacted.json')),'deny');
});
test('a symlink cannot expose an outside file or redirect a write',()=>{
 symlinkSync(d,join(tree,'services/access/src/link'));
 assert.equal(decision('Read',join(tree,'services/access/src/link/redacted.json')),'deny');
 assert.equal(decision('Write',join(tree,'services/access/src/link/evil.mjs')),'deny');
});
test.after(()=>rmSync(d,{recursive:true,force:true}));
