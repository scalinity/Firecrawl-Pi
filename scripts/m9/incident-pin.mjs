// Trusted fixed metadata update; agent tools cannot modify these files.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [access,retrieval,code]=process.argv.slice(2);
if(![access,retrieval].every(x=>/^sha256:[0-9a-f]{64}$/.test(x))||! /^[0-9a-f]{40}$/.test(code))throw Error('Invalid immutable image/source');
let compose=readFileSync('/tree/deploy/compose.yaml','utf8');
const lock=JSON.parse(readFileSync('/tree/deploy/versions.lock.json'));
for(const [key,tag,id,dir] of [['access_gateway','access-gateway',access,'access'],['retrieval','retrieval',retrieval,'retrieval']]){
 const re=new RegExp(`image: fcpi/${tag}@sha256:[0-9a-f]{64}`,'g');
 if([...compose.matchAll(re)].length!==1)throw Error('Image pin must occur once');
 compose=compose.replace(re,`image: fcpi/${tag}@${id}`);
 const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
 lock.images[key]={...lock.images[key],image_id:id,built_from_commit:code,platform:'linux/arm64',dockerfile:{path:`services/${dir}/Dockerfile`,sha256:hash(`/tree/services/${dir}/Dockerfile`)},evidence:'private incident release state; owner-approved exact patch'};
}
writeFileSync('/tree/deploy/compose.yaml',compose);
writeFileSync('/tree/deploy/versions.lock.json',JSON.stringify(lock,null,2)+'\n');
