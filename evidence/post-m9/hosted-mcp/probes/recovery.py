import subprocess,json,pathlib,urllib.request,time,datetime

def emit(label, **data):
 print(json.dumps({'label':label,'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),**data}),flush=True)

def health(label):
 for attempt in range(26):
  pid=subprocess.check_output(['systemctl','show','fcpi-openai-tunnel','-p','MainPID','--value'],text=True).strip()
  r=subprocess.run(['/opt/fcpi-tunnel/v0.0.15/tunnel-client','health','--port','3382','--json','--require-control-plane-poll','--pid',pid],capture_output=True,text=True)
  data=json.loads(r.stdout)
  if r.returncode==0:
   emit(label,exit_code=0,health=data,wait_attempts=attempt);return
  if attempt<25:time.sleep(2)
 emit(label,exit_code=r.returncode,health=data)
 raise RuntimeError('Runtime health recovery deadline')

def catalog(label):
 auth=pathlib.Path('/etc/firecrawl-pi/hosted-mcp/openai-mcp-auth').read_text().strip()
 meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{'name':'fcpi-tunnel-recovery','version':'1'}}
 body=json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/list','params':{'_meta':meta}}).encode()
 q=urllib.request.Request('http://127.0.0.1:3380/mcp',data=body,headers={'Authorization':auth,'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','MCP-Method':'tools/list'})
 with urllib.request.urlopen(q,timeout=10) as r:
  a=json.loads(r.read());count=len(a.get('result',{}).get('tools',[]));session=r.headers.get('mcp-session-id')
  emit(label,status=r.status,tools=count,session=session,request_id=r.headers.get('x-request-id'),principal='chatgpt-tunnel',hosted_product_invocation=False)
  if count!=13 or session is not None:raise RuntimeError('Authenticated catalog failed')

def started(service):
 return subprocess.check_output(['docker','inspect','-f','{{.State.StartedAt}}','fcpi-'+service+'-1'],text=True).strip()

try:
 gateway=started('access-gateway');mcp=started('mcp-gateway')
 health('before-tunnel-restart');catalog('before-catalog')
 subprocess.run(['systemctl','restart','fcpi-openai-tunnel'],check=True)
 time.sleep(3);health('after-tunnel-restart');catalog('after-catalog')
 try:
  subprocess.run(['docker','stop','-t','10','fcpi-mcp-gateway-1'],check=True,stdout=subprocess.DEVNULL)
  health('mcp-down-tunnel-still-polling')
  auth=pathlib.Path('/etc/firecrawl-pi/hosted-mcp/openai-mcp-auth').read_text().strip()
  q=urllib.request.Request('http://127.0.0.1:3380/platform/v1/status',headers={'Authorization':auth})
  with urllib.request.urlopen(q,timeout=5) as r:emit('private-rest-while-mcp-down',status=r.status)
 finally:
  subprocess.run(['docker','start','fcpi-mcp-gateway-1'],check=True,stdout=subprocess.DEVNULL)
 for i in range(60):
  if subprocess.check_output(['docker','inspect','-f','{{.State.Health.Status}}','fcpi-mcp-gateway-1'],text=True).strip()=='healthy':break
  time.sleep(1)
 else:raise RuntimeError('MCP health recovery deadline')
 health('after-mcp-return');catalog('after-mcp-return-catalog')
 emit('identities',mcp_start_changed=mcp!=started('mcp-gateway'),gateway_start_unchanged=gateway==started('access-gateway'))
 emit('end',state='PASS')
except Exception as e:
 emit('end',state='FAIL',error=str(e));raise
