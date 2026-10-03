import{execFileSync}from'node:child_process';
import{readFileSync,mkdtempSync,readdirSync,lstatSync,rmSync}from'node:fs';
import{join}from'node:path';import{tmpdir,homedir}from'node:os';
import{sha}from'./evidence-checks.mjs';import{codeDirty}from'./collection.mjs';
const git=(...a)=>execFileSync('git',a,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const dirs=['services','deploy','scripts','tests','patches'],expected=new Map();
function expectedTree(commit){
 if(expected.has(commit))return expected.get(commit);
 const temp=mkdtempSync(join(tmpdir(),'fcpi-source-'));
 try{execFileSync('tar',['-xf','-','-C',temp],{input:execFileSync('git',['archive',commit,...dirs],{maxBuffer:128*1024*1024})});const paths=[];
  const walk=d=>{for(const name of readdirSync(join(temp,d))){const p=join(d,name),s=lstatSync(join(temp,p));if(s.isDirectory())walk(p);else if(s.isFile())paths.push(p);else throw Error('Unsupported deployed source entry');}};
  dirs.forEach(walk);if(paths.some(p=>/[\n\\]/.test(p)))throw Error('Unsupported source filename');const digest=sha(paths.sort().map(p=>sha(readFileSync(join(temp,p)))+'  '+p+'\n').join(''));expected.set(commit,digest);return digest;
 }finally{rmSync(temp,{recursive:true,force:true});}
}
export function sourceObservation(){
 const t=Object.fromEntries(readFileSync('scripts/m1/pi-target.conf','utf8').split('\n').filter(l=>/^PI_\w+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).replace('$HOME',homedir())]));
 const probe=`set -euo pipefail
cat /opt/firecrawl-pi/.fcpi-source-commit
cd /opt/firecrawl-pi
[ -z "$(find services deploy scripts tests patches ! -type f ! -type d -print -quit)" ]
LC_ALL=C find services deploy scripts tests patches -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64
`;
 let output,error;for(let i=0;i<3;i++){try{output=execFileSync('ssh',['-i',t.PI_SSH_KEY,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=15',t.PI_SSH_TARGET,'bash -s'],{input:probe,encoding:'utf8',timeout:60000,stdio:['pipe','pipe','pipe']}).trim().split('\n');break;}catch(e){error=e;}}
 if(!output||output.length!==2||! /^[0-9a-f]{40}$/.test(output[0])||! /^[0-9a-f]{64}$/.test(output[1]))throw error??Error('Deployed source observation invalid');
 const local=git('rev-parse','HEAD'),pi=output[0],pi_tree_sha256=output[1],pi_expected_sha256=expectedTree(pi);
 return {local,pi,pi_tree_sha256,pi_expected_sha256,clean:!codeDirty(execFileSync('git',['status','--porcelain=v1','-z','--untracked-files=all'],{encoding:'utf8'}))&&pi_tree_sha256===pi_expected_sha256};
}
