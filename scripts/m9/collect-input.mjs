// A real collector invocation, sequential within each group. --written means
// the producer writes its primary output; --also receipts its side outputs.
import{spawnSync}from'node:child_process';
import{readFileSync,writeFileSync,mkdirSync,existsSync,renameSync,lstatSync}from'node:fs';
import{resolve,dirname,join,relative}from'node:path';import{homedir}from'node:os';
import{inputHash}from'./collection.mjs';import{sourceObservation}from'./source-observation.mjs';import{sha}from'./evidence-checks.mjs';
const args=process.argv.slice(2),sep=args.indexOf('--'),[group,id,name]=args.slice(0,3),command=args.slice(sep+1);let written=false;const extra=[];
if(!/^M[2-8]$/.test(group??'')||! /^[A-Za-z0-9_.:-]+$/.test(id??'')||sep<3||!command.length)throw Error('group test-id relative-output [--written] [--also output] -- command args required');
for(let i=3;i<sep;i++){if(args[i]==='--written'&&!written)written=true;else if(args[i]==='--also'&&i+1<sep)extra.push(args[++i]);else throw Error('Unsupported collector option');}
const rel='evidence/M9/regression/'+group+'/',base=resolve(rel);
function destination(name){const path=resolve(base,name??'');if(!path.startsWith(base+'/')||/^(collection\.json|verification\.json|verification-history|collection-history)(\/|$)/.test(relative(base,path)))throw Error('Reserved or external output');
 let parent=process.cwd();for(const part of relative(parent,dirname(path)).split('/')){parent=join(parent,part);if(existsSync(parent)){if(lstatSync(parent).isSymbolicLink()||!lstatSync(parent).isDirectory())throw Error('Unsafe collector parent');}else mkdirSync(parent);}if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw Error('Output symlink refused');return path;}
const paths=[destination(name),...extra.map(destination)];if(new Set(paths).size!==paths.length)throw Error('Duplicate collector output');
const started_utc=new Date().toISOString(),before=sourceObservation();if(!before.clean)throw Error('Commit and deploy clean source before collecting');
const manifest=join(base,'collection.json'),old=existsSync(manifest)?JSON.parse(readFileSync(manifest,'utf8')):{receipts:[]},keys=paths.map(p=>relative(process.cwd(),p));
const remaining=old.receipts.filter(x=>!keys.includes(x.path));writeFileSync(manifest,JSON.stringify({schema:'fcpi.collection/v1',receipts:remaining},null,2)+'\n');
if(existsSync(paths[0])){mkdirSync(join(base,'collection-history'),{recursive:true});renameSync(paths[0],join(base,'collection-history',Date.now()+'-'+paths[0].split('/').at(-1)));}
const r=spawnSync(command[0],command.slice(1),{env:{...process.env,['FCPI_'+group+'_EVIDENCE']:rel},stdio:['inherit','pipe','pipe'],timeout:10800000,maxBuffer:128*1024*1024});
if(!written)writeFileSync(paths[0],r.stdout??Buffer.alloc(0));
const after=sourceObservation(),completed_utc=new Date().toISOString(),privateDir=join(homedir(),'.local/share/firecrawl-pi/m9/collections');mkdirSync(privateDir,{recursive:true,mode:0o700});
const private_record=group+'-'+id+'-'+Date.now()+'.json';
const receipts=paths.map((path,i)=>({schema:'fcpi.collection-receipt/v1',path:keys[i],test_id:id,started_utc,completed_utc,before,after,exit_code:r.status??1,sha256:existsSync(path)?inputHash(path):null,private_record}));
const bytes=JSON.stringify({command,stdout_base64:written?r.stdout?.toString('base64'):undefined,stderr_base64:r.stderr?.toString('base64'),error:r.error?.message,receipts});writeFileSync(join(privateDir,private_record),bytes,{mode:0o600});
writeFileSync(manifest,JSON.stringify({schema:'fcpi.collection/v1',receipts:[...remaining,...receipts.map(r=>({...r,private_record_sha256:sha(bytes)}))]},null,2)+'\n');
console.log(JSON.stringify({test_id:id,exit_code:r.status??1,before,after}));process.exitCode=r.status??1;
