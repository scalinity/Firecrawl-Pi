// Post-M9 hosted secret scan: positive controls, current live-secret hashes, exact classified
// code/fixture exceptions and hashes of every inspected repository file.
import{execFileSync}from'node:child_process';import{readFileSync,writeFileSync,existsSync}from'node:fs';import{createHash}from'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex'),read=p=>readFileSync(p,'utf8');
const t=Object.fromEntries(read('scripts/m1/pi-target.conf').split('\n').filter(l=>/^PI_\w+=/.test(l)).map(l=>[l.split('=')[0],l.slice(l.indexOf('=')+1).replace('$HOME',process.env.HOME)]));
const command=String.raw`sudo -n bash -s`;
// Later post-M9 work scans its own evidence directory and the files changed since its base commit.
const evidence=process.env.FCPI_REDACTION_EVIDENCE??'evidence/post-m9/hosted-mcp';
// Values remain on the Pi. Only distinct SHA-256 values are returned.
const extraction=String.raw`set -euo pipefail
S=/etc/firecrawl-pi/secrets
h(){ [ -n "$1" ]; printf '%s' "$1" | sha256sum | cut -c1-64; }
for f in "$S"/postgres_password "$S"/core_postgres_password "$S"/retrieval_postgres_password "$S"/core_retrieval_token "$S"/retrieval_browser_token "$S"/gateway_postgres_password "$S"/gateway_retrieval_token "$S"/searxng_proxy_password "$S"/searxng_secret_key "$S"/webhook_signing_secret /srv/firecrawl-pi/data/rabbitmq/.erlang.cookie; do h "$(cat "$f")"; done
h "$(sed -n 's#^amqp://fcpi:\(.*\)@rabbitmq:5672$#\1#p' "$S/core_nuq_rabbitmq_url")"
h "$(sed -n 's#^redis://[^:]*:\(.*\)@redis:6379$#\1#p' "$S/core_redis_url")"
for f in /etc/firecrawl-pi/hosted-mcp/openai-runtime-key /etc/firecrawl-pi/hosted-mcp/openai-mcp-auth; do
 [ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] && [ -s "$f" ] || { echo 'Mandatory hosted credential inventory unavailable' >&2; exit 75; }
 v=$(tr -d '\n' <"$f"); [ -n "$v" ] || exit 75
 case "$f" in */openai-runtime-key) printf 'hosted-runtime-key=';; */openai-mcp-auth) printf 'hosted-mcp-auth=';; esac
 h "$v"
 case "$f" in */openai-mcp-auth) case "$v" in 'Bearer '?*) h "${'${v#Bearer }'}";; *) exit 75;; esac;; esac
 done
for f in "$S"/providers/* "$S"/clients/*.token "$S"/backup/*password "$S"/alerts/*; do
 [ -f "$f" ] || continue
 v=$(tr -d '\n' <"$f"); h "$v"
 case "$v" in 'Bearer '*) h "${'${v#Bearer }'}";; esac
 case "$v" in *:*) h "${'${v#*:}'}";; esac
done`;
const secretText=execFileSync('ssh',['-i',t.PI_SSH_KEY,'-o','IdentitiesOnly=yes','-o','BatchMode=yes',t.PI_SSH_TARGET,command],{input:extraction,encoding:'utf8'});
const inventory=secretText.trim().split('\n');
const tagged=Object.fromEntries(['hosted-runtime-key','hosted-mcp-auth'].map(k=>{
 const rows=inventory.filter(x=>x.startsWith(k+'='));
 if(rows.length!==1||!/^[0-9a-f]{64}$/.test(rows[0].slice(k.length+1)))throw Error('Mandatory hosted hash inventory incomplete');
 return[k,rows[0].slice(k.length+1)];
}));
const hashes=inventory.map(x=>x.includes('=')?x.slice(x.indexOf('=')+1):x);
if(hashes.length<30||hashes.some(x=>! /^[0-9a-f]{64}$/.test(x)))throw Error('Live hash inventory incomplete');const secrets=new Set(hashes);
// Preserve whole tokens (including base64 padding), and inspect ordinary assignments,
// header prefixes and URL userinfo separately. Never emit the candidate values.
function candidates(line){
 const result=new Set(line.match(/[A-Za-z0-9+/_=:.@%-]{8,}/g)??[]);
 for(const value of [...result]){
  for(let i=0;i<value.length;i++)if('=:@'.includes(value[i]))result.add(value.slice(i+1));
  for(const part of value.split(/[=:@]/))if(part.length>=8)result.add(part);
  if(value.includes('://'))try{const u=new URL(value);for(const part of[u.username,u.password])if(part){result.add(part);try{result.add(decodeURIComponent(part))}catch{}}}catch{}
 }
 return result;
}

const rules=[['private-key',/-----BEGIN [A-Z ]*PRIVATE KEY-----/g],['token',/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/g],['jwt',/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],['bearer',/Bearer\s+[A-Za-z0-9._~+/-]{20,}/g],['client-token',/\bfcpi_[a-z0-9]+_[0-9a-f]{32,}\b/g],['url-credentials',/[a-z][a-z0-9+.-]*:\/\/[^\s/:@<]+:[^\s/@]+@/g],['tailnet-name',/\b[a-z0-9-]+\.ts\.net\b/gi],['tailnet-address',/(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?![\d.\/])|\bfd7a:115c:a1e0::[0-9a-f]{1,4}:[0-9a-f]{1,4}\b/gi],['local-path',/\/(?:Users\/[^/\s]+|home\/[^/\s]+|private\/tmp)\/[^\s"'`]+/g]];
const controls=['tests/contracts/m0-redaction-control.txt','tests/contracts/m1-redaction-control.txt','tests/contracts/m3-redaction-control.txt','tests/contracts/m8-redaction-control.txt'];
const controlSecrets=new Set([sha('0f'.repeat(32)),sha('ABCDEFGHIJKLMNOP'.repeat(4)),sha('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2')]);
const positive=controls.map(path=>({path,sha256:sha(read(path)),hits:[...rules.flatMap(([name,re])=>[...read(path).matchAll(re)].map(()=>name)),...(read(path).match(/[A-Za-z0-9+/_=:.@%-]{8,}/g)??[]).filter(v=>controlSecrets.has(sha(v))).map(()=>'live-secret-hash')]}));if(positive.some(x=>!x.hits.length))throw Error('Redaction positive control silent');
const prefixedControls=[...controlSecrets].flatMap((expected,i)=>{
 const value=['0f'.repeat(32),'ABCDEFGHIJKLMNOP'.repeat(4),'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2'][i];
 return [['assignment','PASSWORD='+value],['header','password:'+value],['url','https://fixture:'+value+'@fixture.invalid/']].map(([kind,input])=>({kind,input_sha256:sha(input),detected:[...candidates(input)].some(v=>sha(v)===expected)}));
});
if(prefixedControls.some(x=>!x.detected))throw Error('Prefixed live-hash positive control silent');
const classificationsPath=evidence+'/redaction-classifications.json';
// A classification names an exact value in a file, so earlier post-M9 work's still holds for a later scan.
const classifications=[...JSON.parse(read('evidence/M9/work/redaction-classifications.json')),...[...new Set(['evidence/post-m9/hosted-mcp/redaction-classifications.json',classificationsPath])].filter(existsSync).flatMap(p=>JSON.parse(read(p)))];
const output=evidence+'/redaction.json';
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8'}).split('\n').filter(x=>x&&existsSync(x)&&!controls.includes(x)&&x!==output&&!['evidence/M9/redaction.json','evidence/M9/acceptance.json','evidence/M9/corpus-v2/redaction.json','evidence/M9/corpus-v2/acceptance.json'].includes(x)&&! /\.(?:png|jpg|pdf|gz|bundle)$/.test(x));
const hits=[],real=[];const inputs=[];
for(const path of files){const bytes=readFileSync(path);if(bytes.includes(0))continue;inputs.push({path,sha256:sha(bytes)});const content=bytes.toString('utf8');content.split('\n').forEach((line,i)=>{
 for(const[name,re]of rules)for(const m of line.matchAll(re)){const h={path,line:i+1,rule:name,value_sha256:sha(m[0])};const c=classifications.find(c=>c.path===path&&c.rule===name&&c.value_sha256===h.value_sha256&&['code_construct','synthetic_fixture','functional_owner_path'].includes(c.kind));hits.push({...h,classification:c?.kind??null});}
 // Both whole tokens and secret substrings (proxy password parts included).
 for(const v of candidates(line))if(secrets.has(sha(v)))real.push({path,line:i+1,rule:'live-secret-hash'});
});}
const changed=execFileSync('git',['diff','--name-only',process.env.FCPI_REDACTION_BASE??'311069d8bae453f29894f09f8e577ff25e9d21f8'],{encoding:'utf8'}).split('\n').filter(x=>x&&existsSync(x));
for(const path of [...new Set([...changed,...files.filter(x=>x.startsWith(evidence+'/'))])])if(path!=='scripts/m1/pi-target.conf'&&[t.PI_SSH_TARGET,t.PI_SSH_TARGET.split('@').at(-1),t.PI_LAN_ADDRESS,t.PI_SSH_KEY].some(v=>read(path).includes(v)))real.push({path,rule:'real-private-endpoint'});
const out={schema:'fcpi.hosted-redaction/v1',utc:new Date().toISOString(),source_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),positive_controls:positive.length,controls:positive,prefixed_live_hash_controls:prefixedControls,live_secret_hashes:secrets.size,extraction_sha256:sha(extraction),hosted_runtime_key_hash_included:secrets.has(tagged['hosted-runtime-key']),hosted_mcp_auth_hash_included:secrets.has(tagged['hosted-mcp-auth']),real_secret_hits:real,unclassified_hits:hits.filter(x=>!x.classification),classified_hits:hits.filter(x=>x.classification),inputs,limits:'Checks whole tokens and ordinary assignment, header and URL credential components; arbitrary transformed or truncated encodings are not proven.',state:real.length||hits.some(x=>!x.classification)?'FAIL':'PASS'};
writeFileSync(output,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify({state:out.state,files:inputs.length,secret_hashes:secrets.size,real_hits:real.length,unclassified:out.unclassified_hits.length}));process.exitCode=out.state==='PASS'?0:1;
