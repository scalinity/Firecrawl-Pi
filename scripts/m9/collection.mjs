import{readFileSync,readdirSync,lstatSync}from'node:fs';
import{join,relative}from'node:path';
import{sha}from'./evidence-checks.mjs';

export function inputHash(path){
 const st=lstatSync(path);if(st.isSymbolicLink())throw Error('Evidence symlink refused');
 if(st.isFile())return sha(readFileSync(path));
 if(!st.isDirectory())throw Error('Unsupported evidence input');
 const entries=[];
 const walk=dir=>{for(const name of readdirSync(dir).sort()){const p=join(dir,name),s=lstatSync(p);if(s.isSymbolicLink())throw Error('Evidence symlink refused');if(s.isDirectory())walk(p);else if(s.isFile())entries.push([relative(path,p),sha(readFileSync(p))]);else throw Error('Unsupported evidence input');}};
 walk(path);return sha(JSON.stringify(entries));
}
export function collectorSources(raw){
 // Preamble, first controlled metadata and soak samples. Target content and
 // immutable image build stamps in other frames are not collector identities.
 const parts=raw.split(/^### /m),first=parts[1]??'',blocks=[parts[0]];
 if(/^(?:meta|[a-z0-9]+_meta)\r?\n/.test(first))blocks.push(first);
 const sources=blocks.flatMap(b=>[...b.matchAll(/(?<![A-Za-z_])(?:source_commit|end_source_commit|start_source_commit|deployed_commit|commit)[=":]+"?([^\s",]*)/g)].map(x=>x[1]));
 for(const frame of parts.slice(1))if(/^samples\r?\n/.test(frame))for(const line of frame.split('\n').slice(1)){if(!line.trim())continue;try{const r=JSON.parse(line);sources.push(r.commit??'unparsed-sample');}catch{sources.push('unparsed-sample');}}
 return sources;
}
export function codeDirty(status){
 const entries=status.split('\0');for(let i=0;i<entries.length;i++){const row=entries[i];if(!row)continue;const paths=[row.slice(3)];if(/[RC]/.test(row.slice(0,2)))paths.push(entries[++i]??'');if(paths.some(p=>!p.startsWith('evidence/')))return true;}return false;
}
export const inputKey=p=>p.replace(/\/+$/,'');
export function collectionVerdict(input,receipt,digest,raw,sameCode,privateBytes){
 const sources=receipt?[receipt.before?.local,receipt.before?.pi,receipt.after?.local,receipt.after?.pi]:[];
 let privateBound=false;try{privateBound=!!privateBytes&&sha(privateBytes)===receipt?.private_record_sha256&&JSON.stringify(JSON.parse(privateBytes).receipts.find(r=>r.path===inputKey(input)))===JSON.stringify(Object.fromEntries(Object.entries(receipt).filter(([k])=>k!=='private_record_sha256')));}catch{}
 const spans=receipt?[receipt.before,receipt.after]:[];
 const attributed=receipt?.schema==='fcpi.collection-receipt/v1'&&receipt.path===inputKey(input)&&receipt.sha256===digest&&receipt.exit_code===0&&privateBound&&
  spans.every(s=>s.clean===true&&/^[0-9a-f]{64}$/.test(s.pi_tree_sha256??'')&&s.pi_tree_sha256===s.pi_expected_sha256)&&
  typeof receipt.test_id==='string'&&receipt.test_id.length>0&&Number.isFinite(Date.parse(receipt.started_utc))&&Number.isFinite(Date.parse(receipt.completed_utc))&&
  Date.parse(receipt.completed_utc)>=Date.parse(receipt.started_utc)&&sources.length===4&&sources.every(x=>/^[0-9a-f]{40}$/.test(x??''));
 const exercised=collectorSources(raw??'');
 return {attributed,bound:attributed&&[...sources,...exercised].every(x=>/^[0-9a-f]{40}$/.test(x??'')&&sameCode(x)),collector_sources:sources,embedded_sources:exercised,metadata_scope:'preamble/first-metadata/soak-samples'};
}
