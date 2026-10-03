// Current canonical fixtures into M9-owned paths; paid/live execution is separate.
import{spawnSync,execFileSync}from'node:child_process';import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{createHash}from'node:crypto';
const group=process.argv[2];if(!['M2','M3','M4','M5','M6','M7'].includes(group))throw Error('Choose M2..M7 fixture regression');
const base=`evidence/M9/regression/${group}/`,raw=base+'raw/';mkdirSync(raw,{recursive:true});
const env={...process.env,[`FCPI_${group}_EVIDENCE`]:base};
const phases=group==='M2'?['static','browser']:group==='M3'?['auth','sync','jobs','cancel','crash','expiry','cli']:group==='M4'?['wire','sdk','cancel','restart','stopped','tailnet']:['fixture'];
const script=group==='M2'?'scripts/m2/pi-retrieval-tests.sh':group==='M4'?'scripts/m4/mcp-e2e.mjs':`scripts/${group.toLowerCase()}/e2e.mjs`;
const t=Object.fromEntries(readFileSync('scripts/m1/pi-target.conf','utf8').split('\n').filter(l=>/^PI_\w+=/.test(l)).map(l=>[l.split('=')[0],l.slice(l.indexOf('=')+1).replace('$HOME',process.env.HOME)]));
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();const runs=[];
for(const phase of phases){
 const r=group==='M2'?spawnSync('ssh',['-i',t.PI_SSH_KEY,'-o','IdentitiesOnly=yes','-o','BatchMode=yes',t.PI_SSH_TARGET,`bash -s -- ${phase}`],{input:readFileSync(script),env,encoding:'utf8',timeout:1200000,maxBuffer:64*1024*1024}):spawnSync(process.execPath,[script,phase],{env,encoding:'utf8',timeout:1800000,maxBuffer:64*1024*1024});
 const path=raw+`${group==='M2'?'rt':'e2e'}-${phase}.txt`;writeFileSync(path,r.stdout??'');const stderr=r.stderr??'';if(stderr)writeFileSync(raw+`stderr-${phase}.txt`,stderr.replaceAll(process.env.HOME,'<home>').replaceAll(t.PI_SSH_TARGET,'<pi-ssh-target>'));runs.push({phase,path,sha256:createHash('sha256').update(r.stdout??'').digest('hex'),exit_code:r.status??1});if(r.status!==0)break;
}
writeFileSync(base+'run.json',JSON.stringify({utc:new Date().toISOString(),source_commit:source,end_source_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),command:[script,...phases],runs},null,2)+'\n');console.log(JSON.stringify({group,runs}));process.exitCode=runs.length===phases.length&&runs.every(x=>x.exit_code===0)?0:1;
