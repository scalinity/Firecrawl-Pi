// Refresh the existing canonical source snapshot, hashes and cited ranges.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
let html=readFileSync('ORCHESTRATION.html','utf8');
const blocks={};
for(const id of ['source-data','unit-data','ref-data']){
 const re=new RegExp(`(<script type="application/json" id="${id}">)([\\s\\S]*?)(</script>)`);
 const m=html.match(re);if(!m)throw Error(`Missing ${id}`);
 blocks[id]={text:m[2],data:JSON.parse(m[2]),re};
}
const old=blocks['source-data'].data,next=structuredClone(old);
for(const [key,path] of [['spec','docs/FIRECRAWL_PI_SPEC.md'],['milestones','docs/FIRECRAWL_PI_MILESTONES.md'],['agents','AGENTS.md']]){
 const text=readFileSync(path,'utf8');next[key].lines=text.trimEnd().split('\n');next[key].sha256=createHash('sha256').update(text).digest('hex');
 // Displayed hashes are separate from the data block. Replace their full or
 // abbreviated value only when the old literal occurs exactly once outside it.
 const outside=html.replace(blocks['source-data'].re,'');
 for(const size of [64,12]){
  const a=old[key].sha256.slice(0,size),b=next[key].sha256.slice(0,size);
  if(a===b)continue;const n=outside.split(a).length-1;
  if(n===1){const pos=html.indexOf(a);const dataStart=html.indexOf(blocks['source-data'].text);if(pos>=dataStart&&pos<dataStart+blocks['source-data'].text.length){const last=html.lastIndexOf(a);html=html.slice(0,last)+html.slice(last).replace(a,b);}else html=html.replace(a,b);}
  else if(n>1)throw Error('Ambiguous displayed hash');
 }
}
const refs=blocks['ref-data'].data;
for(const r of Object.values(refs)){
 const before=old[r.source]?.lines,after=next[r.source]?.lines;if(!before||!after)continue;
 const start=before[r.start-1],following=before[r.end];
 const starts=after.map((x,i)=>x===start?i:-1).filter(i=>i>=0);
 const occurrence=before.slice(0,r.start).filter(x=>x===start).length-1;
 if(starts.length!==before.filter(x=>x===start).length)throw Error(`Ambiguous citation start ${r.title}`);
 const s=starts[occurrence];let e=following===undefined?after.length:after.findIndex((x,i)=>i>=s+(r.end-r.start+1)&&x===following);
 if(e<0)throw Error(`Missing citation end ${r.title}`);
 r.start=s+1;r.end=e;
}
blocks['source-data'].data=next;
for(const id of Object.keys(blocks)){
 const b=blocks[id],serialized=JSON.stringify(b.data,null,id==='source-data'?undefined:2);
 if(JSON.stringify(JSON.parse(serialized))!==JSON.stringify(b.data))throw Error('Round trip failed');
 if((html.match(b.re)||[]).length!==4)throw Error('Block replacement mismatch');
 html=html.replace(b.re,(_,a,c,d)=>a+serialized+d);
}
writeFileSync('ORCHESTRATION.html',html);
