// Current canonical fixtures into M9-owned paths; paid/live execution is separate.
import{spawnSync,execFileSync}from'node:child_process';import{readFileSync,writeFileSync,mkdirSync,existsSync}from'node:fs';import{createHash}from'node:crypto';
const group=process.argv[2];if(!['M2','M3','M4','M5','M6','M7'].includes(group))throw Error('Choose M2..M7 fixture regression');
const base=`evidence/M9/regression/${group}/`,raw=base+'raw/';mkdirSync(raw,{recursive:true});
const env={...process.env,[`FCPI_${group}_EVIDENCE`]:base};
const phases=group==='M2'?['static','browser']:group==='M3'?['auth','sync','jobs','cancel','crash','expiry','cli']:group==='M4'?['wire','sdk','cancel','restart','stopped','tailnet']:['fixture'];
const script=group==='M2'?'scripts/m2/pi-retrieval-tests.sh':group==='M4'?'scripts/m4/mcp-e2e.mjs':`scripts/${group.toLowerCase()}/e2e.mjs`;
const t=Object.fromEntries(readFileSync('scripts/m1/pi-target.conf','utf8').split('\n').filter(l=>/^PI_\w+=/.test(l)).map(l=>[l.split('=')[0],l.slice(l.indexOf('=')+1).replace('$HOME',process.env.HOME)]));
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();const runs=[];
for(const phase of phases){
 if(group==='M2')execFileSync('ssh',['-i',t.PI_SSH_KEY,'-o','IdentitiesOnly=yes','-o','BatchMode=yes',t.PI_SSH_TARGET,'sudo -n docker exec -i fcpi-nuq-postgres-1 psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d postgres'],{input:"DELETE FROM fcpi_retrieval.domain_route WHERE domain = 'm2.fixture.fcpi.test';\n",stdio:['pipe','pipe','pipe']});
 if(group==='M3'&&phase==='auth')execFileSync('ssh',['-i',t.PI_SSH_KEY,'-o','IdentitiesOnly=yes','-o','BatchMode=yes',t.PI_SSH_TARGET,'sudo -n test -f /etc/firecrawl-pi/secrets/clients/m3rev.token || sudo -n bash /opt/firecrawl-pi/scripts/m3/pi-client-token.sh create m3rev m3-revoked read'],{stdio:'pipe'});
 const name=`raw/${group==='M2'?'rt':'e2e'}-${phase}.txt`,path=base+name;
 const command=group==='M2'?['ssh','-i',t.PI_SSH_KEY,'-o','IdentitiesOnly=yes','-o','BatchMode=yes',t.PI_SSH_TARGET,`bash -s -- ${phase}`]:[process.execPath,script,phase];
 const side=group==='M7'&&phase==='fixture'?['--also','raw/artifacts']:[];
 const r=spawnSync(process.execPath,['scripts/m9/collect-input.mjs',group,phase,name,...side,'--',...command],{input:group==='M2'?readFileSync(script):undefined,env,encoding:'utf8',timeout:2400000,maxBuffer:64*1024*1024});
 // Collector stderr is private; it can contain the actual SSH endpoint.
 const privateDir=process.env.HOME+'/.local/share/firecrawl-pi/m9/collections';mkdirSync(privateDir,{recursive:true,mode:0o700});if(r.stderr)writeFileSync(privateDir+`/${group}-${phase}-wrapper-${Date.now()}.err`,r.stderr,{mode:0o600});
 runs.push({phase,path,sha256:existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):null,exit_code:r.status??1});if(r.status!==0)break;
}
writeFileSync(base+'run.json',JSON.stringify({utc:new Date().toISOString(),source_commit:source,end_source_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),command:[script,...phases],runs},null,2)+'\n');console.log(JSON.stringify({group,runs}));process.exitCode=runs.length===phases.length&&runs.every(x=>x.exit_code===0)?0:1;
