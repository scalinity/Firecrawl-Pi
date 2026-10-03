// M9 global onboarding: preserve unrelated servers; no token in argv, config,
// Git, output or logs. Native config commands receive only the private endpoint
// and a keychain header helper. Fresh real-client calls are verified separately.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync,chmodSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
const root=resolve(import.meta.dirname,'../..');
const conf=Object.fromEntries(readFileSync(join(root,'scripts/m1/pi-target.conf'),'utf8').split('\n').filter(l=>/^PI_\w+=/.test(l)).map(l=>[l.split('=')[0],l.slice(l.indexOf('=')+1).replace('$HOME',process.env.HOME)]));
const run=(bin,args,extra={})=>{try{return execFileSync(bin,args,{encoding:'utf8',maxBuffer:8*1024*1024,stdio:['pipe','pipe','pipe'],...extra});}catch(e){throw new Error(`Private configuration operation failed: ${bin.split('/').at(-1)} exit ${e.status ?? 'unknown'}; output withheld`);}};
const pi=cmd=>run('ssh',['-i',conf.PI_SSH_KEY,'-o','IdentitiesOnly=yes','-o','BatchMode=yes',conf.PI_SSH_TARGET,cmd]);
const origin=pi('sudo -n cat /etc/firecrawl-pi/secrets/gateway/served-origins').split('\n').find(l=>l.startsWith('https://'));
const endpoint=origin+'/mcp';
const u=new URL(endpoint);if(u.protocol!=='https:'||!u.hostname.endsWith('.ts.net')||u.pathname!=='/mcp'||u.search)throw new Error('No accepted private endpoint');
const helper=join(root,'scripts/m9/mcp-headers.sh');
const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
const claudeFile=join(process.env.HOME,'.claude.json'),codexFile=join(process.env.HOME,'.codex/config.toml');
const beforeClaude=JSON.parse(readFileSync(claudeFile)),beforeCodex=JSON.parse(run('codex',['mcp','list','--json']));
const expectedClaude={type:'http',url:endpoint,headersHelper:`${q(helper)} claude`};
if(beforeClaude.mcpServers?.fcpi && !isDeepStrictEqual(beforeClaude.mcpServers.fcpi,expectedClaude))throw new Error('Existing fcpi configuration differs; deliberate change required');
const existingCodex=beforeCodex.find(x=>x.name==='fcpi');
// Codex deliberately redacts the helper in `mcp list`; compare its private
// generated TOML value directly, without printing it.
const privateCodex=readFileSync(codexFile,'utf8');
const privateBlock=/^\[mcp_servers\.fcpi\]\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(privateCodex)?.[1];
const privateHelper=privateBlock?.match(/^http_headers_helper = (".*")$/m)?.[1];
if(existingCodex && (existingCodex.transport.url!==endpoint || (privateHelper && JSON.parse(privateHelper)!==q(helper)+' codex')))throw new Error('Existing Codex fcpi configuration differs; deliberate change required');
for(const client of ['claude','codex','desktop']){
 const label=`m9${client}`;
 if(pi(`sudo -n test -f /etc/firecrawl-pi/secrets/clients/${label}.token && echo yes || echo no`).trim()==='no')
  pi(`sudo -n bash /opt/firecrawl-pi/scripts/m3/pi-client-token.sh create ${label} owner read,scrape,crawl,batch,map,cancel,search,extract`);
 const token=pi(`sudo -n cat /etc/firecrawl-pi/secrets/clients/${label}.token`).trim();
 if(!new RegExp(`^fcpi_${label}_[0-9a-f]{64}$`).test(token))throw new Error('Invalid client token');
 let old=null;try{old=run('/usr/bin/security',['find-generic-password','-a','fcpi','-s',`fcpi mcp ${client}`,'-w'],{stdio:['pipe','pipe','pipe']}).trim();}catch{}
 if(old!==null && old!==token)throw new Error('Existing keychain value differs; deliberate rotation required');
 if(old===null)run('/usr/bin/security',['-i'],{input:`add-generic-password -a fcpi -s "fcpi mcp ${client}" -l "Firecrawl Pi ${client} MCP" -w ${token}\n`,stdio:['pipe','pipe','pipe']});
}
if(!beforeClaude.mcpServers?.fcpi)run('claude',['mcp','add-json','--scope','user','fcpi',JSON.stringify(expectedClaude)]);
if(!existingCodex)run('codex',['mcp','add','fcpi','--url',endpoint]);
const current=readFileSync(codexFile,'utf8');
const section=/^\[mcp_servers\.fcpi\]\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(current);
if(!section)throw new Error('Native Codex configuration missing');
const replacement=section[0].trimEnd()+`\nhttp_headers_helper = ${JSON.stringify(q(helper)+' codex')}\n\n`;
if(!privateHelper){const after=current.replace(section[0],()=>replacement),tmp=codexFile+'.fcpi-new';
writeFileSync(tmp,after,{mode:0o600,flag:'wx'});renameSync(tmp,codexFile);chmodSync(codexFile,0o600);}
const afterClaude=JSON.parse(readFileSync(claudeFile)),afterCodex=JSON.parse(run('codex',['mcp','list','--json']));
for(const [name,value] of Object.entries(beforeClaude.mcpServers||{}))if(!isDeepStrictEqual(afterClaude.mcpServers[name],value))throw new Error('Unrelated Claude server changed');
for(const value of beforeCodex.filter(x=>x.name!=='fcpi'))if(!isDeepStrictEqual(afterCodex.find(x=>x.name===value.name),value))throw new Error('Unrelated Codex server changed');
const result={utc:new Date().toISOString(),test_id:'M9-GLOBAL-INSTALL',status:'CONFIGURED_PENDING_LIVE',private_endpoint:true,authentication:'macOS login keychain via native HTTP header helpers',existing_claude_servers_preserved:Object.keys(beforeClaude.mcpServers||{}).filter(x=>x!=='fcpi').length,existing_codex_servers_preserved:beforeCodex.filter(x=>x.name!=='fcpi').length,versions:{claude:run('claude',['--version']).trim(),codex:run('codex',['--version']).trim()},helper_sha256:createHash('sha256').update(readFileSync(helper)).digest('hex'),hosted_profiles_enabled:false,verification_note:'Initial string comparison rejected nondeterministic CLI map ordering; semantic comparison and idempotent configuration verification pass. CLI helper redaction is compared against the private TOML value.'};
mkdirSync(join(root,'evidence/M9/clients'),{recursive:true});writeFileSync(join(root,'evidence/M9/clients/global-install.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
