// Reuse the canonical fixture producers/verifiers into M9-owned paths. This never
// overwrites accepted M0-M8 records. Paid/live providers are a separate held phase.
import{spawnSync,execFileSync}from'node:child_process';import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{createHash}from'node:crypto';
const group=process.argv[2];if(!['M4','M5','M6','M7'].includes(group))throw Error('Choose M4, M5, M6 or M7 fixture regression');
const base=`evidence/M9/regression/${group}/`,raw=base+'raw/';mkdirSync(raw,{recursive:true});
const env={...process.env,[`FCPI_${group}_EVIDENCE`]:base};
const phases=group==='M4'?['wire','sdk','cancel','restart','stopped','tailnet']:['fixture'];
const script=group==='M4'?'scripts/m4/mcp-e2e.mjs':`scripts/${group.toLowerCase()}/e2e.mjs`;
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();const runs=[];
for(const phase of phases){const r=spawnSync(process.execPath,[script,phase],{env,encoding:'utf8',timeout:1200000,maxBuffer:64*1024*1024});const path=raw+`e2e-${phase}.txt`;writeFileSync(path,r.stdout??'');const stderr=r.stderr??'';if(stderr)writeFileSync(raw+`stderr-${phase}.txt`,stderr.replaceAll(process.env.HOME,'<home>'));runs.push({phase,path,sha256:createHash('sha256').update(r.stdout??'').digest('hex'),exit_code:r.status??1});if(r.status!==0)break;}
writeFileSync(base+'run.json',JSON.stringify({utc:new Date().toISOString(),source_commit:source,end_source_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),command:[script,...phases],runs},null,2)+'\n');console.log(JSON.stringify({group,runs}));process.exitCode=runs.length===phases.length&&runs.every(x=>x.exit_code===0)?0:1;
