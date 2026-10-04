import subprocess,json,time,pathlib,datetime
units=['fcpi-hosted-mcp.service','fcpi-openai-tunnel.service','tailscaled.service']
def show(unit,fields):
 text=subprocess.check_output(['systemctl','show',unit]+['-p'+f for f in fields],text=True)
 return dict(line.split('=',1) for line in text.splitlines() if '=' in line)
for index in range(13):
 row={'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'monotonic':time.monotonic(),'deployed_commit':pathlib.Path('/opt/firecrawl-pi/.fcpi-source-commit').read_text().strip(),'units':{u:show(u,['MemoryCurrent','MemoryPeak','CPUUsageNSec','MainPID','ActiveState','NRestarts']) for u in units},'slice':show('fcpi.slice',['MemoryHigh','MemoryCurrent']),'mem_available_kib':int(next(x for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:')).split()[1]),'oom_kill':int(next(x for x in pathlib.Path('/proc/vmstat').read_text().splitlines() if x.startswith('oom_kill ')).split()[1]),'throttle':subprocess.check_output(['vcgencmd','get_throttled'],text=True).strip()}
 print(json.dumps(row),flush=True)
 if index<12:time.sleep(5)
