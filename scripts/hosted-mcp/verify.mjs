// Post-acceptance proof only. Never overwrites M9 evidence or calls a model API.
import {execFileSync, spawn} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync, renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {Resolver} from 'node:dns/promises';
import {connect} from 'node:net';

const base='evidence/post-m9/hosted-mcp/';
const conf=Object.fromEntries(readFileSync('scripts/m1/pi-target.conf','utf8').split('\n').filter(x=>x.startsWith('PI_')).map(x=>{const i=x.indexOf('=');return[x.slice(0,i),x.slice(i+1).replace('$HOME',process.env.HOME)];}));
const ssh=['-i',conf.PI_SSH_KEY,'-o','IdentitiesOnly=yes','-o','BatchMode=yes',conf.PI_SSH_TARGET];
const pi=command=>execFileSync('ssh',[...ssh,command],{encoding:'utf8',stdio:['pipe','pipe','pipe']});
const config=JSON.parse(pi('cat /etc/firecrawl-pi/hosted-mcp/claude.json'));
const token=pi('sudo -n cat /etc/firecrawl-pi/secrets/clients/clauderemote.token').trim();
if(createHash('sha256').update(token).digest('hex')!==config.token_sha256)throw Error('Credential/config mismatch');
const modern='2026-07-28';
const meta={'io.modelcontextprotocol/protocolVersion':modern,'io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'fcpi-hosted-verifier',version:'1'}};
const records=[];
let publicIP=null;
const publicMode=process.argv.includes('--external');
let tunnel, tunnelCompletion, transportFailure=null, deployedCommit=null;
const preflight=[];
async function listening(port){return new Promise(r=>{const s=connect(port,'127.0.0.1');s.on('connect',()=>{s.destroy();r(true);});s.on('error',()=>r(false));});}
async function openTransport(){
 if(publicMode){
  const dns=new Resolver();dns.setServers(['1.1.1.1']);
  const addresses=await dns.resolve4(config.host.split(':')[0]);
  for(const address of addresses){
   if(/^(?:10\.|127\.|192\.168\.|100\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(address))throw Error('External test resolved a private address');
   publicIP=address;
   try{const r=await raw({path:'/',auth:null});preflight.push({destination_sha256:createHash('sha256').update(address).digest('hex'),status:r.status,tls:r.tls});if(r.status===404&&r.tls===true)return;}
   catch(e){preflight.push({destination_sha256:createHash('sha256').update(address).digest('hex'),error:e.code??e.name});}
  }
  throw Error('No public TLS endpoint passed preflight');
 }
 if(await listening(18381)||await listening(18380))throw Error('Verification forward port already occupied');
 tunnel=spawn('ssh',[...ssh.slice(0,-1),'-N','-o','ExitOnForwardFailure=yes','-L','127.0.0.1:18381:127.0.0.1:3381','-L','127.0.0.1:18380:127.0.0.1:3380',conf.PI_SSH_TARGET],{stdio:'ignore'});
 tunnelCompletion=new Promise(r=>{tunnel.once('close',r);tunnel.once('error',r);});
 tunnel.on('error',e=>{transportFailure=e.code??e.name;});
 tunnel.on('exit',(code,signal)=>{transportFailure=`SSH exited ${code??signal}`;});
 for(let i=0;i<40;i++){
  if(transportFailure)throw Error(transportFailure);
  if(await listening(18381)&&await listening(18380))return;
  await new Promise(r=>setTimeout(r,100));
 }
 throw Error('SSH readiness deadline');
}
function raw({path='/mcp',auth=token,host=config.host.replace(/:443$/,''),headers={},body,privateRest=false}={}){
 return new Promise((resolve,reject)=>{
  const bytes=body===undefined?null:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  const req=(publicMode?httpsRequest:httpRequest)({hostname:publicMode?config.host.split(':')[0]:'127.0.0.1',port:publicMode?443:privateRest?18380:18381,path,method:bytes?'POST':'GET',agent:false,
   ...(publicMode?{lookup:(_h,opts,cb)=>opts.all?cb(null,[{address:publicIP,family:4}]):cb(null,publicIP,4)}:{}),
   headers:{host:privateRest?'127.0.0.1:3380':host,accept:'application/json, text/event-stream',...(auth?{authorization:'Bearer '+auth}:{}),...(bytes?{'content-type':'application/json','content-length':bytes.length}:{}),...headers}},res=>{
    let text='';res.on('data',x=>{text+=x;if(text.length>8388608)req.destroy(Error('response cap'));});res.on('error',reject);res.on('end',()=>{
     let message;try{message=JSON.parse(text);}catch{const data=text.split('\n').filter(x=>x.startsWith('data: ')).at(-1);if(data){try{message=JSON.parse(data.slice(6));}catch{reject(Error('Malformed SSE response'));return;}}}
     resolve({status:res.statusCode,message,request_id:res.headers['x-request-id']??null,session:res.headers['mcp-session-id']??null,tls:res.socket?.authorized??null});
    });
   });
  req.setTimeout(publicMode&&path==='/'?10000:150000,()=>req.destroy(Error('request deadline')));req.on('error',reject);req.end(bytes);
 });
}
const rpc=(method,params={},opts={})=>raw({...opts,headers:{'mcp-protocol-version':modern,'mcp-method':method,...(method==='tools/call'?{'mcp-name':params.name}:{}),...(opts.headers??{})},body:{jsonrpc:'2.0',id:1,method,params:{...params,_meta:meta}}});
function check(id,pass,evidence){records.push({id,state:pass?'PASS':'FAIL',...evidence});console.log(JSON.stringify({check:id,state:pass?'PASS':'FAIL'}));}
try{
 deployedCommit=pi('cat /opt/firecrawl-pi/.fcpi-source-commit').trim();
 await openTransport();
 for(const path of ['/','/health','/v2/scrape','/admin','/platform/v1/artifacts/x','/random','/mcp/','/mcp?url=https://example.com']){const r=await raw({path,auth:null});check('route:'+path,r.status===404,{status:r.status});}
 let r=await raw({auth:null});check('missing-auth',r.status===401||r.status===429,{status:r.status});
 for(let i=0;i<31;i++)r=await raw({auth:'synthetic-invalid-hosted-credential'});
 check('bad-auth-throttle',r.status===429,{status:r.status});
 r=await rpc('tools/list',{}, {host:config.host});check('explicit-default-port',r.status===200,{status:r.status});
 r=await rpc('tools/list');check('modern-catalog',r.status===200&&r.message?.result?.tools?.length>0&&!r.session,{status:r.status,tools:r.message?.result?.tools?.map(t=>t.name),request_id:r.request_id,session:r.session});
 try{r=await rpc('tools/list',{}, {host:'rebind.example'});check('host',r.status===421,{status:r.status});}catch(e){if(!publicMode||e.code!=='ECONNRESET')throw e;check('host',true,{status:null,public_relay_rejected_host:e.code,loopback_expected_status:421});}
 r=await rpc('tools/list',{}, {headers:{origin:'https://evil.example'}});check('origin',r.status===403,{status:r.status});
 r=await raw({body:'x'.repeat(1048577)});check('body-cap',r.status===413,{status:r.status});
 r=await raw({body:{jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fcpi-hosted-legacy',version:'1'}}}});check('legacy-initialize',r.status===200&&r.message?.result?.protocolVersion==='2025-11-25'&&!r.session,{status:r.status,protocol:r.message?.result?.protocolVersion,session:r.session});
 r=await raw({headers:{'mcp-protocol-version':'2025-11-25'},body:{jsonrpc:'2.0',id:3,method:'tools/list',params:{}}});check('legacy-new-connection',r.status===200&&r.message?.result?.tools?.length>0&&!r.session,{status:r.status,session:r.session});
 r=await rpc('tools/call',{name:'firecrawl_scrape',arguments:{url:'http://m1.fixture.fcpi.test:8080/static.html',formats:['markdown'],maxAge:0}});
 let payload;try{payload=JSON.parse(r.message?.result?.content?.[0]?.text??'{}');}catch{}
 check('controlled-scrape',r.status===200&&!r.message?.result?.isError&&/^(?:# Static fixture(?:\r?\n|$)|Static fixture\r?\n=+(?:\r?\n|$))/.test(payload?.data?.markdown??''),{status:r.status,is_error:r.message?.result?.isError??false,expected_heading:'Static fixture',markdown_sha256:payload?.data?.markdown?createHash('sha256').update(payload.data.markdown).digest('hex'):null,request_id:r.request_id});
 r=await rpc('tools/call',{name:'firecrawl_scrape',arguments:{url:'http://metadata.google.internal/',formats:['markdown']}});check('ssrf',r.message?.result?.isError===true&&JSON.stringify(r.message.result).includes('SSRF_DENIED'),{status:r.status,is_error:r.message?.result?.isError??false,expected_class:'SSRF_DENIED',observed_error:r.message?.result?.content?.[0]?.text??null});
 r=await rpc('tools/call',{name:'firecrawl_scrape',arguments:{url:'https://api.firecrawl.dev/',formats:['markdown']}});check('cloud-destination-denial',r.message?.result?.isError===true&&JSON.stringify(r.message.result).includes('CLOUD_DENIED'),{status:r.status,is_error:r.message?.result?.isError??false,expected_class:'CLOUD_DENIED',observed_error:r.message?.result?.content?.[0]?.text??null});
 if(!publicMode){r=await raw({privateRest:true,path:'/platform/v1/status',auth:pi('sudo -n cat /etc/firecrawl-pi/secrets/clients/m9codex.token').trim()});check('private-rest',r.status===200,{status:r.status});}
}catch(e){check('transport-or-response',false,{error:e.code??e.message});
}finally{
 if(tunnel&&tunnel.pid&&tunnel.exitCode===null&&tunnel.signalCode===null){tunnel.kill();await Promise.race([tunnelCompletion,new Promise(r=>setTimeout(r,2000))]);if(tunnel.exitCode===null&&tunnel.signalCode===null)tunnel.kill('SIGKILL');}
 const out={schema:'fcpi.hosted-mcp-proof/v1',utc:new Date().toISOString(),source_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),deployed_commit:deployedCommit,vantage:publicMode?'public DNS and forced public destination, bypassing Tailnet resolution':'SSH loopback forward',hosted_product_invocation:false,public_destination_sha256:publicIP?createHash('sha256').update(publicIP).digest('hex'):null,public_preflight:preflight,principal:'claude-remote',token_sha256:config.token_sha256,records,state:records.every(x=>x.state==='PASS')?'PASS':'FAIL'};
 const output=base+(publicMode?'external-tests.json':'loopback-tests.json');if(existsSync(output))renameSync(output,output.replace('.json',`-${Date.now()}.json`));writeFileSync(output,JSON.stringify(out,null,2)+'\n');
 console.log(JSON.stringify({state:out.state,checks:records.length,failed:records.filter(x=>x.state==='FAIL')}));process.exitCode=out.state==='PASS'?0:1;
}

